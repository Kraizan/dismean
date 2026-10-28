#!/usr/bin/env python3
"""SIGKILL every worker while tasks are in flight, three times; the job must still finish with the exact mean."""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from e2e import DATA_DIR, http  # noqa: E402

API_URL = os.environ.get("API_URL", "http://localhost:3000").rstrip("/")

# Fast CI runners can finish the default job before we observe unacked tasks; escalate until we get kills.
CHAOS_SIZES = [(300, 200_000), (800, 200_000), (400, 400_000)]


def worker_pids() -> list[int]:
    try:
        out = subprocess.check_output(["pgrep", "-f", "dismean_worker.worker"], text=True)
    except subprocess.CalledProcessError:
        return []
    return [int(x) for x in out.split()]


def in_flight() -> int:
    with urllib.request.urlopen(f"{API_URL}/stats", timeout=5) as resp:
        return json.loads(resp.read())["queue"]["tasks_unacked"]


def delete_job(job_id: str) -> None:
    req = urllib.request.Request(f"{API_URL}/jobs/{job_id}", method="DELETE")
    urllib.request.urlopen(req, timeout=30)


def kill_rounds(job_id: str, max_rounds: int = 3, window_s: float = 60) -> int:
    kills = 0
    deadline = time.monotonic() + window_s
    while kills < max_rounds and time.monotonic() < deadline:
        status = http("GET", f"/jobs/{job_id}")["status"]
        if status not in ("GENERATING", "REDUCING"):
            break
        pids = worker_pids()
        if pids and in_flight() > 0:
            for pid in pids:
                os.kill(pid, signal.SIGKILL)
            kills += 1
            print(f"round {kills}: killed {len(pids)} workers with tasks in flight ({status})")
            time.sleep(1.5)
        else:
            time.sleep(0.05)
    return kills


def wait_completed(job_id: str, timeout_s: float = 120) -> dict | None:
    steps = int(timeout_s / 0.5)
    for _ in range(steps):
        job = http("GET", f"/jobs/{job_id}")
        if job["status"] == "COMPLETED":
            return job
        if job["status"] in ("FAILED", "CANCELLED"):
            print(json.dumps(job, indent=2), file=sys.stderr)
            return None
        time.sleep(0.5)
    print("timeout after chaos", file=sys.stderr)
    return None


def verify_mean(job_id: str, f: int, c: int) -> bool:
    sums = np.zeros(c, dtype=np.int64)
    for i in range(f):
        sums += np.load(DATA_DIR / f"jobs/{job_id}/inputs/{i:06d}.npy")
    if not np.array_equal(np.load(DATA_DIR / f"jobs/{job_id}/result.npy"), sums / f):
        print("result mismatch after chaos", file=sys.stderr)
        return False
    return True


def run_once(f: int, c: int) -> int | None:
    """Return kill count on success path setup, None if no in-flight kills (retry with larger job)."""
    print(f"==> chaos recovery (f={f}, c={c}, 3 kill rounds)")
    job_id = http("POST", "/jobs", {"f": f, "c": c})["id"]
    kills = kill_rounds(job_id)
    if kills == 0:
        try:
            delete_job(job_id)
        except OSError:
            pass
        return None
    if wait_completed(job_id) is None:
        try:
            delete_job(job_id)
        except OSError:
            pass
        return -1
    if not verify_mean(job_id, f, c):
        try:
            delete_job(job_id)
        except OSError:
            pass
        return -1
    delete_job(job_id)
    print(f"ok completed with exact mean after {kills} kill rounds")
    return kills


def main() -> int:
    if not worker_pids():
        print("no workers running", file=sys.stderr)
        return 1
    for f, c in CHAOS_SIZES:
        result = run_once(f, c)
        if result is None:
            continue
        if result == -1:
            return 1
        return 0
    print(
        "never caught a task in flight; job too small for this machine",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

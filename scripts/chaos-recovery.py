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


def worker_pids() -> list[int]:
    try:
        out = subprocess.check_output(["pgrep", "-f", "dismean_worker.worker"], text=True)
    except subprocess.CalledProcessError:
        return []
    return [int(x) for x in out.split()]


def in_flight() -> int:
    with urllib.request.urlopen(f"{API_URL}/stats", timeout=5) as resp:
        return json.loads(resp.read())["queue"]["tasks_unacked"]


def main() -> int:
    if not worker_pids():
        print("no workers running", file=sys.stderr)
        return 1
    f, c = 300, 200_000
    print(f"==> chaos recovery (f={f}, c={c}, 3 kill rounds)")
    job_id = http("POST", "/jobs", {"f": f, "c": c})["id"]

    kills = 0
    deadline = time.monotonic() + 60
    while kills < 3 and time.monotonic() < deadline:
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
    if kills == 0:
        print("never caught a task in flight; job too small for this machine", file=sys.stderr)
        return 1

    for i in range(240):
        job = http("GET", f"/jobs/{job_id}")
        if job["status"] == "COMPLETED":
            break
        if job["status"] in ("FAILED", "CANCELLED"):
            print(json.dumps(job, indent=2), file=sys.stderr)
            return 1
        time.sleep(0.5)
    else:
        print("timeout after chaos", file=sys.stderr)
        return 1

    sums = np.zeros(c, dtype=np.int64)
    for i in range(f):
        sums += np.load(DATA_DIR / f"jobs/{job_id}/inputs/{i:06d}.npy")
    if not np.array_equal(np.load(DATA_DIR / f"jobs/{job_id}/result.npy"), sums / f):
        print("result mismatch after chaos", file=sys.stderr)
        return 1
    req = urllib.request.Request(f"{API_URL}/jobs/{job_id}", method="DELETE")
    urllib.request.urlopen(req, timeout=30)
    print(f"ok completed with exact mean after {kills} kill rounds")
    return 0


if __name__ == "__main__":
    sys.exit(main())

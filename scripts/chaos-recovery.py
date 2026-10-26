#!/usr/bin/env python3
"""Kill a worker mid-job; supervisor should restart and job should still complete."""
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from e2e import http  # noqa: E402


def worker_pids() -> list[int]:
    out = subprocess.check_output(["pgrep", "-f", "dismean_worker.worker"], text=True)
    return [int(x) for x in out.strip().splitlines() if x.strip()]


def main() -> int:
    if not worker_pids():
        print("no workers running", file=sys.stderr)
        return 1
    print("==> chaos recovery")
    job = http("POST", "/jobs", {"f": 24, "c": 6})
    job_id = job["id"]
    time.sleep(1.0)
    pids = worker_pids()
    victim = pids[0]
    print(f"killing worker pid={victim}")
    os.kill(victim, signal.SIGKILL)
    for i in range(180):
        j = http("GET", f"/jobs/{job_id}")
        if j["status"] == "COMPLETED":
            print(f"completed after chaos in ~{i}s")
            return 0
        if j["status"] == "FAILED":
            print(j, file=sys.stderr)
            return 1
        time.sleep(1)
    print("timeout", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

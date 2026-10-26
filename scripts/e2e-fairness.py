#!/usr/bin/env python3
"""Small job overtakes large backlog (ITD-034). See docs/code-map.md · LLD §7."""
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from e2e import API_URL, http  # noqa: E402


def wait(job_id: str, timeout_s: float = 180) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        job = http("GET", f"/jobs/{job_id}")
        if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            return job
        time.sleep(0.25)
    raise AssertionError(f"timeout waiting for {job_id}")


def main() -> int:
    print("==> fairness: large job A, then small job B")
    big = http("POST", "/jobs", {"f": 2000, "c": 20_000})["id"]
    time.sleep(0.3)
    small = http("POST", "/jobs", {"f": 10, "c": 5})["id"]

    b = wait(small)
    a_status_when_b_done = http("GET", f"/jobs/{big}")["status"]
    a = wait(big)

    for j in (a, b):
        if j["status"] != "COMPLETED":
            print("job did not complete:", j["id"], j["status"], file=sys.stderr)
            return 1
    if a_status_when_b_done == "COMPLETED":
        print("small job did not overtake the large one", file=sys.stderr)
        return 1
    print(
        f"ok small job finished in {b['timings_ms']['total']} ms "
        f"while large job was {a_status_when_b_done}; large took {a['timings_ms']['total']} ms"
    )
    for jid in (big, small):
        urllib.request.urlopen(urllib.request.Request(f"{API_URL}/jobs/{jid}", method="DELETE"), timeout=30)
    return 0


if __name__ == "__main__":
    sys.exit(main())

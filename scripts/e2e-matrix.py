#!/usr/bin/env python3
"""Run e2e for several f values (generation + reduction edge sizes)."""
import os
import sys

# Reuse e2e helpers
sys.path.insert(0, os.path.dirname(__file__))
from e2e import API_URL, DATA_DIR, http  # noqa: E402

CASES = [(2, 3), (3, 5), (7, 4), (12, 5), (23, 8)]


def main() -> int:
    print("==> e2e matrix", CASES)
    http("GET", "/health")
    for f, c in CASES:
        job = http("POST", "/jobs", {"file_count": f, "values_per_file": c})
        job_id = job["id"]
        for _ in range(180):
            j = http("GET", f"/jobs/{job_id}")
            if j["status"] == "COMPLETED":
                print(f"ok f={f} c={c} job={job_id}")
                break
            if j["status"] == "FAILED":
                print(f"FAIL f={f} c={c}", j, file=sys.stderr)
                return 1
            import time

            time.sleep(0.5)
        else:
            print(f"timeout f={f} c={c}", file=sys.stderr)
            return 1
    print("==> e2e matrix passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""E2E test without curl (works when shell curl is redirected)."""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
API_URL = os.environ.get("API_URL", "http://localhost:3000").rstrip("/")


def http(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_URL}{path}"
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("==> health")
    print(http("GET", "/health"))

    print("==> create job f=12 c=5")
    job = http("POST", "/jobs", {"f": 12, "c": 5})
    job_id = job["id"]
    print(f"job_id={job_id}")

    print("==> wait for COMPLETED (max 120s)")
    status = ""
    for i in range(1, 121):
        job = http("GET", f"/jobs/{job_id}")
        status = job["status"]
        if status == "COMPLETED":
            print(f"completed in {i}s")
            break
        if status == "FAILED":
            print(json.dumps(job, indent=2))
            sys.exit(1)
        time.sleep(1)
    if status != "COMPLETED":
        print(f"timeout status={status}")
        sys.exit(1)

    print("==> verify result vs seeded numpy")
    f, c = job["f"], job["c"]
    sums = np.zeros(c, dtype=np.int64)
    for i in range(f):
        p = DATA_DIR / f"jobs/{job_id}/inputs/{i:06d}.npy"
        arr = np.load(p)
        sums += arr.astype(np.int64)
    expected = sums / f
    result = np.load(DATA_DIR / f"jobs/{job_id}/result.npy")
    if not np.allclose(result, expected):
        print("mismatch", result[:5], expected[:5])
        sys.exit(1)
    print("ok mean matches seeded inputs")
    print("==> e2e passed")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print(f"HTTP error: {e}", file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""E2E test without curl (works when shell curl is redirected)."""
import io
import json
import os
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


def http_bytes(path: str) -> bytes:
    with urllib.request.urlopen(f"{API_URL}{path}", timeout=30) as resp:
        return resp.read()


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
    if not np.array_equal(result, expected):
        print("mismatch", result[:5], expected[:5])
        sys.exit(1)
    print("ok mean matches seeded inputs bit-for-bit")

    print("==> verify HTTP downloads (result.csv, result.npy, inputs/0.csv)")
    csv_text = http_bytes(f"/jobs/{job_id}/result.csv").decode().strip()
    csv_vals = [float(x) for x in csv_text.split(",")]
    if len(csv_vals) != c or not np.allclose(csv_vals, expected, atol=1e-7):
        print("result.csv mismatch", csv_vals, expected)
        sys.exit(1)

    npy_bytes = http_bytes(f"/jobs/{job_id}/result.npy")
    dl_npy = np.load(io.BytesIO(npy_bytes))
    if not np.array_equal(dl_npy, expected):
        print("result.npy HTTP mismatch")
        sys.exit(1)

    inp0_csv = http_bytes(f"/jobs/{job_id}/inputs/0.csv").decode().strip()
    inp0_vals = [int(x) for x in inp0_csv.split(",")]
    inp0_disk = np.load(DATA_DIR / f"jobs/{job_id}/inputs/000000.npy").tolist()
    if inp0_vals != inp0_disk:
        print("inputs/0.csv mismatch", inp0_vals, inp0_disk)
        sys.exit(1)

    tasks_resp = http("GET", f"/jobs/{job_id}/tasks")
    if len(tasks_resp.get("tasks", [])) != 6:
        print("expected 6 tasks (3 GENERATE + 3 MERGE), got", len(tasks_resp.get("tasks", [])))
        sys.exit(1)

    graph_resp = http("GET", f"/jobs/{job_id}/task-graph")
    if len(graph_resp.get("tasks", [])) != 6 or len(graph_resp.get("edges", [])) == 0:
        print("unexpected task-graph", graph_resp)
        sys.exit(1)
    non_final = next(
        t for t in graph_resp["tasks"] if t["kind"] == "MERGE" and not t["is_final"]
    )
    partial_csv = http_bytes(f"/jobs/{job_id}/partials/{non_final['id']}.csv").decode().strip()
    if len(partial_csv.split(",")) != c:
        print("partial csv mismatch", partial_csv)
        sys.exit(1)

    print("==> e2e passed")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print(f"HTTP error: {e}", file=sys.stderr)
        sys.exit(1)

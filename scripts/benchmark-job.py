#!/usr/bin/env python3
"""ITD-027 wall-clock benchmark (optional). Default f=500; set BENCHMARK_F=20000 for full spec."""
import json
import os
import sys
import time
import urllib.request

API_URL = os.environ.get("API_URL", "http://localhost:3000").rstrip("/")
F = int(os.environ.get("BENCHMARK_F", "500"))
C = int(os.environ.get("BENCHMARK_C", "10"))
W = int(os.environ.get("BENCHMARK_W", "8"))


def post(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(f"{API_URL}{path}", data=data, headers=headers, method="POST" if body else "GET")
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read().decode())


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{API_URL}{path}", timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    print(f"benchmark f={F} c={C} (workers W={W} assumed running)")
    t0 = time.perf_counter()
    job = post("/jobs", {"f": F, "c": C})
    job_id = job["id"]
    for _ in range(3600):
        j = get(f"/jobs/{job_id}")
        if j["status"] == "COMPLETED":
            elapsed = time.perf_counter() - t0
            tasks = j.get("tasks") or {}
            done = int(tasks.get("done", 0))
            cps = done / elapsed if elapsed > 0 else 0
            print(f"completed in {elapsed:.1f}s tasks_done={done} ~{cps:.1f} completions/s")
            return 0
        if j["status"] in ("FAILED", "CANCELLED"):
            print(json.dumps(j, indent=2), file=sys.stderr)
            return 1
        time.sleep(0.5)
    print("timeout", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

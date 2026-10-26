#!/usr/bin/env python3
"""Dynamic W via GET/PUT /fleet. See docs/code-map.md · LLD §9–10."""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("API_URL", "http://localhost:3000").rstrip("/")


def request(method: str, path: str, body: dict | None = None, expect_status: int | None = None):
    url = f"{API_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            raw = resp.read()
            payload = json.loads(raw.decode()) if raw else {}
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read() if e.fp else b""
        payload = json.loads(raw.decode()) if raw else {}
        if expect_status is not None and status != expect_status:
            raise AssertionError(f"expected {expect_status} got {status}: {payload}") from e
        return status, payload
    if expect_status is not None and status != expect_status:
        raise AssertionError(f"expected {expect_status} got {status}")
    return status, payload


def wait_for_workers(target: int, timeout_s: float = 20.0) -> int:
    deadline = time.monotonic() + timeout_s
    last_live = -1
    while time.monotonic() < deadline:
        _, stats = request("GET", "/stats", expect_status=200)
        w = stats["workers"]
        live = w["total"] - w["dead"]
        last_live = live
        if live == target and w["desired"] == target:
            return live
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for live workers={target} (last={last_live})")


def main() -> int:
    print("==> fleet validation")
    request("PUT", "/fleet", {"desired_workers": 0}, expect_status=400)
    request("PUT", "/fleet", {"desired_workers": 33}, expect_status=400)

    _, initial = request("GET", "/fleet", expect_status=200)
    orig_w = initial["desired_workers"]
    print(f"initial desired_workers={orig_w}")

    try:
        print("==> scale up to W=6")
        request("PUT", "/fleet", {"desired_workers": 6}, expect_status=200)
        wait_for_workers(6)
        print("ok scaled up to 6 live workers")

        print("==> scale down to W=2 (graceful SIGTERM drain)")
        request("PUT", "/fleet", {"desired_workers": 2}, expect_status=200)
        wait_for_workers(2)
        print("ok scaled down to 2 live workers")

        print("==> run job at W=2")
        _, job = request("POST", "/jobs", {"f": 10, "c": 4}, expect_status=201)
        job_id = job["id"]
        for _ in range(60):
            _, j = request("GET", f"/jobs/{job_id}", expect_status=200)
            if j["status"] == "COMPLETED":
                break
            time.sleep(0.5)
        else:
            raise AssertionError("job did not complete at W=2")
    finally:
        print("==> restore W=4")
        request("PUT", "/fleet", {"desired_workers": 4}, expect_status=200)
        wait_for_workers(4)

    print("==> e2e-fleet passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

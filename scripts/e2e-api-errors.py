#!/usr/bin/env python3
"""HTTP API validation and cancel flow."""
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
            payload = json.loads(resp.read().decode()) if resp.length != 0 else {}
    except urllib.error.HTTPError as e:
        status = e.code
        payload = json.loads(e.read().decode()) if e.fp else {}
        if expect_status is not None and status != expect_status:
            raise
        return status, payload
    if expect_status is not None and status != expect_status:
        raise AssertionError(f"expected {expect_status} got {status}")
    return status, payload


def main() -> int:
    print("==> api errors")
    status, _ = request("POST", "/jobs", {"f": 1, "c": 5}, expect_status=400)
    assert status == 400
    status, _ = request("POST", "/jobs", {"f": 10, "c": 1}, expect_status=400)
    assert status == 400

    print("==> cancel flow")
    _, job = request("POST", "/jobs", {"f": 500, "c": 10})
    job_id = job["id"]
    request("POST", f"/jobs/{job_id}/cancel")
    j = {"status": ""}
    for _ in range(30):
        _, j = request("GET", f"/jobs/{job_id}")
        if j["status"] in ("CANCELLED", "FAILED", "COMPLETED"):
            break
        time.sleep(0.2)
    if j["status"] != "CANCELLED":
        print("expected cancelled/failed got", j["status"], file=sys.stderr)
        return 1
    print("==> e2e-api-errors passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

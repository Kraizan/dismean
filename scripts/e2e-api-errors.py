#!/usr/bin/env python3
"""HTTP API validation, non-UUID 404s, cancel, and delete flow."""
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


def main() -> int:
    print("==> api errors & 404s")
    request("POST", "/jobs", {"f": 1, "c": 5}, expect_status=400)
    request("POST", "/jobs", {"f": 10, "c": 1}, expect_status=400)
    request("GET", "/jobs/not-a-uuid", expect_status=404)
    request("GET", "/jobs/not-a-uuid/task-graph", expect_status=404)
    request("GET", "/jobs/00000000-0000-4000-8000-000000000000/task-graph", expect_status=404)
    request("POST", "/jobs/not-a-uuid/cancel", expect_status=404)
    request("DELETE", "/jobs/not-a-uuid", expect_status=404)
    request("GET", "/jobs/00000000-0000-4000-8000-000000000000", expect_status=404)

    print("==> cancel + delete flow")
    _, job = request("POST", "/jobs", {"f": 500, "c": 10}, expect_status=201)
    job_id = job["id"]
    request("POST", f"/jobs/{job_id}/cancel", expect_status=202)
    j = {"status": ""}
    for _ in range(30):
        _, j = request("GET", f"/jobs/{job_id}", expect_status=200)
        if j["status"] in ("CANCELLED", "FAILED", "COMPLETED"):
            break
        time.sleep(0.2)
    if j["status"] != "CANCELLED":
        print("expected CANCELLED got", j["status"], file=sys.stderr)
        return 1

    # Cancelling again returns 409
    request("POST", f"/jobs/{job_id}/cancel", expect_status=409)

    # Deleting cancelled job returns 204, then 404 on GET
    request("DELETE", f"/jobs/{job_id}", expect_status=204)
    request("GET", f"/jobs/{job_id}", expect_status=404)

    print("==> cleanup endpoint")
    request("POST", "/cleanup", expect_status=200)
    request("POST", "/cleanup?force=true", expect_status=200)
    request("POST", "/fleet/prune-dead", expect_status=200)

    print("==> e2e-api-errors passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

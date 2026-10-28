#!/usr/bin/env python3
"""Restart RabbitMQ: the API and workers must exit, come back through their restart loops, and run jobs again (ITD-005)."""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from e2e import API_URL, http  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def healthy() -> bool:
    try:
        with urllib.request.urlopen(f"{API_URL}/health", timeout=2) as resp:
            return json.loads(resp.read()) == {"db": "ok", "amqp": "ok"}
    except (urllib.error.URLError, OSError, ValueError):
        return False


def live_workers() -> int:
    stats = http("GET", "/stats")
    return stats["workers"]["total"] - stats["workers"]["dead"]


def main() -> int:
    target = http("GET", "/fleet")["desired_workers"]
    print("==> restart rabbitmq")
    subprocess.run(
        ["docker", "compose", "-f", str(ROOT / "docker-compose.yml"), "restart", "rabbitmq"],
        check=True,
        capture_output=True,
    )

    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if healthy():
            try:
                if live_workers() >= target:
                    break
            except (urllib.error.URLError, OSError):
                pass
        time.sleep(1)
    else:
        print("API or workers did not recover after broker restart", file=sys.stderr)
        return 1
    print("ok API healthy and workers reconnected")

    job_id = http("POST", "/jobs", {"f": 12, "c": 5})["id"]
    for _ in range(120):
        job = http("GET", f"/jobs/{job_id}")
        if job["status"] == "COMPLETED":
            print("ok job completed after broker restart")
            return 0
        if job["status"] in ("FAILED", "CANCELLED"):
            print(job, file=sys.stderr)
            return 1
        time.sleep(0.5)
    print("job did not complete after broker restart", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

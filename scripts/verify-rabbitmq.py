#!/usr/bin/env python3
"""Smoke-check RabbitMQ assumptions from docs/open-questions.md (V-1–V-4)."""
import base64
import json
import os
import sys
import urllib.request
from urllib.parse import urlparse

MGMT = os.environ.get("RABBITMQ_MGMT_URL", "http://guest:guest@localhost:15672").rstrip("/")


def _mgmt_base_and_auth() -> tuple[str, str | None]:
    parsed = urlparse(MGMT)
    host = parsed.hostname or "localhost"
    port = parsed.port or 15672
    auth = None
    if parsed.username is not None:
        user = parsed.username
        password = parsed.password or ""
        token = base64.b64encode(f"{user}:{password}".encode()).decode("ascii")
        auth = f"Basic {token}"
    return f"http://{host}:{port}", auth


def get_queue(name: str) -> dict:
    base, auth = _mgmt_base_and_auth()
    url = f"{base}/api/queues/%2F/{name}"
    req = urllib.request.Request(url)
    if auth:
        req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    errors: list[str] = []
    tasks = get_queue("dm.tasks")
    coord = get_queue("dm.coordinator")
    dead = get_queue("dm.tasks.dead")
    args = tasks.get("arguments") or {}

    # V-2: per-queue consumer timeout
    timeout = args.get("x-consumer-timeout")
    if timeout != 900000:
        errors.append(f"V-2: expected x-consumer-timeout=900000 on dm.tasks, got {timeout!r}")

    # V-3: coordinator uses large delivery limit (not -1; import rejected on 4.x image)
    climit = (coord.get("arguments") or {}).get("x-delivery-limit")
    if climit != 1000000:
        errors.append(f"V-3: expected coordinator x-delivery-limit=1000000, got {climit!r}")

    # V-4: DLX wiring present
    if args.get("x-dead-letter-exchange") != "dm.dlx":
        errors.append("V-4: dm.tasks missing x-dead-letter-exchange=dm.dlx")
    if dead.get("name") != "dm.tasks.dead":
        errors.append("V-4: dm.tasks.dead queue missing")

    # V-1: quorum task queue (priority is message property; 2:1 ratio is runtime — not asserted here)
    if args.get("x-queue-type") != "quorum":
        errors.append("V-1: dm.tasks is not a quorum queue")

    if errors:
        for e in errors:
            print(f"FAIL {e}", file=sys.stderr)
        return 1

    print(
        "ok RabbitMQ: quorum dm.tasks, consumer-timeout 900000, "
        "coordinator delivery-limit 1000000, DLX -> dm.tasks.dead"
    )
    print("note V-1 (2:1 priority delivery) assumed per ITD-020 on RabbitMQ 4.x quorum queues")
    return 0


if __name__ == "__main__":
    sys.exit(main())

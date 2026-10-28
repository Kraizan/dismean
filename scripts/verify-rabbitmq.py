#!/usr/bin/env python3
"""Verify RabbitMQ assumptions documented in ITD-003, ITD-005, ITD-007, ITD-011 (see docs/open-questions.md)."""
import base64
import json
import os
import sys
import urllib.request
from urllib.parse import urlparse

import pika

MGMT = os.environ.get("RABBITMQ_MGMT_URL", "http://guest:guest@localhost:15672").rstrip("/")
AMQP_URL = os.environ.get("AMQP_URL", "amqp://guest:guest@localhost:5672/")


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


def verify_dispatch_signals() -> list[str]:
    """V-5: a passive declare on a quorum queue reports ready messages and live consumers (ITD-003)."""
    errors: list[str] = []
    conn = pika.BlockingConnection(pika.URLParameters(AMQP_URL))
    try:
        ch = conn.channel()
        # The relay waits for confirms before its next depth check; unconfirmed publishes may not be counted yet.
        ch.confirm_delivery()
        q = "dm.verify.v5.dispatch"
        ch.queue_delete(queue=q)
        ch.queue_declare(queue=q, durable=True, arguments={"x-queue-type": "quorum"})
        for i in range(3):
            ch.basic_publish("", q, f"m{i}".encode(), pika.BasicProperties(delivery_mode=2))
        ready = ch.queue_declare(queue=q, passive=True).method.message_count
        if ready != 3:
            errors.append(f"V-5: expected message_count=3, got {ready}")

        consumer_conn = pika.BlockingConnection(pika.URLParameters(AMQP_URL))
        try:
            tags = []
            for _ in range(2):
                cch = consumer_conn.channel()
                cch.basic_qos(prefetch_count=1)
                tags.append(cch.basic_consume(q, lambda *_: None, auto_ack=False))
            consumer_conn.process_data_events(time_limit=0.5)
            consumers = ch.queue_declare(queue=q, passive=True).method.consumer_count
            if consumers != 2:
                errors.append(f"V-5: expected consumer_count=2, got {consumers}")
        finally:
            consumer_conn.close()
        ch.queue_delete(queue=q)
    finally:
        conn.close()
    return errors


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

    if args.get("x-queue-type") != "quorum":
        errors.append("dm.tasks is not a quorum queue")
    errors.extend(verify_dispatch_signals())

    if errors:
        for e in errors:
            print(f"FAIL {e}", file=sys.stderr)
        return 1

    print(
        "ok RabbitMQ: consumer-timeout 900000 (V-2), coordinator delivery-limit 1000000 (V-3), "
        "DLX -> dm.tasks.dead (V-4), passive declare reports depth + consumers (V-5)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

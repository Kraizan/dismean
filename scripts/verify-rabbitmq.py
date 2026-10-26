#!/usr/bin/env python3
"""Verify RabbitMQ assumptions from docs/open-questions.md (V-1–V-4)."""
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


def verify_quorum_priority() -> list[str]:
    """V-1: Verify high-priority (9) messages preempt normal (0) on a RabbitMQ 4 quorum queue."""
    errors: list[str] = []
    conn = pika.BlockingConnection(pika.URLParameters(AMQP_URL))
    try:
        ch = conn.channel()
        q = "dm.verify.v1.priority"
        try:
            ch.queue_delete(queue=q)
        except Exception:
            ch = conn.channel()
        ch.queue_declare(queue=q, durable=True, arguments={"x-queue-type": "quorum"})
        for i in range(6):
            ch.basic_publish(
                "",
                q,
                f"L{i}".encode(),
                pika.BasicProperties(priority=0, delivery_mode=2),
            )
        for i in range(6):
            ch.basic_publish(
                "",
                q,
                f"H{i}".encode(),
                pika.BasicProperties(priority=9, delivery_mode=2),
            )
        ch.basic_qos(prefetch_count=1)
        out: list[str] = []
        for method, _props, body in ch.consume(q, inactivity_timeout=2.0):
            if method is None:
                break
            out.append(body.decode())
            ch.basic_ack(method.delivery_tag)
            if len(out) == 12:
                break
        ch.cancel()
        ch.queue_delete(queue=q)

        if len(out) != 12:
            errors.append(f"V-1: expected 12 messages from quorum queue, got {len(out)}")
        else:
            # First 6 deliveries must prioritize high-priority messages over normal backlog
            high_in_first_half = sum(1 for m in out[:6] if m.startswith("H"))
            if high_in_first_half < 4:
                errors.append(
                    f"V-1: quorum priority did not preempt normal messages (order={out})"
                )
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

    # V-1: quorum task queue + runtime priority preemption test
    if args.get("x-queue-type") != "quorum":
        errors.append("V-1: dm.tasks is not a quorum queue")
    else:
        errors.extend(verify_quorum_priority())

    if errors:
        for e in errors:
            print(f"FAIL {e}", file=sys.stderr)
        return 1

    print(
        "ok RabbitMQ V-1..V-4: quorum priority preemption verified, consumer-timeout 900000, "
        "coordinator delivery-limit 1000000, DLX -> dm.tasks.dead"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

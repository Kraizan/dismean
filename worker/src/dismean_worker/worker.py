from __future__ import annotations

import json
import logging
import os
import signal
import socket
import sys
import time
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import pika
from pika.adapters.blocking_connection import BlockingChannel
from pika.spec import Basic, BasicProperties

from . import config
from .messages import (
    GenerateTaskMessage,
    MergeTaskMessage,
    TaskFailedMessage,
    validate_job_stopped,
    validate_task_message,
)
from .tasks import run_task

LOG = logging.getLogger(__name__)

EXCHANGE_TASKS = "dm.tasks"
EXCHANGE_EVENTS = "dm.events"
EXCHANGE_CONTROL = "dm.control"
QUEUE_TASKS = "dm.tasks"
RK_TASK = "task"
RK_COMPLETED = "task.completed"
RK_FAILED = "task.failed"
RK_HEARTBEAT = "worker.heartbeat"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _worker_id() -> str:
    host = socket.gethostname()
    return f"{host}-{config.WORKER_INDEX}-{os.getpid()}"


@dataclass
class WorkerRuntime:
    worker_id: str
    hostname: str
    pid: int
    started_at: str
    state: str = "IDLE"
    tasks_done: int = 0
    current_task_id: str | None = None
    current_job_id: str | None = None
    current_task_kind: str | None = None
    draining: bool = False
    stopped_jobs: set[str] = field(default_factory=set)
    channel: BlockingChannel | None = None
    connection: pika.BlockingConnection | None = None
    tasks_consumer_tag: str | None = None
    executor: ThreadPoolExecutor | None = None
    heartbeat_handle: Any = None
    pending_future: Future[Any] | None = None


def _publish_json(
    ch: BlockingChannel,
    exchange: str,
    routing_key: str,
    body: dict[str, Any],
) -> None:
    props = BasicProperties(
        content_type="application/json",
        delivery_mode=2,
    )
    ch.basic_publish(
        exchange,
        routing_key,
        json.dumps(body).encode("utf-8"),
        properties=props,
        mandatory=False,
    )


def _send_heartbeat(rt: WorkerRuntime) -> None:
    ch = rt.channel
    conn = rt.connection
    if ch is None or conn is None or not conn.is_open:
        return
    body = {
        "schema_version": 1,
        "worker_id": rt.worker_id,
        "hostname": rt.hostname,
        "pid": rt.pid,
        "state": rt.state,
        "task_id": rt.current_task_id,
        "job_id": rt.current_job_id,
        "task_kind": rt.current_task_kind,
        "tasks_done": rt.tasks_done,
        "started_at": rt.started_at,
        "sent_at": _utc_now(),
    }
    try:
        _publish_json(ch, EXCHANGE_EVENTS, RK_HEARTBEAT, body)
    except Exception:
        LOG.exception("heartbeat publish failed")
        sys.exit(1)
    rt.heartbeat_handle = conn.call_later(config.HEARTBEAT_INTERVAL_S, lambda: _send_heartbeat(rt))


def _check_topology(ch: BlockingChannel) -> None:
    try:
        ch.exchange_declare(EXCHANGE_TASKS, passive=True)
        ch.queue_declare(QUEUE_TASKS, passive=True)
        ch.exchange_declare(EXCHANGE_EVENTS, passive=True)
        ch.exchange_declare(EXCHANGE_CONTROL, passive=True)
    except pika.exceptions.ChannelClosedByBroker as exc:
        LOG.error("topology not loaded: %s", exc)
        sys.exit(1)


def _connect() -> pika.BlockingConnection:
    delay = 1.0
    while True:
        try:
            params = pika.URLParameters(config.AMQP_URL)
            params.heartbeat = config.AMQP_HEARTBEAT_S
            return pika.BlockingConnection(params)
        except pika.exceptions.AMQPConnectionError:
            LOG.warning("broker unreachable, retrying in %.0fs", delay)
            time.sleep(delay)
            delay = min(delay * 2, 30.0)


def _task_failed_body(
    rt: WorkerRuntime,
    task_id: str,
    job_id: str,
    attempt: int,
    kind: str,
    exc: BaseException,
) -> TaskFailedMessage:
    return {
        "schema_version": 1,
        "task_id": task_id,
        "job_id": job_id,
        "attempt": attempt,
        "kind": kind,  # type: ignore[typeddict-item]
        "worker_id": rt.worker_id,
        "error": {"type": type(exc).__name__, "message": str(exc)},
    }


def _on_task_done(
    rt: WorkerRuntime,
    delivery_tag: int,
    msg: GenerateTaskMessage | MergeTaskMessage,
    started: float,
    result: dict[str, Any] | None,
    error: BaseException | None,
) -> None:
    ch = rt.channel
    if ch is None:
        sys.exit(1)
    duration_ms = int((time.monotonic() - started) * 1000)
    try:
        if error is not None:
            body = _task_failed_body(
                rt,
                msg["task_id"],
                msg["job_id"],
                msg["attempt"],
                msg["kind"],
                error,
            )
            _publish_json(ch, EXCHANGE_EVENTS, RK_FAILED, body)
        else:
            body = {
                "schema_version": 1,
                "task_id": msg["task_id"],
                "job_id": msg["job_id"],
                "attempt": msg["attempt"],
                "kind": msg["kind"],
                "worker_id": rt.worker_id,
                "duration_ms": duration_ms,
                "output": result,
            }
            _publish_json(ch, EXCHANGE_EVENTS, RK_COMPLETED, body)
            rt.tasks_done += 1
    except Exception:
        LOG.exception("event publish failed")
        sys.exit(1)

    ch.basic_ack(delivery_tag)
    rt.state = "IDLE"
    rt.current_task_id = None
    rt.current_job_id = None
    rt.current_task_kind = None
    rt.pending_future = None

    if rt.draining:
        rt.state = "STOPPED"
        _send_heartbeat(rt)
        conn = rt.connection
        if conn and conn.is_open:
            conn.close()
        sys.exit(0)


def _submit_task(
    rt: WorkerRuntime,
    delivery_tag: int,
    msg: GenerateTaskMessage | MergeTaskMessage,
) -> None:
    started = time.monotonic()
    executor = rt.executor
    conn = rt.connection
    if executor is None or conn is None:
        sys.exit(1)

    def _work() -> dict[str, Any]:
        return run_task(msg)

    future = executor.submit(_work)

    def _done(fut: Future[Any]) -> None:
        result: dict[str, Any] | None = None
        error: BaseException | None = None
        try:
            result = fut.result()
        except BaseException as exc:  # noqa: BLE001 — report any task failure
            error = exc
        _on_task_done(rt, delivery_tag, msg, started, result, error)

    rt.pending_future = future
    future.add_done_callback(lambda f: conn.add_callback_threadsafe(lambda: _done(f)))


def _on_task(
    rt: WorkerRuntime,
    ch: BlockingChannel,
    method: Basic.Deliver,
    _props: BasicProperties,
    body: bytes,
) -> None:
    delivery_tag = method.delivery_tag
    try:
        raw = json.loads(body)
    except json.JSONDecodeError as exc:
        LOG.error("invalid JSON task body: %s", exc)
        ch.basic_ack(delivery_tag)
        return

    try:
        msg = validate_task_message(raw)
    except ValueError as exc:
        LOG.error("invalid task message: %s", exc)
        task_id = raw.get("task_id") if isinstance(raw, dict) else None
        job_id = raw.get("job_id") if isinstance(raw, dict) else None
        raw_attempt = raw.get("attempt", 1) if isinstance(raw, dict) else 1
        attempt = raw_attempt if isinstance(raw_attempt, int) and not isinstance(raw_attempt, bool) and raw_attempt >= 1 else 1
        raw_kind = raw.get("kind") if isinstance(raw, dict) else None
        kind = raw_kind if raw_kind in ("GENERATE", "MERGE") else "GENERATE"
        if isinstance(task_id, str) and task_id and isinstance(job_id, str) and job_id:
            try:
                failed = _task_failed_body(
                    rt,
                    task_id,
                    job_id,
                    attempt,
                    kind,
                    exc,
                )
                _publish_json(ch, EXCHANGE_EVENTS, RK_FAILED, failed)
            except Exception:
                LOG.exception("could not publish failure for invalid task")
        ch.basic_ack(delivery_tag)
        return

    if msg["job_id"] in rt.stopped_jobs:
        ch.basic_ack(delivery_tag)
        return

    rt.state = "BUSY"
    rt.current_task_id = msg["task_id"]
    rt.current_job_id = msg["job_id"]
    rt.current_task_kind = msg["kind"]
    _submit_task(rt, delivery_tag, msg)


def _on_control(
    rt: WorkerRuntime,
    _ch: BlockingChannel,
    _method: Basic.Deliver,
    _props: BasicProperties,
    body: bytes,
) -> None:
    try:
        raw = json.loads(body)
        stopped = validate_job_stopped(raw)
        rt.stopped_jobs.add(stopped["job_id"])
    except Exception:
        LOG.exception("invalid control message")


def _begin_drain(rt: WorkerRuntime) -> None:
    if rt.draining:
        return
    rt.draining = True
    rt.state = "STOPPING"
    ch = rt.channel
    if ch and rt.tasks_consumer_tag:
        ch.basic_cancel(rt.tasks_consumer_tag)
    if rt.pending_future is None:
        rt.state = "STOPPED"
        _send_heartbeat(rt)
        conn = rt.connection
        if conn and conn.is_open:
            conn.close()
        sys.exit(0)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    rt = WorkerRuntime(
        worker_id=_worker_id(),
        hostname=socket.gethostname(),
        pid=os.getpid(),
        started_at=_utc_now(),
        stopped_jobs=set(),
    )

    def _sigterm(_signum: int, _frame: Any) -> None:
        _begin_drain(rt)

    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGINT, _sigterm)

    conn = _connect()
    rt.connection = conn
    ch = conn.channel()
    rt.channel = ch
    ch.confirm_delivery()
    ch.basic_qos(prefetch_count=1)
    _check_topology(ch)

    result = ch.queue_declare(queue="", exclusive=True, auto_delete=True)
    control_queue = result.method.queue
    ch.queue_bind(exchange=EXCHANGE_CONTROL, queue=control_queue)
    ch.basic_consume(
        control_queue,
        on_message_callback=lambda c, m, p, b: _on_control(rt, c, m, p, b),
        auto_ack=True,
    )

    rt.tasks_consumer_tag = ch.basic_consume(
        QUEUE_TASKS,
        on_message_callback=lambda c, m, p, b: _on_task(rt, c, m, p, b),
        auto_ack=False,
    )

    rt.executor = ThreadPoolExecutor(max_workers=1)
    _send_heartbeat(rt)

    LOG.info("worker %s started", rt.worker_id)
    try:
        ch.start_consuming()
    except (pika.exceptions.AMQPConnectionError, pika.exceptions.AMQPChannelError):
        LOG.error("broker error after startup:\n%s", traceback.format_exc())
        sys.exit(1)
    except KeyboardInterrupt:
        _begin_drain(rt)


if __name__ == "__main__":
    main()

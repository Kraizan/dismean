import os
from pathlib import Path


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing required env var {name}")
    return value


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return int(raw)


AMQP_URL = os.environ.get("AMQP_URL", "amqp://guest:guest@localhost:5672")
WORKER_INDEX = _int("WORKER_INDEX", 0)
HEARTBEAT_INTERVAL_S = _int("HEARTBEAT_INTERVAL_S", 2)
AMQP_HEARTBEAT_S = _int("AMQP_HEARTBEAT_S", 10)

WORKER_COUNT = _int("WORKER_COUNT", 4)
DRAIN_TIMEOUT_S = _int("DRAIN_TIMEOUT_S", 900)

MAX_FILES_PER_TASK = 5


def get_data_dir() -> Path:
    return Path(_require("DATA_DIR"))

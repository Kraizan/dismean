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


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return float(raw)


AMQP_URL = os.environ.get("AMQP_URL", "amqp://guest:guest@localhost:5672")
API_URL = os.environ.get("API_URL", "http://localhost:3000").rstrip("/")
WORKER_INDEX = _int("WORKER_INDEX", 0)
HEARTBEAT_INTERVAL_S = _int("HEARTBEAT_INTERVAL_S", 2)
AMQP_HEARTBEAT_S = _int("AMQP_HEARTBEAT_S", 10)

WORKER_COUNT = _int("WORKER_COUNT", 4)
FLEET_POLL_INTERVAL_S = _float("FLEET_POLL_INTERVAL_S", 1.5)
DRAIN_TIMEOUT_S = _int("DRAIN_TIMEOUT_S", 900)

MAX_FILES_PER_TASK = 5


def get_data_dir() -> Path:
    return Path(_require("DATA_DIR"))

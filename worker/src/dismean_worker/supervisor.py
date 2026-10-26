from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field

from . import config

LOG = logging.getLogger(__name__)


@dataclass
class Slot:
    index: int
    process: subprocess.Popen[bytes] | None = None
    backoff_s: float = 1.0
    next_spawn_at: float = 0.0
    draining: bool = False


def _poll_desired_workers(api_url: str) -> int | None:
    try:
        with urllib.request.urlopen(f"{api_url}/fleet", timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        val = data.get("desired_workers")
        if isinstance(val, int) and not isinstance(val, bool) and 1 <= val <= 32:
            return val
    except Exception:
        return None
    return None


@dataclass
class Supervisor:
    worker_count: int
    slots: dict[int, Slot] = field(default_factory=dict)
    shutting_down: bool = False
    last_fleet_poll: float = 0.0

    def __post_init__(self) -> None:
        self.slots = {i: Slot(index=i) for i in range(self.worker_count)}

    def _spawn(self, slot: Slot) -> None:
        env = os.environ.copy()
        env["WORKER_INDEX"] = str(slot.index)
        slot.draining = False
        slot.process = subprocess.Popen(
            [sys.executable, "-m", "dismean_worker.worker"],
            env=env,
        )
        LOG.info("spawned worker index %s pid %s", slot.index, slot.process.pid)

    def _reconcile_target(self) -> None:
        now = time.monotonic()
        if now - self.last_fleet_poll < config.FLEET_POLL_INTERVAL_S:
            return
        self.last_fleet_poll = now
        desired = _poll_desired_workers(config.API_URL)
        if desired is None or desired == self.worker_count:
            return
        LOG.info("reconciling worker_count %s -> %s", self.worker_count, desired)
        self.worker_count = desired

        for idx in range(desired):
            slot = self.slots.get(idx)
            if slot is None:
                self.slots[idx] = Slot(index=idx)

        for idx, slot in list(self.slots.items()):
            if idx >= desired:
                proc = slot.process
                if proc is None:
                    del self.slots[idx]
                elif not slot.draining and proc.poll() is None:
                    slot.draining = True
                    LOG.info("draining worker index %s pid %s", slot.index, proc.pid)
                    proc.send_signal(signal.SIGTERM)

    def _reap(self) -> None:
        now = time.monotonic()
        for idx, slot in list(self.slots.items()):
            proc = slot.process
            if proc is None:
                if idx >= self.worker_count:
                    del self.slots[idx]
                continue
            code = proc.poll()
            if code is None:
                continue
            LOG.warning("worker index %s exited with code %s", slot.index, code)
            slot.process = None
            slot.draining = False
            if self.shutting_down or idx >= self.worker_count:
                if idx >= self.worker_count:
                    del self.slots[idx]
                continue
            if code != 0:
                slot.next_spawn_at = now + slot.backoff_s
                slot.backoff_s = min(slot.backoff_s * 2, 30.0)
            else:
                slot.backoff_s = 1.0
                slot.next_spawn_at = now

    def _ensure_running(self) -> None:
        now = time.monotonic()
        for idx, slot in list(self.slots.items()):
            if idx >= self.worker_count:
                continue
            if (
                slot.process is None
                and not self.shutting_down
                and now >= slot.next_spawn_at
            ):
                self._spawn(slot)

    def _forward_sigterm(self) -> None:
        self.shutting_down = True
        for slot in self.slots.values():
            proc = slot.process
            if proc is not None and proc.poll() is None:
                proc.send_signal(signal.SIGTERM)

    def _wait_drain(self) -> None:
        deadline = time.monotonic() + config.DRAIN_TIMEOUT_S
        while time.monotonic() < deadline:
            alive = [s.process for s in self.slots.values() if s.process and s.process.poll() is None]
            if not alive:
                return
            time.sleep(0.5)
        for slot in self.slots.values():
            proc = slot.process
            if proc is not None and proc.poll() is None:
                LOG.error("killing worker index %s after drain timeout", slot.index)
                proc.kill()

    def run(self) -> None:
        def _on_signal(_signum: int, _frame: object) -> None:
            self._forward_sigterm()

        signal.signal(signal.SIGTERM, _on_signal)
        signal.signal(signal.SIGINT, _on_signal)

        self._reconcile_target()
        self._ensure_running()
        while not self.shutting_down:
            self._reconcile_target()
            self._reap()
            self._ensure_running()
            time.sleep(0.5)

        self._wait_drain()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    Supervisor(worker_count=config.WORKER_COUNT).run()


if __name__ == "__main__":
    main()

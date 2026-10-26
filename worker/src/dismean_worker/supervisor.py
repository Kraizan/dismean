from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field

from . import config

LOG = logging.getLogger(__name__)


@dataclass
class Slot:
    index: int
    process: subprocess.Popen[bytes] | None = None
    backoff_s: float = 1.0


@dataclass
class Supervisor:
    worker_count: int
    slots: list[Slot] = field(default_factory=list)
    shutting_down: bool = False

    def __post_init__(self) -> None:
        self.slots = [Slot(index=i) for i in range(self.worker_count)]

    def _spawn(self, slot: Slot) -> None:
        env = os.environ.copy()
        env["WORKER_INDEX"] = str(slot.index)
        slot.process = subprocess.Popen(
            [sys.executable, "-m", "dismean_worker.worker"],
            env=env,
        )
        LOG.info("spawned worker index %s pid %s", slot.index, slot.process.pid)

    def _reap(self) -> None:
        for slot in self.slots:
            proc = slot.process
            if proc is None:
                continue
            code = proc.poll()
            if code is None:
                continue
            LOG.warning("worker index %s exited with code %s", slot.index, code)
            slot.process = None
            if self.shutting_down:
                continue
            if code != 0:
                time.sleep(slot.backoff_s)
                slot.backoff_s = min(slot.backoff_s * 2, 30.0)
            else:
                slot.backoff_s = 1.0
            self._spawn(slot)

    def _ensure_running(self) -> None:
        for slot in self.slots:
            if slot.process is None and not self.shutting_down:
                self._spawn(slot)

    def _forward_sigterm(self) -> None:
        self.shutting_down = True
        for slot in self.slots:
            proc = slot.process
            if proc is not None and proc.poll() is None:
                proc.send_signal(signal.SIGTERM)

    def _wait_drain(self) -> None:
        deadline = time.monotonic() + config.DRAIN_TIMEOUT_S
        while time.monotonic() < deadline:
            alive = [s.process for s in self.slots if s.process and s.process.poll() is None]
            if not alive:
                return
            time.sleep(0.5)
        for slot in self.slots:
            proc = slot.process
            if proc is not None and proc.poll() is None:
                LOG.error("killing worker index %s after drain timeout", slot.index)
                proc.kill()

    def run(self) -> None:
        def _on_signal(_signum: int, _frame: object) -> None:
            self._forward_sigterm()

        signal.signal(signal.SIGTERM, _on_signal)
        signal.signal(signal.SIGINT, _on_signal)

        self._ensure_running()
        while not self.shutting_down:
            self._reap()
            self._ensure_running()
            time.sleep(1.0)

        self._wait_drain()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    Supervisor(worker_count=config.WORKER_COUNT).run()


if __name__ == "__main__":
    main()

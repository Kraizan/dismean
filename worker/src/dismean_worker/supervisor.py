"""Reconcile worker processes to GET /fleet. See docs/code-map.md · LLD §9."""
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
from typing import Any

from . import config

LOG = logging.getLogger(__name__)


@dataclass
class Slot:
    index: int
    process: subprocess.Popen[bytes] | None = None
    backoff_s: float = 1.0
    next_spawn_at: float = 0.0
    spawned_at: float = 0.0
    retiring: bool = False


HEALTHY_RUN_S = 60.0


def _fetch_fleet(api_url: str) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"{api_url}/fleet", timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    val = data.get("desired_workers")
    if isinstance(val, int) and not isinstance(val, bool) and 1 <= val <= 32:
        return data
    return None


def _idle_pids(fleet: dict[str, Any]) -> set[int]:
    workers = fleet.get("workers") or {}
    return {
        w["pid"]
        for w in workers.get("list") or []
        if isinstance(w, dict) and w.get("state") == "IDLE" and isinstance(w.get("pid"), int)
    }


@dataclass
class Supervisor:
    """Keeps `target` non-retiring workers alive. W is per supervisor (ITD-032)."""

    target: int
    slots: list[Slot] = field(default_factory=list)
    shutting_down: bool = False
    last_fleet_poll: float = 0.0

    def _active(self) -> list[Slot]:
        return [s for s in self.slots if not s.retiring]

    def _free_index(self) -> int:
        used = {s.index for s in self.slots}
        i = 0
        while i in used:
            i += 1
        return i

    def _spawn(self, slot: Slot) -> None:
        env = os.environ.copy()
        env["WORKER_INDEX"] = str(slot.index)
        slot.process = subprocess.Popen([sys.executable, "-m", "dismean_worker.worker"], env=env)
        slot.spawned_at = time.monotonic()
        LOG.info("spawned worker index %s pid %s", slot.index, slot.process.pid)

    def _retire(self, slot: Slot) -> None:
        slot.retiring = True
        proc = slot.process
        if proc is not None and proc.poll() is None:
            LOG.info("draining worker index %s pid %s", slot.index, proc.pid)
            proc.send_signal(signal.SIGTERM)

    def reconcile(self, desired: int, idle_pids: set[int]) -> None:
        self.target = desired
        active = self._active()
        while len(active) < desired:
            slot = Slot(index=self._free_index())
            self.slots.append(slot)
            active.append(slot)
        excess = len(active) - desired
        if excess <= 0:
            return
        # Idle workers first, then slots with no live process, then the newest busy ones.
        def drain_rank(s: Slot) -> tuple[int, int]:
            pid = s.process.pid if s.process else None
            if pid is not None and pid in idle_pids:
                return (0, -s.index)
            if s.process is None or s.process.poll() is not None:
                return (1, -s.index)
            return (2, -s.index)

        for slot in sorted(active, key=drain_rank)[:excess]:
            self._retire(slot)

    def _poll_fleet(self) -> None:
        now = time.monotonic()
        if now - self.last_fleet_poll < config.FLEET_POLL_INTERVAL_S:
            return
        self.last_fleet_poll = now
        fleet = _fetch_fleet(config.API_URL)
        if fleet is None:
            return
        desired = fleet["desired_workers"]
        if desired != len(self._active()):
            LOG.info("reconciling workers %s -> %s", len(self._active()), desired)
            self.reconcile(desired, _idle_pids(fleet))

    def _reap(self) -> None:
        now = time.monotonic()
        for slot in list(self.slots):
            proc = slot.process
            if proc is None:
                if slot.retiring:
                    self.slots.remove(slot)
                continue
            code = proc.poll()
            if code is None:
                continue
            LOG.warning("worker index %s exited with code %s", slot.index, code)
            slot.process = None
            if slot.retiring or self.shutting_down:
                if slot in self.slots and slot.retiring:
                    self.slots.remove(slot)
                continue
            if now - slot.spawned_at >= HEALTHY_RUN_S:
                slot.backoff_s = 1.0
            if code != 0:
                slot.next_spawn_at = now + slot.backoff_s
                slot.backoff_s = min(slot.backoff_s * 2, 30.0)
            else:
                slot.backoff_s = 1.0
                slot.next_spawn_at = now

    def _ensure_running(self) -> None:
        now = time.monotonic()
        for slot in self._active():
            if slot.process is None and not self.shutting_down and now >= slot.next_spawn_at:
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
            if not any(s.process and s.process.poll() is None for s in self.slots):
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

        self.reconcile(self.target, set())
        self._poll_fleet()
        while not self.shutting_down:
            self._poll_fleet()
            self._reap()
            self._ensure_running()
            time.sleep(0.5)

        self._wait_drain()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    Supervisor(target=config.WORKER_COUNT).run()


if __name__ == "__main__":
    main()

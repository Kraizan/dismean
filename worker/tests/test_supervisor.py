from __future__ import annotations

import signal

from dismean_worker.supervisor import Slot, Supervisor


class FakeProc:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.signals: list[int] = []
        self.code: int | None = None

    def poll(self) -> int | None:
        return self.code

    def send_signal(self, sig: int) -> None:
        self.signals.append(sig)


def _supervisor_with(pids: list[int]) -> tuple[Supervisor, dict[int, FakeProc]]:
    sup = Supervisor(target=len(pids))
    procs = {pid: FakeProc(pid) for pid in pids}
    sup.slots = [Slot(index=i, process=procs[pid]) for i, pid in enumerate(pids)]  # type: ignore[arg-type]
    return sup, procs


def test_scale_down_drains_idle_workers_first() -> None:
    sup, procs = _supervisor_with([100, 101, 102, 103])
    sup.reconcile(2, idle_pids={101, 103})
    assert procs[101].signals == [signal.SIGTERM]
    assert procs[103].signals == [signal.SIGTERM]
    assert procs[100].signals == [] and procs[102].signals == []
    assert len([s for s in sup.slots if not s.retiring]) == 2


def test_scale_down_with_no_idle_workers_drains_newest() -> None:
    sup, procs = _supervisor_with([100, 101, 102])
    sup.reconcile(1, idle_pids=set())
    assert procs[102].signals == [signal.SIGTERM]
    assert procs[101].signals == [signal.SIGTERM]
    assert procs[100].signals == []


def test_scale_up_adds_slots_with_free_indexes() -> None:
    sup, _ = _supervisor_with([100, 101])
    sup.slots[0].retiring = True
    sup.reconcile(3, idle_pids=set())
    active = [s for s in sup.slots if not s.retiring]
    assert len(active) == 3
    assert sorted(s.index for s in sup.slots) == [0, 1, 2, 3]

from dismean_worker.worker import STOPPED_JOBS_MAX, WorkerRuntime, _remember_stopped_job


def test_stopped_jobs_set_is_bounded() -> None:
    rt = WorkerRuntime(
        worker_id="w-0",
        hostname="host",
        pid=1,
        started_at="2026-01-01T00:00:00Z",
    )
    for i in range(STOPPED_JOBS_MAX + 50):
        _remember_stopped_job(rt, f"job-{i}")
    assert len(rt.stopped_jobs) == STOPPED_JOBS_MAX
    assert f"job-{STOPPED_JOBS_MAX + 49}" in rt.stopped_jobs
    assert "job-0" not in rt.stopped_jobs

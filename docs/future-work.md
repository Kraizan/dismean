# Future work

Designed but not built. Each entry says when to build it and how.

## 1. Fair-share dispatcher (Built — ITD-034, IPD-016)
- Built into the outbox relay (`api/src/relay/index.ts`). Possible next steps: weight rounds by C, and replace the window query with a per-job lateral `LIMIT` if the ITD-027 benchmark shows it is slow.

## 2. Per-level priority (Obsolete)
- The dispatcher already runs deeper merges first within a job, without broker priorities.

## 3. Coordinator scale-out
**When:** the benchmark (ITD-027) shows workers waiting on the coordinator, or the single point of failure matters. Options, cheapest first:
1. **Batch:** up to N messages or 20 ms per transaction, acked with `multiple=true`. On failure, replay one at a time (ITD-022 rules apply).
2. **Shard by `job_id`:** a consistent-hash exchange in front of K coordinator queues, one coordinator each. Each job is still handled serially by one instance.
3. **Workers write the DB themselves:** this breaks invariant 1, so it needs a user-approved ITD.

## 4. Configurable W through the API (Built — ITD-032, IPD-015)
- Built in `002_fleet.sql`, `api/src/routes/fleet.ts`, `worker/src/dismean_worker/supervisor.py`, and the UI fleet card.

## 5. Faster hang detection
**When:** about 15 minutes (ITD-008) is too slow.
1. **Progress watchdog (about 20 lines):** the task thread bumps a counter per file; if it stops moving for N seconds, the process exits. Slow workers aren't killed, because it measures progress rather than time.
2. **API reaper:** heartbeats carry `{task_id, attempt, progress}`. When they go stale, the reaper republishes with `attempt + 1` and a new token, and completions must match the token. Needed only for untrusted workers or with the dispatcher.

## 6. Backup copies of slow tasks
**When:** stragglers dominate job tails (IPD-012).
- Condition: the queue is empty, a worker is idle, and a task has been running longer than 2× the median for its kind.
- Republish one copy with the same `task_id`. The first completion wins (ITD-009). At most one backup per task.

## 7. Object storage
**When:** going beyond one machine.
- Swap the storage modules for S3-compatible ones (MinIO locally, S3 or GCS in production). A `PUT` is already atomic. Lifecycle rules replace partial cleanup.

## 8. Disk budget
**When:** full disks become a problem (IPD-002).
- At `POST /jobs`, estimate `f·c + (M−1)·8c` and return `413` if it exceeds `DISK_BUDGET_BYTES` minus current usage.

## 9. Artificial worker slowdown
**When:** a demo needs visible speed differences (IPD-009).
- A `WORKER_SPEED_FACTOR` per worker, random in [0.5, 3] when unset. Each file sleeps `(50 + C/10,000) ms × factor`, ±20%.
- The factor is shown in heartbeats and the UI.

## 10. Eager tail merges
**When:** job tails need shortening.
- Also merge 2–4 ready items when the queue is empty and a worker is idle. Saves up to about one merge per job, at the cost of extra tasks and the coordinator depending on worker state.

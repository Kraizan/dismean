# Future work

Designed but not built. Each entry says when to build it and how.

## 1. Weighted fair share

**When:** equal tasks per active job is unfair when job sizes differ a lot.

- Weight round-robin rounds by job size (for example proportional to C) while still preferring deeper merges first within each job.

## 2. Coordinator scale-out

**When:** the benchmark shows workers waiting on the coordinator, or the single coordinator becomes an availability concern. Options, cheapest first:

1. **Batch:** apply up to N completion messages or 20 ms of work per database transaction, then ack in bulk. On failure, replay one message at a time (same error rules as today).
2. **Shard by job:** route each job’s completions to one of several coordinator consumers so a job is still serialized on one writer.
3. **Workers write the database:** breaks the “API-only writer” invariant; needs a new accepted ITD.

## 3. Faster hang detection

**When:** the fifteen-minute consumer timeout is too slow.

1. **Progress watchdog:** the worker task thread reports progress per file; if progress stops for N seconds, exit the process. Slow but healthy workers are not killed because the check is stall-based, not wall-clock.
2. **API reaper:** heartbeats carry task id, attempt, and progress; when they go stale, republish with a new attempt and require matching tokens on completion. Useful mainly for untrusted workers or with backup-task dispatch.

## 4. Backup copies of slow tasks

**When:** stragglers dominate job tails.

- When the queue is empty, a worker is idle, and a task has run longer than twice the median for its kind, republish one duplicate with the same task id. The first completion wins. At most one backup per task.

## 5. Object storage

**When:** running beyond one machine.

- Swap local file modules for S3-compatible storage (MinIO locally, cloud object storage in production). A single-object put is already atomic. Lifecycle rules replace partial cleanup jobs.

## 6. Disk budget

**When:** full disks become a problem (IPD-002).

- At job submit, estimate space from F, C, and merge depth; reject with HTTP 413 if the estimate exceeds a configured budget minus current usage.

## 7. Artificial worker slowdown

**When:** a demo needs visible speed differences (IPD-005).

- Optional per-worker speed factor (random in a bounded range when unset), applied as extra sleep per file, exposed in heartbeats and the UI.

## 8. Eager tail merges

**When:** job tails need shortening.

- Also merge two to four ready items when the queue is empty and a worker is idle, even if other merges for that job are still open. Saves up to about one merge per job at the cost of extra tasks and tighter coupling to live worker state.

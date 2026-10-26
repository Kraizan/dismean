# Important Technical Decisions (ITD)

Entries are never deleted; a superseded entry is kept as a stub. Statuses and decision authority are defined in [`AGENTS.md`](../../AGENTS.md#decision-authority).

### ITD-001: TypeScript API, Python workers
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** API in Node/Express/TypeScript; workers and supervisor in Python.
- **Why:** required by the spec. NumPy suits the numeric work. TypeScript everywhere was rejected.
- **Consequences:** types can't be shared across the two languages, so contracts are example files tested on both sides (ITD-025).

### ITD-002: RabbitMQ queue, Postgres state
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** RabbitMQ (with management plugin) for the queue; Postgres for job and task state.
- **Why:** acks, redelivery, quorum queues, dead-lettering and a stats API, all built in. Rejected: a Postgres-only queue (not a distinct queue component) and Redis Streams (atomicity needs Lua).
- **Consequences:** two stores mean a dual-write problem, solved by ITD-005.

### ITD-003: Plain FIFO task queue
**Status:** Superseded by ITD-020 · **Date:** 2026-10-23
- One FIFO queue for every task. Replaced because a job's late merges were stuck behind later jobs' work.

### ITD-004: The API coordinator is the only DB writer
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** workers publish `task.completed` / `task.failed`. One coordinator in the API applies each message in one transaction (locking the job row) and acks after commit. Workers use only RabbitMQ and the filesystem.
- **Why:** a single writer means no races, and workers stay trivial. Rejected: workers updating the DB themselves.
- **Consequences:** a throughput ceiling (ITD-027) and a single point of failure, which is restart-safe because state is in Postgres and unacked messages are redelivered. Scale-out: future-work §3.

### ITD-005: Transactional outbox
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** tasks are inserted as `CREATED` in the transaction that decides them. The relay publishes them on a confirm channel, then marks them `PUBLISHED`. It is signalled right after each commit and also polls as a fallback.
- **Why:** a crash between commit and publish would otherwise lose the task. Rejected: publish-then-sweep.
- **Consequences:** at-least-once delivery, so ITD-009 is required.

### ITD-006: Dynamic pool merge, fan-in 5, strict tail rule
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - Each job has a pool of `READY` items (inputs have count 1; partials count n).
  - Any 5 ready items become a MERGE.
  - The last 2–4 are merged only once no MERGE is open.
  - A merge whose input counts add up to F is final.
- **Why:** a merge never waits on a specific worker. Rejected: a static tree (slow workers block their parents), sticky accumulators (hard to recover), eager tail merges (more tasks).
- **Consequences:** M ≈ ⌈(F−1)/4⌉ merges; depth ≈ ⌈log₅ F⌉; exact completion detection.

### ITD-007: GENERATE tasks of 5 files, with an atomic barrier
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - A job starts with ⌈F/5⌉ GENERATE tasks.
  - Completions add to `jobs.generated_files`.
  - The completion that reaches F does all of this in one transaction: seed the pool, create the leaf merges, set `REDUCING`.
- **Why:** parallel generation in the same task model as merging. Rejected: the API generating files (a bottleneck), 1-file tasks (F messages), size-based batches.
- **Consequences:** an exact barrier. Idle time is at most one GENERATE task, and other jobs fill it (ITD-020).

### ITD-008: Liveness via RabbitMQ acks and consumer timeout
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - Manual ack after the result is confirmed, `prefetch=1`, AMQP heartbeat 10 s.
  - `x-consumer-timeout` of 15 min is the only hang detector.
  - Task work runs on its own thread so pika keeps heartbeating.
  - `worker.heartbeat` every 2 s is for display only.
- **Why:** time-based leases punish slow workers, and the broker already handles crashes. Rejected for now: a progress watchdog and an API reaper (future-work §5).
- **Consequences:** almost no code; a stuck worker is found after about 15 min. Relies on ITD-009.

### ITD-009: Idempotency
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  1. GENERATE seeds by `(jobs.seed, file_index)`; MERGE is deterministic anyway.
  2. Every write goes to a temp file, then `os.replace`.
  3. A completion applies only `WHERE id=$1 AND status IN ('CREATED','PUBLISHED')`. `CREATED` is included because a completion can arrive before the relay marks the task `PUBLISHED`; the relay's update is guarded `WHERE status='CREATED'`, so it never overwrites `DONE`. A completion from any attempt counts, and a failure counts only if its attempt is current.
- **Why:** redelivery and the outbox both cause duplicates, and double-counting would corrupt the mean. Rejected: attempt tokens (needed only with a reaper).
- **Consequences:** duplicates are harmless, and jobs are reproducible for tests.

### ITD-010: Retries and poison messages
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - **Task error:** the worker publishes `task.failed`. Under 3 attempts, the coordinator resets the task to `CREATED` with `attempt + 1`; at 3, the job fails.
  - **Crash loop:** quorum `x-delivery-limit=3` dead-letters the message to `dm.tasks.dead`, and the coordinator fails the job.
- **Why:** bounded retries with a clear failure reason. Rejected: fail fast; a limit set per job.
- **Consequences:** the worst case is 3 × 4 runs of one task. Acceptable.

### ITD-011: File formats and data types
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - Inputs `.npy uint8`.
  - Partials `.npy int64`, with the count kept in the DB.
  - Result `result.csv` (one line, `%.8f`) plus `result.npy` (`float64`).
  - The only float operation is `sum / F`.
- **Why:** values are 0–100, so `uint8` is 4× smaller than float32, and sums are exact (max ≈ 10⁷). Rejected: float inputs, CSV inputs, `.npz`.
- **Consequences:** switching to float values would need a new ITD.

### ITD-012: Shared local filesystem
**Status:** Accepted (delegated) · **Date:** 2026-10-23
- **Decision:** one `DATA_DIR` shared by the API and workers (layout in LLD §11).
- **Why:** zero setup on one machine. MinIO stays an option (future-work §7).
- **Consequences:** file access sits behind small storage modules, so it's swappable.

### ITD-013: Cancel by broadcast; coordinator ignores late results
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - Stopping a job (cancel or failure) marks the job and its open tasks.
  - After commit, the stopper publishes `job.stopped` on `dm.control`.
  - Workers ack-and-skip tasks of stopped jobs.
  - The coordinator ignores results for inactive jobs.
- **Why:** without it, workers would churn through a cancelled job's queued tasks. Rejected: the coordinator ignoring results alone.
- **Consequences:** the broadcast is best-effort. Missing it wastes some work but never breaks correctness.

### ITD-014: Cleanup runs in the API
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** a sweep every 10 min and on `POST /cleanup` deletes the partials of jobs that finished more than `PARTIAL_RETENTION_MS` ago.
- **Why:** it's just file deletes and DB updates, so it doesn't need the queue. Rejected: a CLEANUP task type.
- **Consequences:** the API needs `DATA_DIR` access, which it already has for downloads.

### ITD-015: Python supervisor with fixed W
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** the supervisor starts `WORKER_COUNT` workers, restarts any that exit non-zero, and forwards SIGTERM, then waits for them to drain.
- **Why:** workers live independently of the API. Rejected: the API spawning workers; `docker compose --scale`.
- **Consequences:** it's already a reconcile loop, so a dynamic W only changes where the target comes from (future-work §4).

### ITD-016: Infrastructure via Docker Compose
**Status:** Accepted (delegated) · **Date:** 2026-10-23
- **Decision:** `postgres:16` and `rabbitmq:4-management` in Docker; the API, workers and UI run natively.
- **Consequences:** one command starts the infrastructure.

### ITD-017: Libraries
**Status:** Accepted (delegated) · **Date:** 2026-10-23
- **Decision:**
  - API: express, pg, amqplib, zod, vitest, npm, plain SQL migrations.
  - Worker: pika, numpy, pytest, uv.
- **Why:** mainstream and free. Rejected: aio-pika (the compute still needs a thread), an ORM (3 tables).

### ITD-018: The final merge writes the mean
**Status:** Accepted (delegated) · **Date:** 2026-10-23
- **Decision:** the final MERGE carries `final=true` and `total_count=F`. The worker divides and writes both result files.
- **Why:** no extra FINALIZE task or hop, and the API does no numeric work.

### ITD-019: Stats in DB tables, pushed over SSE
**Status:** Superseded by ITD-024 · **Date:** 2026-10-23
- `workers` and `events` tables, plus an SSE stream. Replaced by in-memory state and polling.

### ITD-020: Two priority levels: MERGE high, GENERATE normal
**Status:** Accepted · **Date:** 2026-10-25 · **Supersedes:** ITD-003
- **Decision:** one quorum queue. MERGE is published at priority 9, GENERATE at 0. RabbitMQ 4 quorum queues have two levels (above 4 counts as high) and deliver them 2:1, so neither starves.
- **Why:** with FIFO, a nearly finished job waited behind later jobs' backlogs. Rejected: a fair-share dispatcher (extra component, future-work §1); per-level priority (needs classic queues, future-work §2).
- **Consequences:** jobs that are reducing finish quickly, and jobs finish roughly in submission order. Within the high level, leaf merges still run before merges of partials. Verify V-1.

### ITD-021: Workers exit on any broker error
**Status:** Accepted · **Date:** 2026-10-25
- **Decision:** after startup, any channel or connection error means log and `exit(1)`; the supervisor restarts the worker. Only the initial connect retries.
- **Why:** when the consumer timeout fires, the broker closes the channel but a stuck thread keeps running. Exiting kills it. Rejected: reconnecting in-process.
- **Consequences:** one recovery path for every broker problem.

### ITD-022: Coordinator error handling
**Status:** Accepted · **Date:** 2026-10-25
- **Decision:**
  - **DB unavailable:** roll back, keep the message unacked, retry it with backoff.
  - **Any other exception:** roll back, then fail the job ("internal error: …") in a new transaction, and ack.
  - **Invalid message:** log and ack.
- **Why:** the earlier coordinator dead-letter queue had no reader, so a bug hung the job forever.
- **Consequences:** jobs never hang, and two topology objects are gone.

### ITD-023: Topology from a definitions file
**Status:** Accepted · **Date:** 2026-10-25
- **Decision:** `infra/rabbitmq/definitions.json` declares every exchange, queue, binding and argument, loaded at broker start. Code only does passive declares. Per-worker control queues are the only runtime objects.
- **Why:** no startup race, and no argument mismatches between the API and workers.
- **Consequences:** topology changes edit that file and LLD §3 together.

### ITD-024: Observability in memory; the UI polls
**Status:** Accepted · **Date:** 2026-10-25 · **Supersedes:** ITD-019
- **Decision:**
  - An in-memory worker list from heartbeats, with stale (`WORKER_STALE_MS`) and prune (`WORKER_PRUNE_MS`) ages.
  - An event ring buffer (`EVENT_BUFFER_SIZE`), also logged to stdout.
  - Queue depth from the management API; counts from SQL.
  - The UI polls `/stats` and `/events` every second.
  - A job is "waiting" when it's GENERATING with nothing done and no busy worker on it.
- **Why:** this is display-only data. Tables and SSE cost more than they're worth.
- **Consequences:** two fewer tables. After an API restart, workers reappear within 2 s, and event history starts empty (job timestamps are still in the DB).

### ITD-025: Contracts as shared example messages
**Status:** Accepted · **Date:** 2026-10-25 · **Amends:** ITD-001, ITD-017
- **Decision:**
  - LLD §4 is the spec, with one example per message variant in `contracts/examples/`.
  - The API parses with zod; the worker uses TypedDicts and required-key checks.
  - Both test suites parse every example.
- **Why:** five message types don't justify JSON Schema in two languages.
- **Consequences:** the two sides can't drift apart without failing a test.

### ITD-026: Atomic writes without fsync
**Status:** Accepted · **Date:** 2026-10-25
- **Decision:** temp file plus `os.replace`, with no `fsync`.
- **Why:** OS or power crashes are out of scope, and `fsync` slows every task.
- **Consequences:** readers still never see partial files.

### ITD-027: Measure the coordinator before optimizing it
**Status:** Accepted · **Date:** 2026-10-25
- **Decision:** keep one transaction per message. A benchmark (F = 20k, C = 10, W = 8) reports completions per second and how long workers wait on the coordinator. Batch only if it shows a bottleneck.
- **Why:** with small C, workers might outpace about 45k sequential transactions. That's unproven until measured.

### ITD-028: Only the API builds file paths
**Status:** Accepted · **Date:** 2026-10-25
- **Decision:**
  - `api/src/paths.ts` builds input, partial and result paths. The barrier SQL gets its prefix from it.
  - Completions report counts only; the coordinator derives the paths.
  - Workers use the paths in their message.
- **Why:** paths were built in three places, and the coordinator trusted worker input.
- **Consequences:** one source for the file layout, checked by a path test.

### ITD-029: UI with React + Vite + TypeScript
**Status:** Accepted (delegated) · **Date:** 2026-10-25
- **Decision:** a Vite + React + TS single-page app with plain `fetch`, a 1 s polling hook and plain CSS. No state or component libraries. In development, Vite proxies `/api` to port 3000.
- **Why:** a light, free, same-language thin client. Rejected: plain HTML (clumsy for a live dashboard), Next.js (overkill).

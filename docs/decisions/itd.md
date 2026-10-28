# Important Technical Decisions (ITD)

How the system is built. Only **current** decisions are listed (see [`AGENTS.md`](../../AGENTS.md#decision-authority) for statuses). Related micro-decisions were merged into the 14 pillars below; git history keeps earlier text.

**Active ITD IDs:** `ITD-001` – `ITD-014`.

Each entry is a small table: **Context** (problem), **Decision** (what we chose), **Rationale** (why), **Options considered** (alternatives we skipped), and **Trade-offs** (costs and follow-ups).

---

### ITD-001: RabbitMQ, Postgres, shared `DATA_DIR`, and Docker Compose

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | The system needs reliable task queuing with retries/timeouts, ACID state for jobs and the merge pool, shared file storage for arrays, and a reproducible local setup. |
| **Decision** | Run RabbitMQ 4 (task queue, events, heartbeats, control broadcast) and Postgres 16 (`jobs`, `tasks`, `items`, `fleet`) in `docker-compose.yml` with healthchecks. Run the API, Python supervisor/workers, and Vite UI on the host sharing one local `DATA_DIR` directory (absolute path). |
| **Rationale** | RabbitMQ gives per-message acks, `prefetch=1`, delivery limits, dead-lettering, and consumer timeouts out of the box; Postgres gives transactional scheduling and an outbox; a shared local folder plus Docker Compose for backing stores keeps local development fast and one-command simple. |
| **Options considered** | Postgres-only queue; Redis Streams; S3/MinIO object storage in Docker (future-work §7); containerizing API, workers, and UI too. |
| **Trade-offs** | Two stateful stores must stay in sync via the transactional outbox (ITD-003), local `DATA_DIR` ties the API and workers to one machine or shared mount, and developers need Docker + Node + Python installed locally. |

### ITD-002: Single API coordinator, error classification, and benchmark gate

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Many workers finish in parallel. Updating `generated_files`, firing the generation barrier, and reserving merge-pool items must never race or leave a job hung on an error. |
| **Decision** | Workers never touch Postgres; they only publish `task.completed` or `task.failed` on RabbitMQ. A single coordinator in the API consumes `dm.coordinator` and `dm.tasks.dead` one message at a time, applies state in one Postgres transaction (`FOR UPDATE` on the job row), and acks only after commit. On errors: (1) bad JSON/schema → log and `ack`; (2) Postgres unavailable → rollback, keep message unacked, retry with backoff; (3) unexpected code/SQL bug → rollback, mark job `FAILED` (`internal error`), `ack` (if marking `FAILED` fails, `exit(1)` so `run-api.sh` restarts and redelivers). Keep one-message-per-tx until `scripts/benchmark-job.py` (`F = 20,000, C = 10, W = 8`) shows a bottleneck. |
| **Rationale** | Serializing state transitions through one writer eliminates pool-scheduling races (especially the global `open_merges = 0` tail rule), keeps workers stateless, guarantees no coordinator error can silently hang a job, and avoids premature batching/sharding complexity. |
| **Options considered** | Workers writing Postgres directly; multiple concurrent coordinators; unmonitored coordinator DLQ on bugs; upfront multi-message transaction batching. |
| **Trade-offs** | One coordinator caps completion rate (~91 completions/s measured at F = 20k on 2026-10-26—well above local needs) and pauses updates briefly during an API restart or DB outage. Scale-out path: batch or shard by `job_id` (future-work §3). |

### ITD-003: Transactional outbox, fair-share dispatch, and orphan reconciliation

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Writing tasks to Postgres and publishing to RabbitMQ must be crash-safe. Dumping thousands of tasks into RabbitMQ at once starves small jobs behind huge ones (FIFO), while RabbitMQ 4 quorum message priority starved other jobs’ `GENERATE` tasks whenever one job was `REDUCING`. Also, if a broker reset loses a message already marked `PUBLISHED`, that job would wait forever. |
| **Decision** | Save new tasks in Postgres as `CREATED` inside the scheduling transaction. The outbox relay wakes on coordinator signals and every 200 ms: it passive-declares `dm.tasks` (`checkQueue`) and publishes only enough `CREATED` tasks (with confirms, then sets `PUBLISHED`) to keep ~`2 × consumers` ready messages queued. It picks one task per active job in round-robin order (`lastJobId` cursor) and, within each job, prefers `MERGE` over `GENERATE` (`(kind = 'MERGE') DESC, level DESC, created_at, id`), with no AMQP priority field. To self-heal lost messages (`reconcilePublished.ts`), reset `PUBLISHED` → `CREATED` on API startup if `dm.tasks` has 0 ready and 0 unacked messages (via management API), or periodically when a `PUBLISHED` row is older than `PUBLISHED_STALE_MS` (2 min), `unacked = 0`, and no live worker heartbeat reports `BUSY` on that `task_id`. |
| **Rationale** | Keeping the backlog in Postgres makes task creation atomic with DB state, lets SQL re-order work on every tick so N active jobs share workers ~W/N while each job finishes its deepest merges first, and automatically recovers orphaned `PUBLISHED` rows. |
| **Options considered** | Publishing directly to RabbitMQ without an outbox; unbounded FIFO queue publish; RabbitMQ `x-max-priority` queues (rejected in V-1); manual SQL repair for stuck `PUBLISHED` tasks. |
| **Trade-offs** | Relay runs a window query + queue check every 200 ms, fairness is equal-tasks-per-job rather than weighted by `C` (future-work §1), and a task can occasionally be published twice after a crash or delayed heartbeat—safe because tasks and completions are idempotent (ITD-006). |

### ITD-004: 5-file GENERATE barrier and dynamic pool reduction

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Each worker task may touch at most 5 files, all F inputs must exist before merging starts (IPD-001), and reduction must never wait on a specific slow worker or need an extra pass to know when the job is done. |
| **Decision** | `POST /jobs` inserts the job (`GENERATING`) and ⌈F/5⌉ `GENERATE` tasks (1–5 files each) in one statement. Each completion increments `generated_files`; when it hits F, the coordinator in one transaction flips the job to `REDUCING`, seeds all F `INPUT` rows (`count = 1`, `READY`) into `items`, and schedules leaf merges. During `REDUCING`, whenever ≥5 items are `READY`, reserve 5 (`FIFO` by `created_at, id`) into a `MERGE` task (`PARTIAL` output `count` = sum of input counts). When 2–4 items are `READY`, merge them only if `open_merges = 0` for that job. While `REDUCING`, `SUM(count)` across `READY + RESERVED` items always equals F, so the merge whose inputs sum to F is flagged `is_final`: its worker divides the `int64` sum by F and writes `result.npy` and `result.csv`. |
| **Rationale** | Batching 5 files per `GENERATE` cuts task overhead 5×; any fast worker can merge any 5 ready items from the pool (no static tree stragglers); the strict tail rule minimizes total merges to ⌈(F−1)/4⌉; and `sum(count) == F` detects the final merge immediately with no separate finalize task. |
| **Options considered** | 1 file per `GENERATE` task; static 5-ary merge tree; per-worker partial accumulators; eagerly merging 2–4 tail items while other merges are still in flight; separate finalize task. |
| **Trade-offs** | Up to 5 input files retry together if a `GENERATE` task fails, and the final 2–4 tail items wait briefly for in-flight merges of the same job to finish before the last merge is scheduled. |

### ITD-005: AMQP liveness and crash-only recovery (workers and API)

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Workers or the API can crash, hang mid-task, or lose their RabbitMQ connection when the broker restarts. Half-broken AMQP channels or zombie threads would stall jobs. |
| **Decision** | Workers use `prefetch=1`, manual ack after result publish, 10 s AMQP heartbeats, `x-consumer-timeout = 15 min` on `dm.tasks`, and run CPU/disk work on a background thread (`worker.heartbeat` every 2 s is UI-only). After startup, any AMQP connection/channel error in a worker calls `sys.exit(1)` and the supervisor spawns a fresh process. Likewise, on any fatal AMQP error after startup, the API calls `process.exit(1)`, `/health` returns `503` while disconnected, and `scripts/run-api.sh` restarts the API with backoff. |
| **Rationale** | RabbitMQ automatically requeues unacked tasks on TCP drop (~10–20 s) or consumer timeout (15 min), and exiting the whole process on broker errors cleanly kills stuck threads and rebuilds all consumers and channels from scratch on restart. |
| **Options considered** | Custom Postgres task leases and reaper daemon; in-process AMQP reconnect/re-subscribe state machines in Python and Node. |
| **Trade-offs** | A hung worker thread that keeps its socket alive takes up to 15 min to time out (faster watchdog in future-work §5), broker blips cause a ~1–2 s API restart (resetting in-memory events), and production/e2e runs must launch the API via `scripts/run-api.sh` rather than `npm run dev`. |

### ITD-006: Idempotency, deterministic seeds, and atomic file writes

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | At-least-once delivery means tasks can execute more than once, and a worker crash mid-write must never leave a half-written file on disk. |
| **Decision** | Seed every input file deterministically from `(jobs.seed, file_index)` using `numpy.random.SeedSequence`. Write every `.npy` and `.csv` file to `<target>.tmp-<uuid>` in the same directory and `os.replace` onto the final path (no per-file `fsync`). In the coordinator, apply `task.completed` only `WHERE status IN ('CREATED', 'PUBLISHED')`, and apply `task.failed` only when `attempt` matches the DB row. |
| **Rationale** | Re-running a `GENERATE` or `MERGE` task writes identical bytes atomically so readers never see partial files, skipping `fsync` keeps local disk I/O fast across thousands of files, and the SQL status guard makes duplicate completions a safe no-op. |
| **Options considered** | Per-attempt fencing tokens on file paths; writing directly to final paths; calling `fsync` on every file write. |
| **Trade-offs** | Redelivered tasks occasionally repeat disk work, leftover `.tmp-*` files from hard kills sit until cleanup/delete, and skipping `fsync` targets process crashes rather than host power loss. |

### ITD-007: Task retries and dead-letter poison handling

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Tasks can fail from transient glitches, deterministic code/data errors, or repeated hard crashes (e.g. OOM/SIGKILL before Python can send `task.failed`). |
| **Decision** | Caught worker errors publish `task.failed` and ack; the coordinator increments `attempt` and resets the task to `CREATED` (keeping any reserved pool items attached to that `task.id` for the retry) up to `MAX_ATTEMPTS = 3`, then marks the job `FAILED` with `failure_reason` in the API and UI. Uncaught worker crash loops hit `dm.tasks` quorum `x-delivery-limit = 3`, dead-letter to `dm.tasks.dead`, and the coordinator fails the job. |
| **Rationale** | Handles both caught exceptions and hard process crashes, gives transient errors 3 attempts, and guarantees poison tasks always terminate the job with a clear reason. |
| **Options considered** | Failing the job on the first task error; unlimited retries; manual inspection of a dead-letter queue without failing the job. |
| **Trade-offs** | A deterministic error runs up to 3 times before failing the job, and a single unrecoverable task fails the whole job. |

### ITD-008: Exact arithmetic, file formats, and single path builder

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Repeated float additions lose precision, text parsing slows down intermediate merges, and file paths must never drift between TypeScript, SQL, and Python or trust worker input. |
| **Decision** | Store inputs as `.npy` `uint8[C]` (values 0–100), partials as `.npy` `int64[C]`, and final output as `result.npy` (`float64[C]`) + `result.csv` (`%.8f`, one line), dividing by F only once in the final merge. Stream any input or partial `.npy` as CSV on demand from the API. Build all paths under `DATA_DIR` exclusively in `api/src/paths.ts`; pass target paths in task messages and ignore paths in worker completion messages. |
| **Rationale** | `uint8` inputs are 1 byte/value, `int64` partial sums are exact and cannot overflow (`100 × 99,999 ≪ 2^63 − 1`), binary `.npy` loads directly into NumPy, and centralizing paths in `paths.ts` prevents path bugs and untrusted path injection. |
| **Options considered** | `float64` or CSV for intermediate partials; building paths separately in Python and TypeScript; letting workers report output paths in `task.completed`. |
| **Trade-offs** | `int64` partials are 8 bytes/value on disk until cleanup runs, task messages carry explicit file path lists, and `paths.test.ts` must keep `paths.ts` and barrier SQL path formatting locked together. |

### ITD-009: Cancel broadcast and ignoring late results

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | When a job is cancelled or fails, tasks for that job may already be queued in RabbitMQ or running on workers. |
| **Decision** | Mark the job and its open tasks terminal (`CANCELLED` or `FAILED`) in Postgres, then fanout `job.stopped` on `dm.control`. Workers cache stopped `job_id`s in memory and immediately ack/skip queued tasks for those jobs. The coordinator drops any late `task.completed` / `task.failed` messages for non-active jobs (`ignored_inactive_job`). |
| **Rationale** | Postgres is the authority for correctness (late results cannot mutate a stopped job), while the fanout broadcast drains queued tasks in milliseconds without scanning or purging the shared broker queue. |
| **Options considered** | Coordinator-only ignore without broadcast (workers waste CPU finishing queued tasks); selective broker queue purge. |
| **Trade-offs** | Broadcast is best-effort: a task already mid-execution on a worker thread finishes its current batch before its result is ignored, and newly spawned workers only receive future broadcasts. |

### ITD-010: Partial file retention and API cleanup

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | `int64` partial `.npy` files use most of the disk space during a job, are needed briefly after completion for task-graph CSV inspection, and should be reclaimed afterwards. |
| **Decision** | Every 10 minutes (`CLEANUP_INTERVAL_MS`) and on `POST /cleanup`, the API deletes partial `.npy` files for terminal jobs finished longer than `PARTIAL_RETENTION_MS` (default 1 hour; `?force=true` uses 0 s), marks those `items` `DELETED`, and sets `jobs.partials_cleaned_at`. Input files and `result.csv` / `result.npy` stay until `DELETE /jobs/:id`. |
| **Rationale** | Runs in the API process that already owns DB state and `DATA_DIR` access, reclaims the bulky intermediate files automatically, and preserves a 1-hour debugging window for partial CSV downloads. |
| **Options considered** | Deleting partials immediately on job completion; dispatching cleanup tasks to Python workers. |
| **Trade-offs** | Peak disk space remains allocated for up to 1 hour after a job finishes unless `POST /cleanup?force=true` (or the UI cleanup button) is used; once cleaned, partial CSV endpoints return `409 Gone`. |

### ITD-011: RabbitMQ topology in `definitions.json`

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-25 |
| **Context** | RabbitMQ queue arguments (`x-queue-type=quorum`, `x-delivery-limit`, `x-dead-letter-exchange`, `x-consumer-timeout`) are immutable after creation—any mismatch between API and worker declarations crashes the channel with `PRECONDITION_FAILED`. |
| **Decision** | Define all exchanges, queues, bindings, and the `guest` user in `infra/rabbitmq/definitions.json`, loaded once at broker boot via `rabbitmq.conf` (`dm.coordinator` uses `x-delivery-limit = 1_000_000` because RabbitMQ 4 import rejects `-1`). API and workers only passive-declare queues/exchanges to verify they exist; workers dynamically create only their exclusive auto-delete `dm.control` queue. |
| **Rationale** | Single declarative file for broker topology eliminates startup declaration races and guarantees identical queue settings across Node, Python, and tests. |
| **Options considered** | Active `assertQueue` with full arguments in both API and worker code; post-start shell scripts calling `rabbitmqadmin`. |
| **Trade-offs** | Editing queue arguments requires updating `definitions.json` + LLD §3 and recreating the RabbitMQ Docker volume, and `guest` dev credentials live in the repo. |

### ITD-012: In-memory observability and on-read task graph

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-25 |
| **Context** | Operators and the UI need live worker health, queue depth, job progress, event history, and a per-job task DAG with CSV previews without adding write-path overhead to every task. |
| **Decision** | Keep the live worker registry (fed by 2 s `dm.heartbeats`) and a 500-event ring buffer (`GET /events`) in API memory, combined with SQL job counts and RabbitMQ management stats in `GET /stats` (marking a job `waiting` when `GENERATING` with 0 done tasks and no busy worker). Build `GET /jobs/:id/task-graph` on read from existing `tasks` and `items` rows (`produced_by`, `reserved_by`, and `file_start`/`file_count`), including `produced_by` on partial inputs for CSV preview links. |
| **Rationale** | Heartbeats and events are ephemeral display data (no DB write load), and `tasks` + `items` already store exact lineage so deriving the DAG on read needs zero extra tables or coordinator writes. |
| **Options considered** | Persisting `workers`, `events`, and `task_edges` tables in Postgres; pushing updates via WebSockets or SSE. |
| **Trade-offs** | Worker list and event ring buffer reset when the API restarts (durable job/task rows stay in Postgres), and `GET /jobs/:id/task-graph` scans the job’s tasks and items on each 1 s poll while the modal is open. |

### ITD-013: Cross-language contracts via shared example JSON

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-25 |
| **Context** | The TypeScript API and Python workers communicate through 6 JSON message types over RabbitMQ and must never drift on field names or types. |
| **Decision** | Keep one canonical JSON file per message variant in `contracts/examples/*.json` with `schema_version: 1`. Validate incoming/outgoing messages with `zod` in the API (`api/src/messages.ts`) and required-key validators in Python (`worker/src/dismean_worker/messages.py`), and run unit tests in both test suites that parse every example file. |
| **Rationale** | Enforces full cross-language contract compatibility in CI with zero codegen build steps for a small, stable message set. |
| **Options considered** | JSON Schema + code generation for TypeScript and Python; Protobuf or Avro. |
| **Trade-offs** | Changing any message shape requires bumping `schema_version` and updating LLD §4, `contracts/examples/`, and both parsers in the same change. |

### ITD-014: Configurable fleet size W and graceful scale-down

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-26 |
| **Context** | Operators need to scale the worker fleet W (1–32) at runtime from the API or UI (problem-statement bonus) without workers connecting to Postgres or killing in-flight tasks on scale-down. |
| **Decision** | Store `desired_workers` and `set_by_api` in a single-row Postgres `fleet` table. On API startup, seed `desired_workers = WORKER_COUNT` only if `set_by_api = false`; `PUT /fleet` sets `set_by_api = true`. `GET /fleet` returns `desired_workers` plus live worker PIDs and states (`IDLE`/`BUSY`). The Python supervisor polls `GET /fleet` every 1.5 s: it spawns workers on scale-up and sends `SIGTERM` on scale-down—draining `IDLE` workers first, dead slots second, and newest `BUSY` workers last so active tasks finish before exit. |
| **Rationale** | Preserves the “workers never touch Postgres” invariant, respects `WORKER_COUNT` on fresh deploys while persisting runtime API changes across restarts, and avoids interrupting in-flight tasks when scaling down. |
| **Options considered** | Static `WORKER_COUNT` env var only; workers reading `fleet` from Postgres; always overwriting `fleet` from `WORKER_COUNT` on API restart; stopping arbitrary busy workers first. |
| **Trade-offs** | Up to ~1.5 s polling lag after `PUT /fleet`, `desired_workers` is applied per supervisor host, and once `PUT /fleet` is used, `WORKER_COUNT` env changes are ignored until reset. |

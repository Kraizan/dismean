# Important Technical Decisions (ITD)

How the system is built. Only **current** decisions are listed (see [`AGENTS.md`](../../AGENTS.md#decision-authority) for statuses). Related micro-decisions were merged into the 14 pillars below; git history keeps earlier text.

**Active ITD IDs:** `ITD-001` – `ITD-014`.

Each entry is a small table: **Context** (problem), **Decision** (what we chose), **Rationale** (why), **Options considered** (alternatives we skipped), and **Trade-offs** (costs and follow-ups).

---

### ITD-001: RabbitMQ, Postgres, shared data directory, and Docker Compose

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | The system needs reliable task queuing with retries and timeouts, ACID state for jobs and the merge pool, shared file storage for arrays, and a reproducible local setup. |
| **Decision** | Run RabbitMQ 4 (task queue, events, heartbeats, control broadcast) and Postgres 16 (jobs, tasks, items, fleet) in Docker Compose with health checks. Run the API, Python supervisor and workers, and the UI on the host, all sharing one local data directory (absolute path). |
| **Rationale** | RabbitMQ gives per-message acknowledgements, one unacked task per worker, delivery limits, dead-lettering, and consumer timeouts; Postgres gives transactional scheduling and an outbox; Docker for backing stores plus a shared folder keeps local development fast and simple. |
| **Options considered** | Postgres-only queue; Redis Streams; object storage in Docker (future-work §5); containerizing API, workers, and UI too. |
| **Trade-offs** | Two stateful stores must stay aligned via the transactional outbox (ITD-003), the shared data directory ties the API and workers to one machine or shared mount, and developers need Docker plus Node and Python on the host. |

### ITD-002: Single API coordinator, error classification, and benchmark gate

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Many workers finish in parallel. Updating generation progress, firing the generation barrier, and reserving merge-pool items must never race or leave a job hung on an error. |
| **Decision** | Workers never touch Postgres; they only publish task completed or task failed events on the message broker. A single coordinator in the API consumes completion and poison messages one at a time, applies state in one Postgres transaction with the job row locked for update, and acknowledges only after commit. On errors: invalid message → log and acknowledge; database unavailable → roll back, leave the message unacknowledged, retry with backoff; unexpected bug → roll back, mark the job failed with an internal reason, acknowledge (if marking failed cannot be committed, exit the process so the restart loop redelivers). Keep one message per transaction until a large benchmark job shows the coordinator is the bottleneck. |
| **Rationale** | One writer serializes scheduling (especially the global “no open merges” tail rule), keeps workers stateless, guarantees coordinator errors cannot silently hang a job, and avoids batching or sharding until measurements say so. |
| **Options considered** | Workers writing Postgres directly; multiple concurrent coordinators; dead-letter queue only on bugs without failing the job; upfront multi-message transaction batching. |
| **Trade-offs** | One coordinator caps completion throughput (measured well above local needs at large F) and pauses updates briefly during API restart or database outage. Scale-out path: batch or shard by job (future-work §2). |

### ITD-003: Transactional outbox, fair-share dispatch, and orphan reconciliation

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Saving tasks and publishing to the broker must be crash-safe. Publishing everything at once starves small jobs behind large ones. Broker priority queues starved other jobs’ generate work whenever one job was reducing. If the broker loses a message already marked published, that job would wait forever. |
| **Decision** | Insert new tasks as created-only rows inside the scheduling transaction. An outbox relay wakes on coordinator signals and on a short fixed interval: it reads live queue depth and publishes only enough created tasks—with broker confirms, then marks them published—to keep about twice the worker count ready in the task queue. It picks one task per active job in round-robin order and, within each job, prefers merge over generate and deeper levels first, without broker message priority. To heal lost publishes: on API startup, if the task queue has no ready or unacknowledged messages, reset published rows back to created; periodically, if a published row is older than a few minutes, nothing is unacknowledged on the queue, and no live worker heartbeat shows busy on that task, reset it the same way. |
| **Rationale** | The backlog in Postgres makes task creation atomic with database state, SQL reordering on each tick shares workers fairly across jobs while finishing deep merges first per job, and stale published rows recover automatically. |
| **Options considered** | Publishing directly without an outbox; unbounded first-in-first-out publish; broker priority levels; manual repair for stuck published tasks. |
| **Trade-offs** | The relay polls queue depth and runs a scheduling query on a fixed interval; fairness is equal tasks per job, not weighted by job size (future-work §1); a task may be published twice after crashes or delayed heartbeats—safe because tasks and completions are idempotent (ITD-006). |

### ITD-004: Five-file generate barrier and dynamic pool reduction

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Each worker task may touch at most five files, all F inputs must exist before merging starts (IPD-001), and reduction must not wait on one slow worker or need an extra pass to detect job completion. |
| **Decision** | Job creation inserts the job in generating state and enough generate tasks to cover F files (up to five files each) in one statement. Each completion increments generated file count; when it reaches F, the coordinator in one transaction moves the job to reducing, seeds F pool items (count one, ready), and schedules leaf merges. Whenever at least five items are ready, reserve five in fifo order into a merge task (partial output count is the sum of input counts). When two to four items are ready, merge them only if that job has no merge tasks still in flight. While reducing, the sum of counts on ready and reserved items always equals F, so the merge whose inputs sum to F is the final merge: its worker divides the integer sum by F and writes the result files. |
| **Rationale** | Five files per generate task cuts overhead; any worker can merge any five ready items (no fixed tree stragglers); the strict tail rule minimizes merge count; the count invariant identifies the final merge without a separate finalize step. |
| **Options considered** | One file per generate task; static five-way merge tree; per-worker partial accumulators; eager tail merges while other merges run; separate finalize task. |
| **Trade-offs** | Up to five input files retry together on generate failure; the last two to four items wait briefly for in-flight merges on the same job before the final merge is scheduled. |

### ITD-005: AMQP liveness and crash-only recovery (workers and API)

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Workers or the API can crash, hang mid-task, or lose the broker connection when RabbitMQ restarts. Half-broken channels or zombie threads would stall jobs. |
| **Decision** | Workers take one unacked task at a time, acknowledge only after publishing the result, use periodic AMQP heartbeats, and rely on a long per-queue consumer timeout on the task queue. CPU and disk work run off the AMQP thread; worker heartbeats to the UI channel are display-only. After startup, any fatal broker error in a worker exits the process and the supervisor starts a fresh one. The API exits on fatal broker errors after startup, health checks fail while disconnected, and a restart wrapper reruns the API with backoff. |
| **Rationale** | The broker requeues unacked tasks on connection loss or consumer timeout; exiting the whole process on broker errors clears stuck threads and rebuilds consumers cleanly on restart. |
| **Options considered** | Custom database task leases and a reaper; in-process reconnect state machines in Python and Node. |
| **Trade-offs** | A hung worker that keeps its connection alive may hold a task until consumer timeout (faster watchdog in future-work §3); brief broker blips restart the API and clear in-memory events; production runs should use the restart wrapper, not hot-reload dev mode alone. |

### ITD-006: Idempotency, deterministic seeds, and atomic file writes

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | At-least-once delivery can run tasks more than once; a crash mid-write must not leave a half-written file. |
| **Decision** | Seed every input file deterministically from the job seed and file index. Write every array and CSV to a temporary name in the same directory, then rename atomically onto the final path without forcing disk sync on every file. The coordinator applies task completed only when the task is still created or published, and task failed only when the attempt matches the stored row. |
| **Rationale** | Re-running generate or merge writes identical bytes; readers never see partial files; skipping per-file sync keeps local I/O fast; duplicate completions are harmless no-ops. |
| **Options considered** | Per-attempt fencing on paths; writing directly to final paths; syncing every file to disk. |
| **Trade-offs** | Redelivered tasks repeat disk work; leftover temp files from hard kills remain until cleanup; skipping sync targets process crashes, not host power loss. |

### ITD-007: Task retries and dead-letter poison handling

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Tasks fail from transient glitches, deterministic errors, or repeated hard crashes before the worker can send task failed. |
| **Decision** | Caught worker errors publish task failed and acknowledge the task message; the coordinator increments attempt and resets the task to created (keeping reserved pool items on that task for retry) up to three attempts, then marks the job failed with a reason in the API and UI. Uncaught crash loops hit the task queue delivery limit, dead-letter to a poison queue, and the coordinator fails the job. |
| **Rationale** | Covers caught exceptions and hard crashes, gives transient errors three tries, and guarantees poison work terminates the job with a clear reason. |
| **Options considered** | Fail on first error; unlimited retries; manual dead-letter inspection without failing the job. |
| **Trade-offs** | Deterministic errors may run three times before failing the job; one bad task fails the whole job. |

### ITD-008: Exact arithmetic, file formats, and single path authority

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Repeated floating-point addition loses precision; text parsing slows merges; file paths must not drift between API, database, and workers or trust worker-supplied paths. |
| **Decision** | Store inputs as eight-bit unsigned integers per column, partials as sixty-four-bit integer sums, and final output as floating-point array plus CSV with fixed decimal formatting, dividing by F only in the final merge. Stream any stored array as CSV on demand from the API. Build all paths under the data directory only in the API; pass targets in task messages and ignore paths in worker completion messages. |
| **Rationale** | Small integers are one byte per value; integer partial sums are exact and safely bounded; binary arrays load efficiently in NumPy; central path authority prevents injection and mismatches. |
| **Options considered** | Floating-point or CSV intermediates; duplicate path logic in Python; workers reporting output paths on completion. |
| **Trade-offs** | Integer partials use more disk until cleanup; task messages carry explicit file lists; API tests must keep path rules aligned with scheduling SQL. |

### ITD-009: Cancel broadcast and ignoring late results

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | When a job is cancelled or fails, its tasks may already be queued or running on workers. |
| **Decision** | Mark the job and open tasks terminal in Postgres, then broadcast job stopped on a fanout control exchange. Workers remember stopped job ids and immediately acknowledge and skip queued tasks for those jobs. The coordinator drops late completion or failure messages for non-active jobs. |
| **Rationale** | Postgres is authoritative; the broadcast drains queued work quickly without purging the shared task queue. |
| **Options considered** | Coordinator-only ignore without broadcast; selective broker queue purge. |
| **Trade-offs** | Broadcast is best-effort: a task already executing may finish its current batch before the result is ignored; new workers only learn stops from later broadcasts. |

### ITD-010: Partial file retention and API cleanup

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Integer partial arrays use most disk during a job, are useful briefly after completion for inspection, and should be reclaimed afterward. |
| **Decision** | On a fixed interval and on an explicit cleanup request, the API deletes partial files for terminal jobs older than a configurable retention window (force cleanup uses zero retention), marks those pool items deleted, and records cleanup time on the job. Input and result files stay until the job is deleted. |
| **Rationale** | The API already owns database and disk access; automatic cleanup reclaims bulk space while keeping a debugging window for partial CSV downloads. |
| **Options considered** | Delete partials immediately on completion; offload cleanup to workers. |
| **Trade-offs** | Peak disk may linger until retention expires unless force cleanup; partial CSV endpoints return gone after cleanup. |

### ITD-011: Broker topology in declarative definitions

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-25 |
| **Context** | Queue arguments (quorum type, delivery limits, dead-letter routing, consumer timeout) are immutable after creation—mismatched declarations crash channels. |
| **Decision** | Define all exchanges, queues, bindings, and the development user in one JSON file loaded at broker boot. API and workers only verify topology exists; each worker creates its own exclusive auto-delete control subscription queue at runtime. Use a large finite delivery limit on the coordinator queue where unlimited is rejected at import. |
| **Rationale** | One declarative source eliminates declaration races and keeps Node, Python, and tests aligned. |
| **Options considered** | Assert full queue arguments from application code on every start; post-start admin scripts. |
| **Trade-offs** | Changing queue arguments requires updating definitions, docs, and recreating the broker volume; development credentials live in the repo. |

### ITD-012: In-memory observability and on-read task graph

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-25 |
| **Context** | Operators and the UI need live worker health, queue depth, job progress, event history, and a per-job task graph with CSV previews without write-path overhead on every task. |
| **Decision** | Keep the live worker registry (from periodic heartbeats) and a bounded in-memory event ring in the API, combined with SQL job counts and broker management stats in aggregate stats (mark a job waiting when generating with zero completed tasks and no busy worker). Build the task graph on read from existing task and pool rows, including lineage fields for CSV preview links. |
| **Rationale** | Heartbeats and events are ephemeral display data; tasks and items already store lineage, so no extra tables or coordinator writes are needed for the graph. |
| **Options considered** | Persist workers, events, and edge tables; push updates via WebSockets or server-sent events. |
| **Trade-offs** | Worker list and events reset on API restart; the task graph query runs on each poll while the modal is open. |

### ITD-013: Cross-language contracts via shared example JSON

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-25 |
| **Context** | The API and workers exchange several JSON message shapes over RabbitMQ and must not drift on fields or types. |
| **Decision** | Keep one canonical JSON example per message variant with a schema version field. Validate at the boundary in TypeScript and Python, and run tests in both languages that parse every example file. |
| **Rationale** | Enforces cross-language compatibility in continuous integration without code generation for a small stable message set. |
| **Options considered** | JSON Schema with codegen; Protobuf or Avro. |
| **Trade-offs** | Any message change bumps schema version and updates the written spec, examples, and both validators in one change. |

### ITD-014: Configurable fleet size and graceful scale-down

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-26 |
| **Context** | Operators need to change worker count at runtime from the API or UI without workers touching Postgres or killing in-flight tasks on scale-down. |
| **Decision** | Store desired worker count and whether the API has overridden the environment default in a single-row fleet table. On API startup, seed from the environment default only when the API has not previously set the count. The fleet status endpoint returns desired count plus live worker process ids and idle or busy state. The supervisor polls that endpoint on a short interval: spawn on scale-up; on scale-down send graceful stop to idle workers first, dead slots second, newest busy workers last so active tasks finish before exit. |
| **Rationale** | Preserves API-only database writes, respects environment defaults on fresh deploys while persisting API changes across restarts, and avoids interrupting in-flight work when shrinking the fleet. |
| **Options considered** | Environment-only worker count; workers reading fleet from Postgres; always resetting from environment on API restart; stopping arbitrary busy workers first. |
| **Trade-offs** | Short polling lag after fleet updates; desired count applies per supervisor host; after an API fleet change, environment worker count changes are ignored until reset. |

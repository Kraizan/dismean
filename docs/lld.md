# Low-level design

**Updated:** 2026-10-28 · [HLD](hld.md) · [Design doc](design-doc.md) · [ITDs](decisions/itd.md) · [IPDs](decisions/ipd.md)

This document describes **how the system works**: data model, queues, messages, and main flows. It avoids file-by-file code detail — use [code-map.md](code-map.md) and the source for that. **Canonical DDL** is in `api/migrations/`. **Canonical message JSON** is in `contracts/examples/`.

---

## 1. Where things live

| Area | Role |
|---|---|
| **API** | HTTP, coordinator, outbox relay, cleanup, stats |
| **Worker + supervisor** | Run GENERATE/MERGE tasks; supervisor matches process count to `GET /fleet` |
| **Postgres** | Jobs, tasks (outbox), merge pool (`items`), fleet target W |
| **RabbitMQ** | Task queue, coordinator events, heartbeats, cancel broadcast |
| **DATA_DIR** | Shared inputs, partials, results per job |
| **UI** | Bonus dashboard (IPD-006) |
| **Infra** | Docker Compose for Postgres and RabbitMQ; topology in `infra/rabbitmq/definitions.json` |

---

## 2. Database (Postgres 16)

### Tables

| Table | Purpose |
|---|---|
| **jobs** | `file_count` (F), `values_per_file` (C), status, seed, `generated_files`, timestamps, `failure_reason` |
| **tasks** | Outbox + history: `GENERATE` or `MERGE`, status, attempt, level, file range or `input_count`, `is_final` |
| **items** | Merge pool: `INPUT` or `PARTIAL`, `state`, `count`, path, `produced_by`, `reserved_by` |
| **fleet** | Single row: desired worker count W (1–32) |

### Enums (short)

- **Job:** `GENERATING` → `REDUCING` → `COMPLETED` | `FAILED` | `CANCELLED`
- **Task:** `CREATED` → `PUBLISHED` → `DONE` | `FAILED` | `CANCELLED`
- **Item:** `READY` → `RESERVED` → `CONSUMED` | `DELETED`

### Rules

- Tasks with status **`CREATED`** are waiting for the relay to publish (ITD-003).
- **`items` with `READY`** are eligible to be merged (up to 5 at a time).
- While a job is **`REDUCING`**, the sum of `count` on items in `READY` or `RESERVED` always equals **F** (tested invariant).
- Worker list and the event log are **not** in Postgres (ITD-012).

Full `CREATE TABLE` and indexes: `api/migrations/`.

---

## 3. RabbitMQ topology

Declared in `definitions.json` at broker start (ITD-011). API and workers only **check** objects exist (passive declare). Each worker creates its own **control queue** at runtime.

| Exchange / queue | Who publishes | Who consumes | Notes |
|---|---|---|---|
| **dm.tasks** | Outbox relay | Workers | Quorum; ~2 ready msgs per worker; delivery limit 3; consumer timeout 15 min; DLX → dead queue |
| **dm.tasks.dead** | Broker | Coordinator | Crash loop / poison |
| **dm.events** → **dm.coordinator** | Workers | Coordinator | `task.completed`, `task.failed` |
| **dm.events** → **dm.heartbeats** | Workers | Stats (auto-ack) | Display only; TTL 10 s |
| **dm.control** | API (cancel / fail) | Each worker | `job.stopped` fanout |

Task messages: JSON, persistent, `message_id = task_id:attempt`. **No priority field** — order is chosen in SQL (ITD-003).

Broker assumptions: verified at implementation; re-check with `scripts/verify-rabbitmq.py` after broker upgrades ([open-questions.md](open-questions.md)).

---

## 4. Message contracts (schema version 1)

Written spec below; copy-paste examples in `contracts/examples/` (ITD-013). Paths in messages are under `DATA_DIR` and are built only by the API (ITD-008).

| Message | Routing | Main fields |
|---|---|---|
| **Task (GENERATE)** | `dm.tasks` | `file_indices`, `output_paths`, `seed`, `c` |
| **Task (MERGE)** | `dm.tasks` | `inputs[]` (path, count, item_id), `output_path` or `result_paths`, `final`, `total_count` |
| **task.completed** | `task.completed` | `task_id`, `attempt`, `worker_id`, `duration_ms`, `output` (files written or merge count) — **no paths** |
| **task.failed** | `task.failed` | `task_id`, `attempt`, `error` |
| **worker.heartbeat** | `worker.heartbeat` | `state`, optional current task — UI only |
| **job.stopped** | `dm.control` | `job_id`, `status` (`CANCELLED` or `FAILED`) |

Limits: at most **5** files per GENERATE or MERGE task.

---

## 5. Coordinator

Single consumer on **dm.coordinator** and **dm.tasks.dead**. Processes **one message at a time**; acks only after Postgres **commit**.

### On each message

1. Lock the **job** row.
2. If the job is not `GENERATING` or `REDUCING`, ignore (inactive job) and ack.
3. Otherwise handle **completed**, **failed**, or **dead-letter**.
4. Commit, ack, push events, **signal the relay** (frees a worker slot).

### Task completed

- Mark task **DONE** only if still `CREATED` or `PUBLISHED` (else duplicate — ignore).
- **GENERATE:** add to `generated_files`. When count reaches **F**, run the **barrier** (one transaction): set `REDUCING`, insert F **INPUT** items, create **leaf merges**, run **schedule**.
- **MERGE (not final):** mark inputs **CONSUMED**, insert new **PARTIAL** item, **schedule**.
- **MERGE (final):** mark job **COMPLETED**.

### Schedule (merge pool)

Repeat until nothing to do:

- If **≥ 5** items `READY` → create a MERGE over any 5 (reserve them).
- Else if **2–4** `READY` and **no open MERGE** (`CREATED`/`PUBLISHED`) → merge all of them.
- Else stop.

Final merge is created when reserved inputs’ counts sum to **F**.

Leaf merges at the barrier use a **set-based** SQL batch for large F (not one loop per merge).

### Task failed

- Match **attempt**. Retry: back to `CREATED` (up to 3 attempts). Else fail the job. MERGE inputs stay **RESERVED** during retry.

### Dead letter

- After 3 broker deliveries without ack → fail the job (crash loop).

### Errors (ITD-002, ITD-005)

| Situation | Behavior |
|---|---|
| Bad JSON / schema | Log, ack (no retry loop) |
| Postgres down | Roll back, keep message unacked, retry with backoff |
| Other bug | Fail job with “internal error”, ack |
| RabbitMQ lost | API exits; restart loop redelivers unacked messages |

Coordinator does not build paths from worker payloads — only counts and IDs (ITD-008).

---

## 6. HTTP routes that change state

| Action | Effect |
|---|---|
| **POST /jobs** | One transaction: insert job + all GENERATE tasks (`CREATED`), random seed, signal relay |
| **POST …/cancel** | Job + open tasks cancelled; broadcast `job.stopped` (best-effort) |
| **DELETE /jobs/:id** | 409 if active; else delete DB row and job directory |
| **PUT /fleet** | Update desired W |
| **POST /cleanup** | Delete old partial files per retention |

Everything else is read-only or in-memory stats.

---

## 7. Outbox relay (ITD-003)

Runs on a timer and when the coordinator signals.

1. Compute **budget**: about `(2 × consumers) − messages already ready` on `dm.tasks` (via passive declare), capped by `RELAY_BATCH`.
2. Pick up to **budget** tasks in **`CREATED`**: **round-robin across jobs** (one task per job per round), and for each job prefer **MERGE before GENERATE**, **deeper level first**, then earlier `created_at, id`.
3. Build task JSON (paths from API path helper), **publish with confirm**.
4. Mark tasks **`PUBLISHED`**.

If publish fails, transaction rolls back — tasks stay `CREATED`.

**Orphan `PUBLISHED`:** if the broker lost the message, reset to `CREATED` on startup (when management API reports 0 ready and 0 unacked) or when stale with no worker busy on that task (ITD-003).

---

## 8. Worker

- **One task at a time** (`prefetch=1`). Ack only after result is published.
- **GENERATE:** seeded random uint8 file(s); temp file then rename.
- **MERGE:** sum up to 5 inputs (mmap one at a time); final task divides by F and writes result CSV + npy.
- Listens for **job.stopped**; skips and acks those tasks.
- **Broker error after startup** → exit; supervisor restarts (ITD-005).
- **2 s heartbeat** is for the UI only (ITD-005).

Task work runs off the AMQP thread so slow jobs do not block connection heartbeats.

---

## 9. Supervisor

- Polls **GET /fleet** and spawns or stops worker processes to match **desired W**.
- Restarts workers that exit with error (backoff).
- Scale-down: stop **idle** workers first, then newer busy ones; let them finish current task.
- On shutdown: SIGTERM workers, wait, then kill if needed.

Workers never call Postgres; only the supervisor calls the API for fleet size.

---

## 10. HTTP API

| Method | Path | Success | Typical errors |
|---|---|---|---|
| POST | `/jobs` | 201 + estimate | 400 |
| GET | `/jobs`, `/jobs/:id`, `/jobs/:id/tasks`, `/jobs/:id/task-graph` | 200 | 404 |
| GET | `/jobs/:id/inputs/:index.csv`, `…/partials/:taskId.csv`, `…/result.csv`, `…/result.npy` | 200 | 404, 409 |
| POST | `/jobs/:id/cancel` | 202 | 404, 409 |
| DELETE | `/jobs/:id` | 204 | 404, 409 |
| GET/PUT | `/fleet` | 200 | 400 |
| POST | `/fleet/prune-dead`, `/cleanup` | 200 | — |
| GET | `/stats`, `/events`, `/health` | 200 / 503 | — |

### 10.1 Job JSON and estimates

- **progress.generation** = `generated_files / file_count`
- **progress.reduction** (while reducing): from count of pool **rows** in `READY`/`RESERVED`, not file sum
- **estimate:** input bytes ≈ file_count×values_per_file; merge task count ≈ ⌈(file_count−1)/4⌉; peak partial bytes ≈ (merge_tasks−1)×8×values_per_file
- **waiting** (stats/UI): generating, nothing done yet, no worker on this job

### 10.4 Task graph

`GET /jobs/:id/task-graph` (ITD-012). Built from **tasks** + **items**: per-task inputs/outputs, edges from `produced_by` or GENERATE file range. No extra table. UI may collapse many GENERATE nodes client-side.

Partial CSV preview uses **`produced_by`** on an input to choose which merge’s partial to download.

### Events (in memory)

Ring buffer (~500), also logged to stdout. Types include `job_created`, `job_completed`, `job_failed`, `task_retry`, `duplicate_completion`, `cleanup_ran`, worker lifecycle events, etc. Resets on API restart.

---

## 11. Files on disk

Under `DATA_DIR/jobs/{job_id}/`:

| Path | Content |
|---|---|
| `inputs/{index:06d}.npy` | uint8[C] from GENERATE |
| `partials/{task_id}.npy` | int64[C] from MERGE |
| `result.npy` / `result.csv` | Final mean from last MERGE |
| `*.tmp-*` | In-flight writes (cleaned up) |

Only the API defines these paths (ITD-008).

---

## 12. Cleanup

On interval and on **POST /cleanup**: for finished jobs past retention, delete **partial** files and mark partial items **DELETED**. Inputs and results stay until **DELETE /jobs/:id**. Optional `?force=true` uses zero retention.

---

## 13. Configuration

### API (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP |
| `DATABASE_URL` | local postgres URL | Postgres |
| `AMQP_URL` | local amqp | RabbitMQ |
| `RABBITMQ_MGMT_URL` | local management | Queue stats for `/stats` and orphan reconcile |
| `DATA_DIR` | *(required, absolute)* | Shared files |
| `MAX_ATTEMPTS` | 3 | Per-task retries |
| `RELAY_INTERVAL_MS` | 200 | Relay poll |
| `RELAY_BATCH` | 500 | Max tasks per relay tx |
| `DISPATCH_QUEUE_FACTOR` | 2 | Target ready tasks per worker |
| `WORKER_COUNT` | 4 | Default W until PUT /fleet (ITD-014) |
| `CLEANUP_INTERVAL_MS` | 600000 | Cleanup period |
| `PARTIAL_RETENTION_MS` | 3600000 | Partial file retention |
| `WORKER_STALE_MS` / `WORKER_PRUNE_MS` | 10s / 60s | UI worker list |
| `EVENT_BUFFER_SIZE` | 500 | Event ring |
| `PUBLISHED_STALE_MS` | 120000 | Reconcile stuck PUBLISHED (ITD-003) |

### Worker / supervisor

| Variable | Default | Meaning |
|---|---|---|
| `AMQP_URL`, `DATA_DIR` | same as API | |
| `API_URL` | http://localhost:3000 | Fleet poll |
| `WORKER_COUNT` | 4 | Initial W before first poll |
| `FLEET_POLL_INTERVAL_S` | 1.5 | Fleet poll |
| `HEARTBEAT_INTERVAL_S` | 2 | UI heartbeat |
| `AMQP_HEARTBEAT_S` | 10 | Broker heartbeat |
| `DRAIN_TIMEOUT_S` | 900 | Supervisor shutdown wait |

### Fixed by design

| Constant | Value |
|---|---|
| Max files per task | 5 |
| GENERATE batch size | 5 |
| Random values | integers 0–100 (IPD-003) |
| Task queue delivery limit | 3 |
| Consumer timeout | 15 min |

Implementation details (SQL, pseudocode, parsers): **code-map** and source trees under `api/`, `worker/`, `contracts/`.

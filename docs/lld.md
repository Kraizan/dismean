# Low-level design

**Updated:** 2026-10-25 · [HLD](hld.md) · [Design doc](design-doc.md) · [ITDs](decisions/itd.md)

## 1. Repository layout

```
api/
  src/
    server.ts            Express app, startup and shutdown
    config.ts            env parsing (zod)
    paths.ts             the only place file paths are built (ITD-028)
    db/                  pool, migrations runner, queries
    mq/                  amqplib connection, topology check, publish helpers
    messages.ts          zod parsers for every message type
    routes/              jobs, cleanup, stats, events, health
    coordinator/         consumer, handlers, scheduler
    relay/               outbox relay
    cleanup/             cleanup sweep
    stats/               heartbeat consumer, worker list, event buffer, snapshot
    storage/             CSV streaming, deletes
  migrations/            NNN_description.sql, applied in order at startup
  test/
worker/
  src/dismean_worker/
    worker.py            AMQP loop, dispatch, heartbeats, drain
    supervisor.py        spawns and restarts W workers
    tasks/generate.py
    tasks/merge.py
    storage.py           atomic writes
    messages.py          TypedDicts + required-key checks (ITD-025)
    config.py
  tests/
contracts/
  examples/              one canonical JSON per message type and variant; parsed by both test suites
infra/
  rabbitmq/definitions.json   full broker topology, loaded at broker start (ITD-023)
  rabbitmq/rabbitmq.conf      load_definitions = /etc/rabbitmq/definitions.json
docs/
data/                    DATA_DIR default (gitignored)
docker-compose.yml
```

## 2. Database schema (Postgres 16)

```sql
CREATE TYPE job_status  AS ENUM ('GENERATING', 'REDUCING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE task_kind   AS ENUM ('GENERATE', 'MERGE');
CREATE TYPE task_status AS ENUM ('CREATED', 'PUBLISHED', 'DONE', 'FAILED', 'CANCELLED');
CREATE TYPE item_kind   AS ENUM ('INPUT', 'PARTIAL');
CREATE TYPE item_state  AS ENUM ('READY', 'RESERVED', 'CONSUMED', 'DELETED');

CREATE TABLE jobs (
  id                       uuid PRIMARY KEY,
  f                        integer NOT NULL CHECK (f BETWEEN 2 AND 99999),
  c                        integer NOT NULL CHECK (c BETWEEN 2 AND 999999),
  status                   job_status NOT NULL DEFAULT 'GENERATING',
  seed                     bigint NOT NULL CHECK (seed >= 0),   -- RNG seed; makes the job reproducible
  generated_files          integer NOT NULL DEFAULT 0,
  failure_reason           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  generation_completed_at  timestamptz,
  finished_at              timestamptz,                     -- COMPLETED / FAILED / CANCELLED
  partials_cleaned_at      timestamptz
);

CREATE TABLE tasks (
  id            uuid PRIMARY KEY,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind          task_kind NOT NULL,
  status        task_status NOT NULL DEFAULT 'CREATED',
  attempt       smallint NOT NULL DEFAULT 1,
  level         smallint NOT NULL,          -- GENERATE: 0; MERGE: 1 + max(input level)
  file_start    integer,                    -- GENERATE only
  file_count    smallint,                   -- GENERATE only, 1..5
  input_count   integer,                    -- MERGE only: sum of input item counts
  is_final      boolean NOT NULL DEFAULT false,
  worker_id     text,
  duration_ms   integer,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  completed_at  timestamptz
);
CREATE INDEX tasks_outbox   ON tasks (created_at) WHERE status = 'CREATED';
CREATE INDEX tasks_job_open ON tasks (job_id, kind) WHERE status IN ('CREATED', 'PUBLISHED');

CREATE TABLE items (
  id           uuid PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind         item_kind NOT NULL,
  state        item_state NOT NULL DEFAULT 'READY',
  count        integer NOT NULL,            -- number of input files this item covers
  level        smallint NOT NULL,           -- INPUT: 0; PARTIAL: level of the producing MERGE
  path         text NOT NULL,               -- relative to DATA_DIR, built by paths.ts
  produced_by  uuid,                        -- task id (PARTIAL only)
  reserved_by  uuid,                        -- MERGE task id that will consume it
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_pool     ON items (job_id, created_at, id) WHERE state = 'READY';
CREATE INDEX items_reserved ON items (reserved_by) WHERE state = 'RESERVED';

CREATE TABLE fleet (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  desired_workers smallint NOT NULL DEFAULT 4 CHECK (desired_workers BETWEEN 1 AND 32),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

Worker state and the event log are kept in API memory, not in the database (ITD-024, §10.3).

**Invariant (checked in tests):** for every job in `REDUCING`, `SUM(count) WHERE state IN ('READY','RESERVED') = f`.

## 3. RabbitMQ topology

All objects are declared in `infra/rabbitmq/definitions.json` and loaded when the broker starts (ITD-023). The file also declares the `guest` user and `/` permissions, because `load_definitions` disables the default user seed. Use only `load_definitions` in `rabbitmq.conf` (not `management.load_definitions` on the same file — concurrent import can hang boot). At startup the API and workers check their queues and exchanges exist (passive declare) and exit with a clear error if they don't. The only objects created at runtime are the per-worker exclusive control queues.

| Name | Kind | Arguments / bindings |
|---|---|---|
| `dm.tasks` | direct exchange | routes key `task` to queue `dm.tasks` |
| `dm.tasks` | queue | `x-queue-type=quorum`, `x-delivery-limit=3`, `x-dead-letter-exchange=dm.dlx`, `x-consumer-timeout=900000`. Two priority levels are built in (ITD-020) |
| `dm.dlx` | fanout exchange | goes to `dm.tasks.dead` |
| `dm.tasks.dead` | queue | quorum, durable |
| `dm.events` | topic exchange | `task.completed` and `task.failed` go to `dm.coordinator`; `worker.heartbeat` goes to `dm.heartbeats` |
| `dm.coordinator` | queue | quorum, `x-delivery-limit=1000000` (coordinator never nacks in normal operation, see §5.1) |
| `dm.heartbeats` | queue | classic, `x-message-ttl=10000`, `x-max-length=10000`, `x-overflow=drop-head` |
| `dm.control` | fanout exchange | goes to one server-named, exclusive, auto-delete queue per worker |

**Message properties:**
- Task and event messages: `content_type=application/json`, `delivery_mode=2` (persistent).
- Task messages also carry `message_id = "{task_id}:{attempt}"` and **`priority`**: `9` for MERGE (high), `0` for GENERATE (normal).

Broker behaviours still to verify, with their fallbacks: [open-questions.md](open-questions.md) V-1 to V-4.

## 4. Message contracts (v1)

The LLD is the written spec. `contracts/examples/` holds one canonical example per type and variant, and both test suites parse every example (ITD-025). Every path is relative to `DATA_DIR` and built only by the API (ITD-028).

### 4.1 Task (exchange `dm.tasks`, consumed by workers)

```json
{
  "schema_version": 1,
  "task_id": "uuid",
  "job_id": "uuid",
  "attempt": 1,
  "kind": "GENERATE",
  "c": 1000,
  "generate": {
    "seed": 8231947712,
    "file_indices": [0, 1, 2, 3, 4],
    "output_paths": ["jobs/<job>/inputs/000000.npy", "…"]
  }
}
```

```json
{
  "schema_version": 1,
  "task_id": "uuid",
  "job_id": "uuid",
  "attempt": 1,
  "kind": "MERGE",
  "c": 1000,
  "merge": {
    "inputs": [{ "item_id": "uuid", "path": "jobs/<job>/inputs/000000.npy", "count": 1 }],
    "output_path": "jobs/<job>/partials/<task_id>.npy",
    "final": false,
    "total_count": null,
    "result_paths": null
  }
}
```

For the final merge: `"final": true`, `"total_count": F`, `"output_path": null`, and `"result_paths": {"npy": "jobs/<job>/result.npy", "csv": "jobs/<job>/result.csv"}`. Limits: `1 ≤ len(file_indices) ≤ 5`, `2 ≤ len(inputs) ≤ 5`.

### 4.2 Task completed (routing key `task.completed`)

```json
{
  "schema_version": 1,
  "task_id": "uuid",
  "job_id": "uuid",
  "attempt": 1,
  "kind": "MERGE",
  "worker_id": "host-2-41233",
  "duration_ms": 63,
  "output": { "count": 5 }
}
```

GENERATE reports `"output": {"files_written": 5}`. Completions carry no paths: the coordinator derives them (ITD-028).

### 4.3 Task failed (routing key `task.failed`)

```json
{
  "schema_version": 1,
  "task_id": "uuid",
  "job_id": "uuid",
  "attempt": 1,
  "kind": "MERGE",
  "worker_id": "host-2-41233",
  "error": { "type": "FileNotFoundError", "message": "…" }
}
```

### 4.4 Worker heartbeat (routing key `worker.heartbeat`)

```json
{
  "schema_version": 1,
  "worker_id": "host-2-41233",
  "hostname": "host",
  "pid": 41233,
  "state": "BUSY",
  "task_id": "uuid",
  "job_id": "uuid",
  "task_kind": "MERGE",
  "tasks_done": 118,
  "started_at": "2026-10-23T11:00:00Z",
  "sent_at": "2026-10-23T11:05:02Z"
}
```

`state` is one of `IDLE | BUSY | STOPPING | STOPPED`. `STOPPED` is sent once on a graceful exit.

### 4.5 Job stopped (exchange `dm.control`)

```json
{ "schema_version": 1, "type": "job.stopped", "job_id": "uuid", "status": "CANCELLED" }
```

## 5. Coordinator

A single consumer on `dm.coordinator` and `dm.tasks.dead`, with `prefetch=50`. Messages are **handled one at a time**, and each is acked only after its transaction commits. Events are pushed to the in-memory buffer after commit.

### 5.1 Error handling (ITD-022)

| Error | Action |
|---|---|
| Message fails zod parsing | Log + event `invalid_message`, ack |
| DB connection or availability error | Roll back. Keep the message **unacked** and retry handling it in-process with backoff (1 s, doubling, max 30 s) until the DB is back. Never nack |
| Any other exception | Roll back. In a new transaction, run `fail_job(job, "internal error: {message}")`. Ack |

### 5.2 Handlers

```text
handle(msg):
  BEGIN
    job := SELECT * FROM jobs WHERE id = msg.job_id FOR UPDATE
    if job is null or job.status not in (GENERATING, REDUCING):
        COMMIT; ack; event ignored_inactive_job; return
    route: task.completed → on_completed | task.failed → on_failed | dead-letter → on_dead
  COMMIT
  ack
  after commit: push events; signal relay if tasks were created; publish job.stopped if the job was stopped

on_completed(job, msg):
  task := UPDATE tasks SET status='DONE', completed_at=now(), worker_id=msg.worker_id, duration_ms=msg.duration_ms
          WHERE id = msg.task_id AND status IN ('CREATED','PUBLISHED') RETURNING *
  if task is null: event duplicate_completion; return
  if task.kind = GENERATE:
      job.generated_files := UPDATE jobs SET generated_files = generated_files + task.file_count RETURNING generated_files
      if job.generated_files = job.f: barrier(job)
  else:
      UPDATE items SET state='CONSUMED' WHERE reserved_by = task.id
      if task.is_final:
          UPDATE jobs SET status='COMPLETED', finished_at=now(); event job_completed
      else:
          INSERT INTO items (kind='PARTIAL', count=task.input_count, level=task.level,
                             path=paths.partialPath(job.id, task.id), produced_by=task.id, state='READY')
          schedule(job)

barrier(job):
  UPDATE jobs SET status='REDUCING', generation_completed_at=now()
  INSERT INTO items (id, job_id, kind, count, level, path, state)
    SELECT gen_random_uuid(), job.id, 'INPUT', 1, 0, $input_prefix || lpad(i::text, 6, '0') || '.npy', 'READY'
    FROM generate_series(0, job.f - 1) AS i          -- $input_prefix = paths.inputPrefix(job.id)
  create_leaf_merges(job)                             -- set-based, §5.3
  schedule(job)                                       -- handles the 0–4 leftover items
  event generation_completed

schedule(job):
  loop:
    ready := SELECT id, count, level FROM items
             WHERE job_id = job.id AND state = 'READY'
             ORDER BY created_at, id LIMIT 5
    if len(ready) = 5:                                   create_merge(job, ready)
    elif len(ready) >= 2 and open_merges(job) = 0:       create_merge(job, ready)
    else: break

open_merges(job) := SELECT count(*) FROM tasks
                    WHERE job_id = job.id AND kind = 'MERGE' AND status IN ('CREATED','PUBLISHED')

create_merge(job, items):
  total := Σ items.count
  task  := INSERT INTO tasks (kind='MERGE', level=1+max(items.level), input_count=total,
                              is_final=(total = job.f), status='CREATED')
  UPDATE items SET state='RESERVED', reserved_by=task.id WHERE id = ANY(items.ids)

on_failed(job, msg):
  task := SELECT * FROM tasks WHERE id = msg.task_id AND attempt = msg.attempt
          AND status IN ('CREATED','PUBLISHED') FOR UPDATE
  if task is null: event stale_failure; return
  if task.attempt < MAX_ATTEMPTS:
      UPDATE tasks SET attempt = attempt + 1, status = 'CREATED', last_error = msg.error.message
      event task_retry                  -- the relay republishes it; MERGE inputs stay RESERVED
  else:
      UPDATE tasks SET status = 'FAILED', last_error = msg.error.message WHERE id = task.id
      fail_job(job, "task {id} failed {MAX_ATTEMPTS} times: {error}")

on_dead(job, task_msg):               -- from dm.tasks.dead (delivery limit exceeded)
  task := SELECT … WHERE id = task_msg.task_id AND status IN ('CREATED','PUBLISHED')
  if task is null: return             -- another copy already finished it
  event task_dead_lettered
  UPDATE tasks SET status = 'FAILED', last_error = 'delivery limit exceeded' WHERE id = task.id
  fail_job(job, "task {id} exceeded delivery limit (worker crash loop)")

fail_job(job, reason):
  UPDATE jobs SET status='FAILED', failure_reason=reason, finished_at=now()
  UPDATE tasks SET status='CANCELLED' WHERE job_id = job.id AND status IN ('CREATED','PUBLISHED')
  event job_failed; publish job.stopped after commit
```

### 5.3 Leaf merges at the barrier (set-based)

Creating ⌊F/5⌋ merges one loop iteration at a time is too slow for F = 100k (about 60k statements in one transaction). Instead:

```sql
WITH numbered AS (
  SELECT id, (row_number() OVER (ORDER BY path) - 1) / 5 AS grp
  FROM items WHERE job_id = $job AND state = 'READY'
), groups AS (                                  -- volatile CTE is materialized: one uuid per group
  SELECT grp, gen_random_uuid() AS task_id
  FROM numbered GROUP BY grp HAVING count(*) = 5
), ins AS (
  INSERT INTO tasks (id, job_id, kind, level, input_count, is_final)
  SELECT task_id, $job, 'MERGE', 1, 5, (5 = $f) FROM groups
)
UPDATE items i SET state = 'RESERVED', reserved_by = g.task_id
FROM numbered n JOIN groups g USING (grp)
WHERE i.id = n.id;
```

`ORDER BY path` groups consecutive files. The 0–4 leftover items stay `READY` for `schedule()`. When F = 5, the single group is already final. When F < 5, `schedule()` creates the final merge.

### 5.4 Lock order

The coordinator locks the job row first, then task and item rows. The relay locks only task rows (`SKIP LOCKED`), so the two can't deadlock.

## 6. Routes that write

### 6.1 Create (`POST /jobs`)

The job and all its GENERATE tasks are created in one statement:

```sql
WITH j AS (
  INSERT INTO jobs (id, f, c, seed) VALUES ($id, $f, $c, $seed) RETURNING id, f
)
INSERT INTO tasks (id, job_id, kind, level, file_start, file_count)
SELECT gen_random_uuid(), j.id, 'GENERATE', 0, s, LEAST(5, j.f - s)
FROM j, generate_series(0, j.f - 1, 5) AS s;
```

`seed` is a random non-negative 63-bit integer. After commit: signal the relay, and push the event `job_created`.

### 6.2 Cancel (`POST /jobs/:id/cancel`) and delete (`DELETE /jobs/:id`)

```text
cancel: tx { lock job; 409 unless GENERATING/REDUCING; status CANCELLED, finished_at;
             open tasks → CANCELLED }  → publish job.stopped → event job_cancelled
delete: 409 if active; rm -rf DATA_DIR/jobs/{id}; DELETE FROM jobs (cascades) → event job_deleted
```

`job.stopped` is published by whoever stopped the job (this route, or `fail_job` in the coordinator), right after commit. It's best-effort (ITD-013).

## 7. Outbox relay

```text
every RELAY_INTERVAL_MS, or immediately when the coordinator or routes signal new tasks:
  BEGIN
    rows := SELECT * FROM tasks WHERE status = 'CREATED'
            ORDER BY created_at LIMIT RELAY_BATCH FOR UPDATE SKIP LOCKED
    for MERGE rows: inputs := SELECT id, path, count FROM items WHERE reserved_by = row.id
                    output_path := paths.partialPath(job, row.id) unless final; result_paths := paths.resultPaths(job) if final
    for GENERATE rows: output_paths := paths.inputPath(job, i) for i in [file_start, file_start + file_count)
    publish each TaskMessage to dm.tasks on a confirm channel, priority 9 (MERGE) or 0 (GENERATE)
    await all confirms                 -- a nack or timeout throws: ROLLBACK, retry next tick
    UPDATE tasks SET status='PUBLISHED', published_at=now()
    WHERE id = ANY(ids) AND status = 'CREATED'
  COMMIT
```

A crash after publishing but before commit republishes the batch (at-least-once). The duplicates are harmless (ITD-009).

## 8. Worker

### 8.1 Threads

- **Main thread:** pika `BlockingConnection` (AMQP heartbeat 10 s), consumers, publishing, acks, heartbeat timer. It never blocks on task work.
- **Task thread:** a `ThreadPoolExecutor(max_workers=1)` runs the NumPy work. Its result returns to the main thread via `connection.add_callback_threadsafe`.

### 8.2 Loop

```text
start:
  connect (retry with backoff while the broker is unreachable; startup only)
  channel.confirm_delivery(); channel.basic_qos(prefetch_count=1)
  passive-declare dm.tasks, dm.events, dm.control   → missing: log "topology not loaded" and exit(1)
  declare an exclusive control queue bound to dm.control; consume with auto_ack → stopped_jobs.add(job_id)
  consume dm.tasks (manual ack) → on_task
  call_later(HEARTBEAT_INTERVAL_S, send_heartbeat)   (re-arms itself)
  SIGTERM → draining = true; basic_cancel(tasks consumer); exit 0 once idle
  any channel or connection error after startup → log and exit(1); the supervisor restarts (ITD-021)

on_task(delivery):
  msg := parse + required-key check  → invalid: publish task.failed if task_id is present, else log; ack
  if msg.job_id in stopped_jobs: ack; return
  state := BUSY; submit run_task(msg) → on_done(delivery, msg, result | error)

on_done (main thread):
  publish task.completed or task.failed to dm.events (confirmed)
  if the publish fails: exit(1)          -- unacked message is redelivered; the coordinator dedupes
  basic_ack
  state := IDLE; tasks_done += 1 on success
  if draining: send STOPPED heartbeat, close, exit 0
```

### 8.3 Task implementations

```python
def run_generate(msg):
    g = msg["generate"]
    for idx, rel in zip(g["file_indices"], g["output_paths"]):
        rng = np.random.default_rng([g["seed"], idx])
        arr = rng.integers(0, 101, size=msg["c"], dtype=np.uint8)   # [0, 100] inclusive
        atomic_save_npy(DATA_DIR / rel, arr)

def run_merge(msg):
    m = msg["merge"]
    acc = np.zeros(msg["c"], dtype=np.int64)
    for inp in m["inputs"]:                       # ≤5 inputs, one memory-mapped at a time
        arr = np.load(DATA_DIR / inp["path"], mmap_mode="r")
        if arr.shape != (msg["c"],):
            raise ValueError(f"bad shape {arr.shape} for {inp['path']}")
        acc += arr
        del arr
    if m["final"]:
        mean = acc / m["total_count"]             # the only float operation
        atomic_save_npy(DATA_DIR / m["result_paths"]["npy"], mean)
        atomic_save_csv(DATA_DIR / m["result_paths"]["csv"], mean)   # one line, '%.8f', comma-separated
    else:
        atomic_save_npy(DATA_DIR / m["output_path"], acc)

def atomic_save_npy(path, arr):                   # no fsync (ITD-026)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{uuid4().hex}")
    with open(tmp, "wb") as f:
        np.save(f, arr)
    os.replace(tmp, path)
```

## 9. Supervisor

```text
seed target W from WORKER_COUNT; poll GET /fleet every FLEET_POLL_INTERVAL_S (1.5 s)
scale up: spawn `python -m dismean_worker.worker` for new slots 0..W-1
scale down: send SIGTERM to slots >= W so they stop consuming, finish in-flight work, and exit 0
every 0.5 s: reap children; restart any slot < W that exited non-zero (per-slot exponential backoff capped at 30 s)
SIGTERM/SIGINT: forward SIGTERM to all; wait up to DRAIN_TIMEOUT_S; then SIGKILL the rest; exit
```

## 10. HTTP API

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| `POST` | `/jobs` | `{ "f": int, "c": int }` | `201` job + `estimate` | `400` validation |
| `GET` | `/jobs` | `?status=&limit=50&offset=0` | `200 { jobs: Job[] }` | — |
| `GET` | `/jobs/:id` | — | `200` job + progress + task counts | `404` |
| `POST` | `/jobs/:id/cancel` | — | `202` job | `404`, `409` if finished |
| `DELETE` | `/jobs/:id` | — | `204` (deletes rows and `DATA_DIR/jobs/:id`) | `404`, `409` if active |
| `GET` | `/jobs/:id/result.csv` | — | `200 text/csv` | `404`, `409` if not completed |
| `GET` | `/jobs/:id/result.npy` | — | `200 application/octet-stream` | `404`, `409` |
| `GET` | `/jobs/:id/inputs/:index.csv` | — | `200 text/csv` (one line) | `404` if not generated |
| `GET` | `/fleet` | — | `200 { desired_workers, updated_at, workers }` | — |
| `PUT` | `/fleet` | `{ "desired_workers": 1..32 }` | `200 { desired_workers, updated_at, workers }` | `400` validation |
| `POST` | `/cleanup` | — | `200 { jobs_cleaned, files_deleted, bytes_freed }` | — |
| `GET` | `/stats` | — | `200` stats snapshot (polled every 1 s by the UI) | — |
| `GET` | `/events` | `?after_id=&limit=100` | `200 { events: Event[] }` from the in-memory buffer | — |
| `GET` | `/health` | — | `200 { db: "ok", amqp: "ok" }` | `503` |

### 10.1 Job response

```json
{
  "id": "uuid", "f": 12, "c": 1000, "status": "REDUCING", "seed": 8231947712,
  "generated_files": 12, "failure_reason": null,
  "created_at": "…", "generation_completed_at": "…", "finished_at": null,
  "progress": { "generation": 1.0, "reduction": 0.36 },
  "tasks": { "GENERATE": { "DONE": 3 }, "MERGE": { "DONE": 2, "PUBLISHED": 1 } },
  "timings_ms": { "generation": 410, "reduction": null, "total": null },
  "estimate": { "input_bytes": 12000, "peak_partial_bytes": 16000, "generate_tasks": 3, "merge_tasks": 3 }
}
```

- `progress.generation = generated_files / f`.
- `progress.reduction`: 0 while `GENERATING`; `1 − (live − 1)/(f − 1)` while `REDUCING`, where `live` counts items that are `READY` or `RESERVED`; 1 once `COMPLETED`.
- `estimate`: `input_bytes = f·c`; `merge_tasks = ⌈(f−1)/4⌉`; `peak_partial_bytes = (merge_tasks − 1)·8c` (all partials are kept until cleanup); `.npy` headers are ignored.

### 10.2 Stats snapshot

```json
{
  "at": "…",
  "workers": { "total": 4, "idle": 1, "busy": 3, "stopping": 0, "dead": 0,
               "list": [{ "id": "…", "state": "BUSY", "task_id": "…", "job_id": "…", "task_kind": "MERGE",
                          "tasks_done": 118, "last_heartbeat_at": "…" }] },
  "queue": { "tasks_ready": 120, "tasks_unacked": 3, "coordinator_backlog": 0, "tasks_dead": 0 },
  "outbox_pending": 0,
  "jobs": { "WAITING": 1, "GENERATING": 1, "REDUCING": 1, "COMPLETED": 5, "FAILED": 0, "CANCELLED": 0 },
  "throughput": { "tasks_per_sec_1m": 5.7, "avg_ms_1m": { "GENERATE": 40, "MERGE": 65 } },
  "active_jobs": [{ "id": "…", "f": 12, "c": 1000, "status": "REDUCING", "waiting": false,
                    "progress": { "generation": 1, "reduction": 0.36 } }]
}
```

| Field | Source |
|---|---|
| `workers` | In-memory list (§10.3) |
| `queue.*` | RabbitMQ management API, `GET /api/queues/%2F/{name}` (`messages_ready`, `messages_unacknowledged`) |
| `jobs`, `outbox_pending`, `throughput`, `active_jobs` | SQL. `throughput` uses `tasks.completed_at` and `duration_ms` over the last minute |
| `WAITING` / `waiting` | A display-only view of `GENERATING` jobs: no task `DONE` and no busy worker currently on the job. `WAITING` is not a DB status. `jobs.GENERATING` counts only non-waiting jobs |

### 10.3 In-memory observability (ITD-024)

- **Workers:** `Map<worker_id, Heartbeat & {last_heartbeat_at}>`, updated by an auto-ack consumer on `dm.heartbeats`.
  - Shown as `dead` when there's no heartbeat for `WORKER_STALE_MS`.
  - Removed after `WORKER_PRUNE_MS`, or as soon as it reports `STOPPED`.
- **Events:** a ring buffer of `EVENT_BUFFER_SIZE` entries `{id, at, type, job_id?, task_id?, worker_id?, message}`.
  - `id` is a counter that only increases; `GET /events?after_id=` returns newer entries.
  - Every event is also written as one JSON line to stdout.
- **Event types:** `job_created`, `generation_completed`, `job_completed`, `job_failed`, `job_cancelled`, `job_deleted`, `task_retry`, `task_dead_lettered`, `duplicate_completion`, `stale_failure`, `ignored_inactive_job`, `invalid_message`, `worker_started`, `worker_stopped`, `worker_dead`, `cleanup_ran`.
  - `worker_started`, `worker_stopped` and `worker_dead` come from changes in the worker list.

## 11. File layout

Built only by `api/src/paths.ts` (ITD-028).

```
DATA_DIR/
  jobs/{job_id}/
    inputs/{index:06d}.npy     uint8[C]     written by GENERATE
    partials/{task_id}.npy     int64[C]     written by a non-final MERGE
    result.npy                 float64[C]   written by the final MERGE
    result.csv                 one line, C values, '%.8f'
    *.tmp-*                    in-flight atomic writes (swept by cleanup)
```

## 12. Cleanup sweep

```text
every CLEANUP_INTERVAL_MS, and on POST /cleanup:
  jobs := SELECT id FROM jobs
          WHERE status IN ('COMPLETED','FAILED','CANCELLED')
            AND finished_at < now() - PARTIAL_RETENTION_MS
            AND partials_cleaned_at IS NULL
  for each job:
    delete DATA_DIR/jobs/{id}/partials/ and any *.tmp-* files under the job directory
    UPDATE items SET state='DELETED' WHERE job_id = id AND kind = 'PARTIAL'
    UPDATE jobs SET partials_cleaned_at = now() WHERE id = id
  event cleanup_ran { jobs_cleaned, files_deleted, bytes_freed }
```

## 13. Configuration

**API**

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgres://dismean:dismean@localhost:5432/dismean` | Postgres |
| `AMQP_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ |
| `RABBITMQ_MGMT_URL` | `http://guest:guest@localhost:15672` | Management API for queue stats |
| `DATA_DIR` | *(required, absolute)* | Shared file root |
| `MAX_ATTEMPTS` | `3` | Clean-failure attempts per task |
| `RELAY_INTERVAL_MS` | `200` | Outbox poll interval |
| `RELAY_BATCH` | `500` | Tasks per relay transaction |
| `CLEANUP_INTERVAL_MS` | `600000` | Cleanup sweep interval |
| `PARTIAL_RETENTION_MS` | `3600000` | Age after which partials of finished jobs are deleted |
| `WORKER_STALE_MS` | `10000` | Heartbeat age after which a worker is shown as dead |
| `WORKER_PRUNE_MS` | `60000` | Heartbeat age after which a worker is removed from the list |
| `EVENT_BUFFER_SIZE` | `500` | In-memory event log size |

**Worker / supervisor**

| Env var | Default | Meaning |
|---|---|---|
| `AMQP_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ |
| `DATA_DIR` | *(required, absolute)* | Shared file root |
| `WORKER_COUNT` | `4` | W, read by the supervisor at startup |
| `HEARTBEAT_INTERVAL_S` | `2` | Observability heartbeat interval |
| `AMQP_HEARTBEAT_S` | `10` | AMQP connection heartbeat |
| `DRAIN_TIMEOUT_S` | `900` | Supervisor's wait for workers to drain on shutdown |

**Constants (in code or definitions.json, not configurable)**

| Constant | Value | Why fixed |
|---|---|---|
| `MAX_FILES_PER_TASK` | `5` | Problem constraint |
| `GENERATE_BATCH` | `5` | ITD-007 |
| Value range | `[0, 100]` integers | IPD-003 |
| Task priority | MERGE `9`, GENERATE `0` | ITD-020 |
| `x-delivery-limit` on `dm.tasks` | `3` | ITD-010 |
| `x-consumer-timeout` on `dm.tasks` | `900000` ms | ITD-008 |

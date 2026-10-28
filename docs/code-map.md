# Code map

**Updated:** 2026-10-28

Onboarding index: every tracked source path → what it does. **System behaviour (flows, schema, API)** is in [lld.md](lld.md); **file-level implementation** is here and in source. Update this table when you add or rename paths.

**Read order:** [design-doc](design-doc.md) → [HLD](hld.md) → [LLD](lld.md) → this map.

---

## Root and infrastructure

| Path | Role | LLD / other |
|---|---|---|
| [README.md](../README.md) | Quick start, test commands | — |
| [AGENTS.md](../AGENTS.md) | Rules for humans and agents in this repo | — |
| [CLAUDE.md](../CLAUDE.md) | Pointer to AGENTS.md | — |
| [docker-compose.yml](../docker-compose.yml) | Local Postgres 16 + RabbitMQ 4 | [HLD § deployment](hld.md) |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | CI: install, test, lint | [design-doc § tests](design-doc.md) |
| [infra/rabbitmq/definitions.json](../infra/rabbitmq/definitions.json) | Exchanges, queues, bindings, `guest` user (ITD-011) | [LLD §3](lld.md#3-rabbitmq-topology) |
| [infra/rabbitmq/rabbitmq.conf](../infra/rabbitmq/rabbitmq.conf) | `load_definitions` path | [LLD §3](lld.md#3-rabbitmq-topology) |
| [data/](../data/) | `DATA_DIR` job files (gitignored) | [LLD §11](lld.md#11-files-on-disk) |

---

## API (`api/`)

### Entry, config, shared

| Path | Role | LLD |
|---|---|---|
| [api/src/server.ts](../api/src/server.ts) | Express app: migrations, AMQP, coordinator, relay, cleanup, routes, graceful shutdown | §10, §5–7, §12 |
| [api/src/config.ts](../api/src/config.ts) | Zod parse of env vars | §13 |
| [api/src/paths.ts](../api/src/paths.ts) | **Only** builder for job/input/partial/result paths (ITD-008) | §11 |
| [api/src/messages.ts](../api/src/messages.ts) | Zod schemas for queue payloads | §4 |
| [api/src/events.ts](../api/src/events.ts) | In-memory ring buffer for `GET /events` polling | §10 |

### Database

| Path | Role | LLD |
|---|---|---|
| [api/src/db/pool.ts](../api/src/db/pool.ts) | Postgres pool; `isDbAvailabilityError` for coordinator retry | §2 |
| [api/src/db/migrate.ts](../api/src/db/migrate.ts) | Apply `migrations/*.sql` at startup | §2 |
| [api/src/db/types.ts](../api/src/db/types.ts) | Row types for jobs, tasks, items, fleet | §2 |
| [api/migrations/001_init.sql](../api/migrations/001_init.sql) | Core schema: jobs, tasks, pool items, outbox columns | §2 |
| [api/migrations/002_fleet.sql](../api/migrations/002_fleet.sql) | `fleet` table for desired W | §2, §10 |
| [api/migrations/003_fleet_source.sql](../api/migrations/003_fleet_source.sql) | `set_by_api` so `WORKER_COUNT` seeds until `PUT /fleet` | §13 |
| [api/migrations/004_rename_job_f_c.sql](../api/migrations/004_rename_job_f_c.sql) | Rename `jobs.f` / `jobs.c` → `file_count` / `values_per_file` on upgrade | §2 |

### Message queue

| Path | Role | LLD |
|---|---|---|
| [api/src/mq/connection.ts](../api/src/mq/connection.ts) | Connect, passive topology check, publish tasks/control, **exit on broker loss** (ITD-005) | §3, §4 |

### Coordinator (single consumer, one txn per message)

| Path | Role | LLD |
|---|---|---|
| [api/src/coordinator/index.ts](../api/src/coordinator/index.ts) | Consume `dm.coordinator` + `dm.tasks.dead`; ack after commit; relay wake (`RELAY_SIGNAL`) | §5 |
| [api/src/coordinator/handlers.ts](../api/src/coordinator/handlers.ts) | `task.completed` / `task.failed` / dead-letter routing | §5 |
| [api/src/coordinator/scheduler.ts](../api/src/coordinator/scheduler.ts) | Generation barrier; dynamic pool MERGE scheduling | §5, [reduction walkthrough](diagrams/reduction-walkthrough.md) |
| [api/src/coordinator/failJob.ts](../api/src/coordinator/failJob.ts) | Mark job FAILED; cancel tasks; emit events after commit | §5 |

### Outbox relay

| Path | Role | LLD |
|---|---|---|
| [api/src/relay/index.ts](../api/src/relay/index.ts) | Fair-share dispatch: budget from queue depth, round-robin jobs, MERGE before GENERATE (ITD-003) | §7 |
| [api/src/relay/reconcilePublished.ts](../api/src/relay/reconcilePublished.ts) | Reset orphaned `PUBLISHED` tasks (ITD-003) | §7 |
| [api/src/mq/queueStats.ts](../api/src/mq/queueStats.ts) | RabbitMQ management API depth (`ready`, `unacked`) for `reconcilePublished` | §7 |

### HTTP routes

| Path | Role | LLD |
|---|---|---|
| [api/src/routes/jobs.ts](../api/src/routes/jobs.ts) | Create/list/get/cancel/delete jobs; task-graph; stream result, inputs, partials | §6, §10 |
| [api/src/routes/taskGraph.ts](../api/src/routes/taskGraph.ts) | Task I/O and lineage edges from `tasks` + `items` | §10 |
| [api/src/routes/jobFormat.ts](../api/src/routes/jobFormat.ts) | Job DTOs: task counts, pool stats, timings, estimates | §10 |
| [api/src/routes/fleet.ts](../api/src/routes/fleet.ts) | `GET/PUT /fleet`, prune dead workers, seed default W | §10 |
| [api/src/routes/cleanup.ts](../api/src/routes/cleanup.ts) | Manual cleanup trigger and storage stats | §12 |
| [api/src/routes/stats.ts](../api/src/routes/stats.ts) | Aggregated snapshot (jobs, queue, workers) | §10 |
| [api/src/routes/events.ts](../api/src/routes/events.ts) | `GET /events?after_id=` JSON poll | §10 |
| [api/src/routes/health.ts](../api/src/routes/health.ts) | Liveness for compose and scripts | §10 |

### Stats and observability (display-only)

| Path | Role | LLD |
|---|---|---|
| [api/src/stats/workers.ts](../api/src/stats/workers.ts) | Consume heartbeats; in-memory worker registry | §10, ITD-005 |
| [api/src/stats/snapshot.ts](../api/src/stats/snapshot.ts) | Build `/stats` payload (DB + RabbitMQ management API) | §10 |
| [api/src/stats/progress.ts](../api/src/stats/progress.ts) | Reduction progress from live pool item rows | §5 |

### Storage helpers

| Path | Role | LLD |
|---|---|---|
| [api/src/storage/csv.ts](../api/src/storage/csv.ts) | Stream CSV for downloads | §10 |
| [api/src/storage/npy.ts](../api/src/storage/npy.ts) | Stream uint8/int64 `.npy` as CSV for UI | §10 |
| [api/src/storage/deleteJobDir.ts](../api/src/storage/deleteJobDir.ts) | Remove job directory under `DATA_DIR` | §11 |

### Background cleanup

| Path | Role | LLD |
|---|---|---|
| [api/src/cleanup/index.ts](../api/src/cleanup/index.ts) | Periodic sweep: old partials, orphaned dirs | §12 |

### API tooling and config files

| Path | Role | LLD |
|---|---|---|
| [api/package.json](../api/package.json) | Dependencies and `npm test` / `npm run dev` | — |
| [api/tsconfig.json](../api/tsconfig.json) | TypeScript strict config | — |
| [api/vitest.config.ts](../api/vitest.config.ts) | Vitest + integration gate | — |
| [api/scripts/smoke-start.ts](../api/scripts/smoke-start.ts) | Short-lived API start for CI smoke | — |

### API tests

| Path | Role | LLD |
|---|---|---|
| [api/test/messages.test.ts](../api/test/messages.test.ts) | Message zod parsing | §4 |
| [api/test/contract-examples.test.ts](../api/test/contract-examples.test.ts) | Parse every `contracts/examples/*.json` | §4, ITD-013 |
| [api/test/paths.test.ts](../api/test/paths.test.ts) | Path layout vs barrier SQL | §11, ITD-008 |
| [api/test/progress.test.ts](../api/test/progress.test.ts) | Reduction progress formula | §5 |
| [api/test/npy.test.ts](../api/test/npy.test.ts) | NPY streaming | §10 |
| [api/test/taskGraph.test.ts](../api/test/taskGraph.test.ts) | Task graph I/O and edges | §10 |
| [api/test/speed-variance.test.ts](../api/test/speed-variance.test.ts) | Fair-share not starved by one job | §7, ITD-003 |
| [api/test/dispatcher.integration.test.ts](../api/test/dispatcher.integration.test.ts) | Relay cursor and fair-share SQL (`DISMEAN_INTEGRATION=1`) | §7 |
| [api/test/reconcile-published.integration.test.ts](../api/test/reconcile-published.integration.test.ts) | Reset stale `PUBLISHED` tasks when idle (`DISMEAN_INTEGRATION=1`) | §7, ITD-003 |
| [api/test/scheduler-sql.integration.test.ts](../api/test/scheduler-sql.integration.test.ts) | Pool scheduler invariants in Postgres | §5 |
| [api/test/coordinator-idempotency.integration.test.ts](../api/test/coordinator-idempotency.integration.test.ts) | Duplicate/out-of-order completions | §5, ITD-006 |
| [api/test/coordinator-scenarios.integration.test.ts](../api/test/coordinator-scenarios.integration.test.ts) | Barrier, merge tail, final result | §5 |

---

## Worker (`worker/`)

| Path | Role | LLD |
|---|---|---|
| [worker/pyproject.toml](../worker/pyproject.toml) | Package metadata, pytest, editable install | §8 |
| [worker/src/dismean_worker/worker.py](../worker/src/dismean_worker/worker.py) | AMQP consumer, thread pool, heartbeats, SIGTERM drain (ITD-005) | §8 |
| [worker/src/dismean_worker/supervisor.py](../worker/src/dismean_worker/supervisor.py) | Reconcile process count to `GET /fleet`; idle-first scale-down | §9 |
| [worker/src/dismean_worker/config.py](../worker/src/dismean_worker/config.py) | Env: `DATA_DIR`, `AMQP_URL`, `API_URL`, concurrency | §13 |
| [worker/src/dismean_worker/messages.py](../worker/src/dismean_worker/messages.py) | Required-key checks for task payloads (ITD-013) | §4 |
| [worker/src/dismean_worker/storage.py](../worker/src/dismean_worker/storage.py) | Temp file + rename writes (ITD-006) | §8 |
| [worker/src/dismean_worker/tasks/generate.py](../worker/src/dismean_worker/tasks/generate.py) | Seeded uint8 generation, ≤5 files per task | §8, ITD-006 |
| [worker/src/dismean_worker/tasks/merge.py](../worker/src/dismean_worker/tasks/merge.py) | int64 sum merge; final float64 mean + CSV | §8, ITD-008 |
| [worker/src/dismean_worker/tasks/__init__.py](../worker/src/dismean_worker/tasks/__init__.py) | Task package marker | — |
| [worker/src/dismean_worker/__init__.py](../worker/src/dismean_worker/__init__.py) | Package marker | — |

### Worker tests

| Path | Role | LLD |
|---|---|---|
| [worker/tests/test_tasks.py](../worker/tests/test_tasks.py) | Generate/merge IO and atomic writes | §8 |
| [worker/tests/test_golden_mean.py](../worker/tests/test_golden_mean.py) | Numeric correctness of merge | §8 |
| [worker/tests/test_golden_pipeline.py](../worker/tests/test_golden_pipeline.py) | Small end-to-end pipeline in-process | §8 |
| [worker/tests/test_contract_examples.py](../worker/tests/test_contract_examples.py) | Parse contract JSON (ITD-013) | §4 |
| [worker/tests/test_supervisor.py](../worker/tests/test_supervisor.py) | Scale-down prefers idle workers | §9 |
| [worker/tests/test_worker_stopped_jobs.py](../worker/tests/test_worker_stopped_jobs.py) | Stopped-job cache and skip behaviour | §8, ITD-009 |

---

## UI (`ui/`)

| Path | Role | LLD |
|---|---|---|
| [ui/src/App.tsx](../ui/src/App.tsx) | Jobs sidebar, job summary, opens task-graph modal | §10, [IPD](decisions/ipd.md) |
| [ui/src/JobTaskTree.tsx](../ui/src/JobTaskTree.tsx) | DAG layout, toolbar, node detail, file preview/download | §10 |
| [ui/src/TaskGraphModal.tsx](../ui/src/TaskGraphModal.tsx) | Full-screen modal shell for the task graph | §10, [IPD](decisions/ipd.md) |
| [ui/src/taskGraph.ts](../ui/src/taskGraph.ts) | Task-graph types and layout helpers | §10 |
| [ui/src/main.tsx](../ui/src/main.tsx) | React root mount | — |
| [ui/src/styles.css](../ui/src/styles.css) | Application styles (dark theme, layout, modal, DAG) | — |
| [ui/src/format.ts](../ui/src/format.ts) | Formatting, job shape validation, estimates | — |
| [ui/src/format.test.ts](../ui/src/format.test.ts) | UI logic unit tests | [design-doc § tests](design-doc.md) |
| [ui/src/taskGraph.test.ts](../ui/src/taskGraph.test.ts) | Task level grouping | §10 |
| [ui/vite.config.ts](../ui/vite.config.ts) | Dev server; proxy `/api` → `:3000` | — |
| [ui/tsconfig.json](../ui/tsconfig.json) | TypeScript config | — |
| [ui/package.json](../ui/package.json) | Dependencies and `npm test` / `npm run dev` | — |

---

## Message contracts (`contracts/`)

| Path | Role | LLD |
|---|---|---|
| [contracts/examples/task_generate.json](../contracts/examples/task_generate.json) | GENERATE task message | §4 |
| [contracts/examples/task_merge.json](../contracts/examples/task_merge.json) | Non-final MERGE | §4 |
| [contracts/examples/task_merge_final.json](../contracts/examples/task_merge_final.json) | Final MERGE (writes result) | §4 |
| [contracts/examples/task_completed_generate.json](../contracts/examples/task_completed_generate.json) | Worker completion after GENERATE | §4 |
| [contracts/examples/task_completed_merge.json](../contracts/examples/task_completed_merge.json) | Worker completion after MERGE | §4 |
| [contracts/examples/task_failed.json](../contracts/examples/task_failed.json) | Worker failure report | §4 |
| [contracts/examples/worker_heartbeat_idle.json](../contracts/examples/worker_heartbeat_idle.json) | Heartbeat IDLE | §4 |
| [contracts/examples/worker_heartbeat_busy.json](../contracts/examples/worker_heartbeat_busy.json) | Heartbeat BUSY | §4 |
| [contracts/examples/job_stopped.json](../contracts/examples/job_stopped.json) | Control: cancel / fail broadcast | §4 |

---

## Scripts (`scripts/`)

| Path | Role | LLD |
|---|---|---|
| [scripts/run-api.sh](../scripts/run-api.sh) | API restart loop on crash (ITD-005) | §10 |
| [scripts/verify-all.sh](../scripts/verify-all.sh) | Full local verification orchestrator | [design-doc § tests](design-doc.md) |
| [scripts/verify-rabbitmq.py](../scripts/verify-rabbitmq.py) | Broker assumption regression checks | [open-questions](open-questions.md), ITD-003/005/007/011 |
| [scripts/e2e.sh](../scripts/e2e.sh) | Wrapper for `e2e.py` | — |
| [scripts/e2e.py](../scripts/e2e.py) | Happy-path job to bit-exact mean; task-graph + partial CSV | [design-doc](design-doc.md) |
| [scripts/e2e-matrix.py](../scripts/e2e-matrix.py) | Several F/C sizes | [design-doc](design-doc.md) |
| [scripts/e2e-api-errors.py](../scripts/e2e-api-errors.py) | HTTP validation and error paths | §10 |
| [scripts/e2e-fleet.py](../scripts/e2e-fleet.py) | Dynamic W scaling | §9, §10 |
| [scripts/e2e-fairness.py](../scripts/e2e-fairness.py) | Small job overtakes large backlog | §7 |
| [scripts/e2e-broker-restart.py](../scripts/e2e-broker-restart.py) | RabbitMQ restart recovery | ITD-005 |
| [scripts/chaos-recovery.py](../scripts/chaos-recovery.py) | SIGKILL workers in flight | [design-doc](design-doc.md) |
| [scripts/benchmark-job.py](../scripts/benchmark-job.py) | ITD-002 wall-clock benchmark | ITD-002 in [itd.md](decisions/itd.md) |

---

## Documentation (`docs/`)

| Path | Role |
|---|---|
| [docs/README.md](README.md) | Doc index |
| [docs/problem-statement.md](problem-statement.md) | Assignment spec |
| [docs/design-doc.md](design-doc.md) | Algorithm, trade-offs, test matrix |
| [docs/hld.md](hld.md) | Components and limits |
| [docs/lld.md](lld.md) | Schema, flows, API, config (spec) |
| [docs/code-map.md](code-map.md) | This file |
| [docs/decisions/itd.md](decisions/itd.md) | Technical decisions (see active ITD IDs in file intro) |
| [docs/decisions/ipd.md](decisions/ipd.md) | Product / UX decisions (see active IPD IDs in file intro) |
| [docs/future-work.md](future-work.md) | Not built yet |
| [docs/open-questions.md](open-questions.md) | User decisions; broker regression note |
| [docs/diagrams/*.md](diagrams/) | Mermaid sequence and state diagrams |

---

## Maintenance

When you add, rename, or remove a file, update the matching section above and, if behaviour changed, update [lld.md](lld.md) in the same change.

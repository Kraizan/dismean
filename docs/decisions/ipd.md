# Important Product Decisions (IPD)

What the user gets or sees. Entries are never deleted; a superseded entry is kept as a stub. Statuses and decision authority are defined in [`AGENTS.md`](../../AGENTS.md#decision-authority).

### IPD-001: Generation completes before reduction
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** a job is evaluated only once all F files exist.
  - States: `GENERATING`, then `REDUCING`, then `COMPLETED`, or `FAILED` / `CANCELLED`.
  - `generation_completed_at` marks the moment it's ready.
- **Why:** clean phases. Rejected: pipelining generation and merging; fusing generation with the first sum.
- **Consequences:** generation and reduction times are shown separately. Files never change once read. The cost is a small barrier (ITD-007).

### IPD-002: No disk cap
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** accept any F and C within the bounds. The API and UI show a size estimate.
- **Consequences:** the largest job needs about 100 GB of inputs plus about 200 GB of partials kept until cleanup. A full disk fails the job through retries (IPD-010). A cap is designed in future-work §8.

### IPD-003: Values are integers 0–100
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** uniform random integers in [0, 100], inclusive.
- **Why:** easy to check by eye, compact, and exact sums (ITD-011).

### IPD-004: Output formats
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** `result.csv` (one line of C values, 8 decimal places) and `result.npy` (`float64`). Any input file can be downloaded as CSV.

### IPD-005: Jobs run in publish order
**Status:** Superseded by IPD-014 · **Date:** 2026-10-23
- Jobs run in FIFO task order. The rule that jobs can be submitted any time with no limit carries over into IPD-014 and IPD-016.

### IPD-006: Cancel
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** `POST /jobs/:id/cancel` stops an active job. Its queued tasks are skipped and late results are ignored (ITD-013). Its files are kept until cleanup or delete.

### IPD-007: Retention and cleanup
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:**
  - Everything is kept while a job runs.
  - A cleanup job (every 10 min, plus an endpoint and a UI button) deletes the partials of jobs that finished more than 1 h ago.
  - Inputs and results stay until `DELETE /jobs/:id`.
- **Consequences:** the merge structure can be inspected afterwards, and retries never lose their inputs. Peak disk use happens while a job runs.

### IPD-008: W fixed at startup
**Status:** Superseded by IPD-015 · **Date:** 2026-10-23
- W = `WORKER_COUNT` at startup. Replaced by runtime-configurable W via API and UI.

### IPD-009: No artificial worker slowdown
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** workers run at natural speed.
- **Consequences:** on one laptop, speed differences between workers are small. A simulation test demonstrates the uneven-speed handling (design doc §9). A slowdown flag is designed in future-work §9.

### IPD-010: A job fails after 3 failed attempts of one task
**Status:** Accepted · **Date:** 2026-10-23
- **Decision:** the job becomes `FAILED`, with a readable `failure_reason` shown in the API and UI (ITD-010).

### IPD-011: Input bounds follow the spec
**Status:** Accepted (delegated) · **Date:** 2026-10-23
- **Decision:** `2 ≤ F ≤ 99,999` and `2 ≤ C ≤ 999,999`. Anything else returns 400 with a clear message.

### IPD-012: No backup copies of slow tasks
**Status:** Deferred · **Date:** 2026-10-23
- **Decision:** speculative execution is designed (future-work §6) but not built.

### IPD-013: UI scope
**Status:** Accepted (delegated) · **Date:** 2026-10-23
- **Decision:** a single page, polling every second (ITD-024), stack per ITD-029. It shows:
  - workers (idle, busy, dead) and each worker's current task;
  - queue depth;
  - jobs by status, plus waiting jobs;
  - per-phase job progress;
  - throughput;
  - a live log of the last 500 events.

  Actions: submit, cancel, delete, download, cleanup.

### IPD-014: Jobs that are reducing finish first
**Status:** Superseded by IPD-016 · **Date:** 2026-10-25 · **Supersedes:** IPD-005
- Jobs could be submitted any time; merge work was meant to be preferred 2:1. In practice the broker served merges strictly first and small jobs waited behind big ones.

### IPD-016: Active jobs share the workers fairly
**Status:** Accepted · **Date:** 2026-10-26 · **Supersedes:** IPD-014
- **Decision:**
  - Jobs can be submitted any time, with no limit.
  - Every active job gets an equal share of task slots, round-robin (ITD-034). Within a job, merges run before generation.
- **Consequences:** a small job submitted behind a large one finishes in about the time it would take alone with W/N workers, instead of waiting for the large job. A single large job still uses the whole fleet.

### IPD-015: Configurable worker count W via API and UI
**Status:** Accepted · **Date:** 2026-10-26 · **Supersedes:** IPD-008
- **Decision:** `GET /fleet` and `PUT /fleet {desired_workers}` (`1..32`) read and update target `W` at runtime, and the UI provides a live target-vs-actual control (ITD-032).
- **Consequences:** both bonus requirements in the problem statement are built end-to-end.

### IPD-017: Job task tree in the UI
**Status:** Accepted (delegated) · **Date:** 2026-10-26
- **Decision:** two-pane UI: job list + submit on the left, job summary on the right. **Open task graph** launches a modal (backdrop, Esc/close) with the full **DAG**: toolbar zoom (−/+, **Fit**), **Collapse generation** (default when &gt;6 GENERATE tasks), **Focus path** (trim to selected task’s lineage), **All edges**. Graph uses most of the modal; task detail (I/O, CSV preview) in a side column when a node is selected (`GET /jobs/:id/task-graph`). Fleet scale, cleanup, and cancel-all under collapsed **Operations**.
- **Why:** keep the main job view light while giving the reduction graph room; KPI strip, worker table, and event log removed from the default view.
- **Consequences:** expand generation via hub click or uncheck collapse; `/jobs/:id/tasks` and `GET /events` remain for scripts.

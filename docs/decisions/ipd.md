# Important Product Decisions (IPD)

What users get and see. Only **current** decisions are listed (see [`AGENTS.md`](../../AGENTS.md#decision-authority) for statuses). Earlier superseded or merged items live in git history.

**Active IPD IDs:** `IPD-001` – `IPD-006`. Product-facing details for file formats, retention, failure retries, fleet scaling, and fair-share live in the matching ITD entries.

Each entry is a small table: **Context** (problem), **Decision** (what we do), **Rationale** (why), **Options considered** (alternatives we skipped), and **Trade-offs** (costs and limits).

---

### IPD-001: Generation completes before reduction

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | A job must create F random files and then average them across workers. We need a clear rule for when merging is allowed to start. |
| **Decision** | All F input files must exist before merging starts. Job states: `GENERATING` → `REDUCING` → `COMPLETED` (or `FAILED` / `CANCELLED`). We record `generation_completed_at` when generation finishes. |
| **Rationale** | Two clear phases are easy to reason about. Users can inspect any input file, and merging always sees a complete set of F files. |
| **Options considered** | Start merging while generation is still running; fold generation into the first merge step without saving raw input files. |
| **Trade-offs** | Workers wait briefly for the last generate task at the barrier (ITD-004). We write all F input files to disk first, though other jobs can use idle workers meanwhile (ITD-003). UI shows generation and reduction times separately. |

### IPD-002: No disk cap

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Large F and C values can use gigabytes of disk for inputs and partial merges. |
| **Decision** | Allow any F and C within spec limits. The API and UI show an upfront disk and task estimate before/when running a job. |
| **Rationale** | The spec allows large jobs; showing an estimate lets the user judge capacity without arbitrary hard blocks on local machines. |
| **Options considered** | Reject jobs over a fixed disk quota (`413`, future-work §8); cap F×C below the spec maximum. |
| **Trade-offs** | Huge jobs can fill the disk until cleanup runs. If the disk fills up, tasks fail and the job ends `FAILED` after retries (ITD-007). |

### IPD-003: Values are integers 0–100

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | The spec asks for random numbers in each file but does not fix the numeric range or type. |
| **Decision** | Each value in each input file is a random integer from 0 to 100 inclusive. |
| **Rationale** | Small integers are easy to read in CSV previews, fit in one byte (`uint8`), and sum without rounding error until the final divide. |
| **Options considered** | Random floats; wider integer ranges (32-bit or 64-bit inputs). |
| **Trade-offs** | Fixed range; supporting wider inputs or floats would require wider storage types and a new decision (ITD-008). |

### IPD-004: Cancel

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | Users may start a large job by mistake or want to free workers without waiting for completion. |
| **Decision** | `POST /jobs/:id/cancel` marks a running job `CANCELLED`. Queued tasks are skipped, late worker results are ignored (ITD-009), and existing files stay on disk until cleanup or `DELETE /jobs/:id`. |
| **Rationale** | Stops wasted work right away while keeping already-written files available if the user wants to inspect them. |
| **Options considered** | No cancel (wait for finish or restart services); delete all job files immediately on cancel. |
| **Trade-offs** | In-flight worker tasks may finish their current batch before noticing cancel, and partial files stay on disk until cleanup or delete. |

### IPD-005: No artificial worker slowdown

| Field | Value |
|---|---|
| **Status** | Accepted · **Date:** 2026-10-23 |
| **Context** | The problem statement mentions workers running at different speeds. We had to decide whether to inject fake delays in normal runs. |
| **Decision** | Workers always run at full speed. There is no built-in sleep or slow-mode toggle in production code. |
| **Rationale** | Real OS scheduling and batch sizes already vary timing; unit simulations test stragglers directly without slowing every local run and test. |
| **Options considered** | Per-worker sleep/throttle env var for demos (future-work §9). |
| **Trade-offs** | Small local jobs finish very fast (~hundreds of ms), so visual speed differences across workers are subtle unless F or C is large. Speed-variance behaviour is verified in `speed-variance.test.ts` (design-doc §9). |

### IPD-006: Job task tree in the UI

| Field | Value |
|---|---|
| **Status** | Accepted (delegated) · **Date:** 2026-10-26 |
| **Context** | Users need a simple way to run jobs, resize the worker fleet, and inspect how generation and merges actually ran. |
| **Decision** | Single-page UI polling every 1 s: left sidebar for job submission, filters (including “waiting”), job list, and **Operations** (fleet W, cleanup, cancel all); right pane for selected job summary and downloads; **Open task graph** modal for the full DAG with zoom, optional collapsed generation, upstream/downstream links, and CSV previews (ITD-012). Scripts still use `/stats` and `GET /events`. |
| **Rationale** | Keeps the main screen uncluttered while giving a full visual DAG and file preview when debugging a job. |
| **Options considered** | Multi-page app; Grafana/Prometheus stack; always embedding the full DAG inline; keeping a noisy live event-log table on the main screen. |
| **Trade-offs** | The browser UI does not show the raw `/events` stream (available via API) and collapses large GENERATE layers by default so the graph stays readable. |

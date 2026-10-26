# Design doc: Distributed Mean

**Status:** Draft v3, design agreed, not implemented · **Updated:** 2026-10-25 · [HLD](hld.md) · [LLD](lld.md) · [ITDs](decisions/itd.md) · [IPDs](decisions/ipd.md)

## 1. Problem

Compute `result[i] = Σ_f file_f[i] / F` over F files of C random integers ([spec](problem-statement.md)).

Constraints:
- W workers do the work; a worker holds at most 5 files at a time.
- Workers run at different speeds.
- Several jobs can run at once.

Bounds: `2 ≤ F ≤ 99,999`, `2 ≤ C ≤ 999,999` (IPD-011). Values: integers in [0, 100] (IPD-003).

## 2. Goals and non-goals

**Goals:**
1. Correct results under crashes and duplicate deliveries.
2. Minimal idle time, and no worker ever waits on a specific slow worker.
3. Exact, cheap detection of when generation ends and when a job ends.
4. Jobs can be submitted while others are running.
5. Live observability.

**Not now:**
- Strict fair share across jobs (future-work §1).
- Changing W through the API (IPD-008, future-work §4).
- Hang detection faster than about 15 minutes (ITD-008).
- Running on more than one machine (HLD §7).
- A disk cap (IPD-002).

## 3. Key insight

`mean = sum / count`, and sums combine in any order. So:
- A **partial** is `(sum_vector, count)`. An input file is a partial with count 1.
- Inputs and partials are interchangeable **items**. Any ≤5 items can be merged into one.
- With `int64` sums, every partial is exact. The only rounding is the final division (ITD-011).

## 4. Approach

### 4.1 Two task kinds

| Kind | Reads | Writes | Per job |
|---|---|---|---|
| GENERATE | — | ≤5 input files (`uint8`) | G = ⌈F/5⌉ |
| MERGE | ≤5 items | 1 partial (`int64`), or the final result | M ≈ ⌈(F−1)/4⌉ |

A job puts many messages on the queue, so there's no 1:1 mapping between jobs and queue items.

### 4.2 Generation, then a barrier (IPD-001, ITD-007)

1. `POST /jobs` inserts the job and its G GENERATE tasks in one statement. The outbox relay publishes them (ITD-005).
2. Each GENERATE task writes ≤5 files seeded by `(jobs.seed, file_index)`, so a re-run writes identical bytes (ITD-009).
3. The coordinator adds each completion's file count to `jobs.generated_files`.
4. **Barrier:** the completion that reaches F does all of the following in the same transaction:
   - moves the job to `REDUCING` and records `generation_completed_at`;
   - inserts F input items;
   - creates ⌊F/5⌋ leaf MERGEs.

### 4.3 Reduction by dynamic pool merge (ITD-006)

Each job has a pool of `READY` items. After every pool change the scheduler runs:

```
while true:
  if ≥5 READY:                                  merge any 5
  elif 2–4 READY and no open MERGE for the job:  merge them all
  else: break
a MERGE is final when its input counts add up to F
```

- **No fixed tree.** A merge waits for *any* 5 ready items, never for a particular worker. A slow worker delays only the item it holds ([walkthrough](diagrams/reduction-walkthrough.md)).
- **Strict tail rule.** With fewer than 5 items and merges still open, we wait. This gives the fewest tasks and the simplest rule. Early merging would save at most about one merge at the very end (future-work §10).

### 4.4 Deciding when a job is finished

**Invariant:** Σ count over `READY` and `RESERVED` items = F. A merge consumes exactly its reserved inputs and produces one item whose count is their sum.

So the merge whose inputs add up to F must be the last one. It's flagged `final` when created (ITD-018). Its worker divides by F and writes `result.csv` and `result.npy`. Applying its completion marks the job `COMPLETED`.

There's no polling and no counting of finished tasks. The generation barrier uses the same counter idea.

### 4.5 Workers (ITD-004, ITD-008)

- **Pull-based, `prefetch=1`:** a faster worker simply takes more tasks. That's the whole load balancer.
- **Stateless and DB-free:** the API coordinator makes every decision.
- **Small tasks (≤5 files):** short tails at the end of each phase.

### 4.6 Multiple jobs (ITD-020, IPD-014)

- One queue with two priority levels: MERGE high, GENERATE normal. RabbitMQ delivers them 2:1, so neither starves. Within a level, order is FIFO.
- **Why:** with plain FIFO, a job's late merges were queued behind later jobs' generation, so all concurrent jobs finished late. Now a job that has started reducing finishes quickly, and other jobs' generation uses the remaining capacity.
- One job's barrier gap is filled by other jobs' tasks.
- **Known gap:** a small job submitted during a big job's generation waits behind that backlog (future-work §1).

## 5. Efficiency

| Quantity | Value |
|---|---|
| Tasks | G = ⌈F/5⌉ GENERATE + M ≈ ⌈(F−1)/4⌉ MERGE |
| Reduction depth | ≈ ⌈log₅ F⌉ (8 at F = 100k) |
| Input I/O | F·C bytes written once and read once |
| Partial I/O | (M−1)·8C bytes written once and read once |
| Makespan (one job, uniform speeds) | ≈ (G·t_g + M·t_m)/W + t_g (barrier) + depth·t_m (tail) |

**Where idle time comes from:**
- The barrier: at most one GENERATE task's duration (`t_g`), and other jobs fill it.
- The reduction tail: about depth × one MERGE's duration (`t_m`).

Uneven speeds change who does how many tasks, not whether work is available.

**Example:** F = 10k, W = 10.
- G = 2,000 and M ≈ 2,500, so the ideal is (G + M)/W ≈ 450 task slots.
- Barrier plus tail add about 7 more.
- That's about 98% efficient.

## 6. Failure handling

| Failure | Handling | Ref |
|---|---|---|
| Worker crash or network loss | Unacked message requeued (AMQP heartbeat 10 s) | ITD-008 |
| Worker hung | `x-consumer-timeout` (15 min) closes the channel; the worker exits and the supervisor restarts it | ITD-008, ITD-021 |
| Duplicate run | Deterministic output, atomic rename, task counted once | ITD-009 |
| API crash between commit and publish | Relay republishes `CREATED` tasks | ITD-005 |
| Coordinator crash | Transaction rolls back; the message is redelivered | ITD-004 |
| Postgres down | Coordinator holds the message unacked and retries with backoff | ITD-022 |
| Coordinator bug | Job `FAILED` ("internal error"); never hangs | ITD-022 |
| Task error | 3 attempts, then the job is `FAILED` | ITD-010 |
| Crash loop (poison message) | Delivery limit 3, then dead-letter queue, then the job is `FAILED` | ITD-010 |
| Cancelled or failed job with queued tasks | `job.stopped` broadcast; workers skip; coordinator ignores | ITD-013 |

Sequences: [seq-failure-handling.md](diagrams/seq-failure-handling.md).

## 7. Trade-offs

| Choice | Gain | Cost |
|---|---|---|
| Two priority levels, not fair share | Simple; jobs that are reducing finish quickly | A small job can wait behind a big job's generation |
| One API coordinator | No races; workers stay simple | Throughput ceiling (measured, ITD-027); a restart-safe single point of failure |
| Strict tail rule | Fewest tasks | Up to about one `t_m` per job |
| Generation barrier | Clean phases and separate metrics | Up to one `t_g` idle when a job runs alone |
| Keep intermediates until cleanup | Debuggable; retries keep their inputs | Peak disk ≈ inputs + all partials |
| Consumer timeout as the hang detector | Almost no code | About 15 minutes to detect a stuck worker |
| Observability in memory, polled | No extra tables and no SSE | Event history resets when the API restarts |

## 8. Observability (ITD-024)

The UI polls `/stats` and `/events` every second. They report:
- workers: idle, busy and dead;
- queue depth;
- jobs by status, including *waiting* (not started yet);
- per-phase progress;
- throughput;
- a last-500 event log.

Reduction progress is exact: `1 − (live − 1)/(F − 1)`, where `live` counts items that are `READY` or `RESERVED`.

## 9. Tests

| Test | Proves | In repo |
|---|---|---|
| Golden: regenerate the seeded files in NumPy and compare with `result.npy` bit for bit | Correctness | `worker/tests/test_golden_*.py`; `scripts/e2e.py` |
| Scheduler over random, adversarial and one-slow-worker completion orders | Invariant, task count, exactly one final merge | `api/test/scheduler*.test.ts` |
| Speed-variance simulation (0.5×–3× speeds plus one 10× straggler) vs a static tree | Idle time stays low with uneven speeds (IPD-009) | `api/test/reduction-simulation.test.ts` (vs serial baseline) |
| Every completion delivered twice and out of order | Idempotency | `api/test/coordinator-*-integration.test.ts` |
| Both suites parse `contracts/examples/` | Message contracts agree (ITD-025) | `contract-examples` + `api/test/messages.test.ts` |
| Barrier SQL paths equal `paths.inputPath()` | One path source (ITD-028) | `api/test/paths.test.ts` |
| Kill random workers mid-job | Recovery | `scripts/chaos-recovery.py` (in `verify-all.sh`) |
| Benchmark: F = 20k, C = 10, W = 8 | Whether the coordinator needs batching (ITD-027) | `RUN_BENCHMARK=1 BENCHMARK_F=20000 scripts/benchmark-job.py` |
| API validation and cancel | HTTP errors and stop broadcast | `scripts/e2e-api-errors.py` |
| Several job sizes end-to-end | Generation/reduction edge sizes | `scripts/e2e-matrix.py` |
| Worker task IO | Generate/merge atomic writes | `worker/tests/test_tasks.py` |

# AGENTS.md

Rules for every agent (and human) working in this repo. Read this fully before changing anything.

## Project

**Distributed Mean (`dismean`)** computes the per-index mean of F files, each holding C random integers, across a fleet of W workers, and combines their partial sums into one result. It runs locally and uses only free tools.

| Part | Tech | Path |
|---|---|---|
| API (routes, coordinator, outbox relay, cleanup, stats) | Node.js + Express + TypeScript | `api/` |
| Workers + supervisor | Python (required by the spec) | `worker/` |
| Queue | RabbitMQ 4 (topology in `infra/rabbitmq/definitions.json`) | `infra/` |
| DB | Postgres 16 | `api/migrations/` |
| Storage | Shared local `DATA_DIR` | `data/` (gitignored) |
| UI (bonus) | React + Vite + TypeScript | `ui/` |
| Message examples | JSON, parsed by both test suites | `contracts/examples/` |

Spec: [`docs/problem-statement.md`](docs/problem-statement.md). Doc index: [`docs/README.md`](docs/README.md).

## Docs are the source of truth

Code and docs must agree.
1. **Read first.** Before changing code, read the relevant parts of the HLD, LLD and decision logs.
2. **Same change.** Any change to behaviour, schema, messages, endpoints, config or topology updates the affected docs and diagrams in the same change.
3. **Decisions are never deleted.** To change one, add a new entry and mark the old one `Superseded by …` (it may be shortened to a stub).
4. **ITD vs IPD.** How the system works goes in an ITD (`docs/decisions/itd.md`). What the user gets or sees goes in an IPD (`docs/decisions/ipd.md`).
5. **Future work** lives only in `docs/future-work.md`. No TODO-comment roadmaps.
6. **Diagrams** are Mermaid inside Markdown under `docs/diagrams/`.

## Decision authority

**Ask the user** when a decision:
- changes what the user sees or gets: API behaviour, job semantics, output, UI scope, limits;
- adds, removes or replaces a component, queue, store, table or process;
- changes correctness, failure handling or multi-job behaviour;
- changes performance, disk use or cost noticeably;
- supersedes or weakens an `Accepted` decision or an invariant below.

**Decide yourself and record it** as `Accepted (delegated)` when it's:
- a library, tool or version;
- internal code structure or naming;
- a default value or tuning constant;
- a fallback for a verify item that doesn't change the architecture;
- a doc fix that keeps the meaning.

When unsure, ask. Never hide an important change inside a minor one.

**Statuses:**
- `Accepted`: decided by the user.
- `Accepted (delegated)`: decided by an agent; the user can override it.
- `Proposed`: waiting for the user, and also listed in `docs/open-questions.md`.
- `Superseded`, `Deferred`.

Entry template:

```markdown
### ITD-NNN: Title
**Status:** Accepted · **Date:** YYYY-MM-DD
- **Decision:** what we chose
- **Why:** the problem, and the alternatives rejected
- **Consequences:** costs, follow-ups
```

## Invariants (changing one needs a user-approved ITD)

1. **Workers never touch Postgres.** The API is the only DB writer (ITD-004).
2. **One coordinator** applies task results: one message at a time, one transaction, ack after commit (ITD-004).
3. **Tasks are published only by the outbox relay**, from rows with `status='CREATED'` (ITD-005).
4. **≤5 files per task.** GENERATE writes ≤5; MERGE reads ≤5 items (ITD-006, ITD-007).
5. **Each task counts once.** A completion applies only `WHERE status IN ('CREATED','PUBLISHED')` (ITD-009).
6. **Outputs are deterministic and atomic.** Generation is seeded by `(jobs.seed, file_index)`; every write goes to a temp file, then a rename (ITD-009, ITD-026).
7. **Generation finishes before reduction starts** (IPD-001).
8. **Exact arithmetic:** `uint8` inputs, `int64` sums, one float division at the end (ITD-011).
9. **Heartbeats are display-only.** Worker state and events live in API memory (ITD-008, ITD-024).
10. **Only `api/src/paths.ts` builds file paths.** Workers use the paths in their message; the coordinator ignores paths from workers (ITD-028).
11. **Priority:** MERGE 9, GENERATE 0 (ITD-020).
12. **Topology lives only in `definitions.json`.** Code only checks that it exists (ITD-023).
13. **No job hangs.** A coordinator error either waits out a DB outage or fails the job (ITD-022).

## Conventions

- Match surrounding style. Comments only for constraints the code can't show.
- TypeScript in `strict` mode. Validate HTTP and queue input with zod at the boundary.
- Python: type hints, NumPy for array work, no per-element loops.
- Workers: task work runs off the AMQP thread. Any broker error after startup means `exit(1)`; the supervisor restarts the worker (ITD-021).
- Config comes from the env vars in LLD §13. No hard-coded URLs or paths.
- Message changes bump `schema_version` and update LLD §4, `contracts/examples/`, and both parsers (ITD-025).
- Keep it simple: no new component, table, queue or dependency without an ITD explaining why the existing pieces can't do the job.

## Commands

```bash
docker compose up -d
export DATA_DIR="$(pwd)/data"   # absolute path required

cd api && npm install && npm run dev
cd worker && python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
python -m dismean_worker.supervisor

cd api && npm test
cd worker && pytest
./scripts/verify-all.sh   # full local check (docker, tests, e2e)
./scripts/e2e.sh          # API + workers already running
```

## Definition of done

- [ ] Works locally against the docker compose infra.
- [ ] Tests cover the change.
- [ ] HLD, LLD and diagrams updated if behaviour, schema, contracts, endpoints, config or flows changed.
- [ ] Every new decision recorded with the right status (see Decision authority).
- [ ] `docs/open-questions.md` updated.

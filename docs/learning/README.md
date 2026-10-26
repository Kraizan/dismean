# Dismean learning path

Goal: answer **what does this code do?** and **where is it?** for any part of the repo.

## Two tools

| Tool | What it is | How to use |
|---|---|---|
| **Dismean Academy canvas** (`dismean-academy.canvas.tsx` in this workspace’s Cursor `canvases/` folder) | Interactive modules, quizzes, file opener, progress saved in `.canvas.data.json` | Cursor: open the canvas beside chat. Work one module at a time. |
| **This folder + chat tutor** | Written syllabus and copy-paste prompts | Read phases below; paste prompts from [TUTOR.md](TUTOR.md) into Agent chat with `@docs/code-map.md` and the listed files. |

Canonical doc order (do not skip): [design-doc](../design-doc.md) → [HLD](../hld.md) → [LLD](../lld.md) → [code-map](../code-map.md) → [ITD](../decisions/itd.md) / [IPD](../decisions/ipd.md).

## Phases (suggested ~2 weeks)

### Phase 0 — Run and observe (day 1)

1. `docker compose up -d`, `export DATA_DIR="$(pwd)/data"`, `./scripts/run-api.sh`, start workers (`worker/README` or AGENTS.md commands).
2. Submit a tiny job (`F=4`, `C=8`, `W=2`) via UI or `curl`.
3. Watch `GET /events`, `GET /jobs/:id`, and RabbitMQ management UI while it runs.
4. Canvas module **0 — Orientation**.

### Phase 1 — Problem and data (days 2–3)

- Read design-doc (algorithm, barrier, pool merge, completion).
- Read LLD §2 (schema), skim `api/migrations/001_init.sql`.
- Trace `POST /jobs` in `api/src/routes/jobs.ts` through task rows created.
- Canvas modules **1 — Problem & algorithm**, **2 — Postgres model**.

### Phase 2 — Messaging and dispatch (days 4–5)

- LLD §3–§4, `infra/rabbitmq/definitions.json`, `api/src/messages.ts`, worker `messages.py`.
- Follow one GENERATE task: relay publish → worker → result queue → coordinator.
- Canvas modules **3 — RabbitMQ & contracts**, **4 — Outbox relay & fair-share**.

### Phase 3 — Coordinator and workers (days 6–8)

- LLD §5–§7: `api/src/coordinator/*`, `api/src/scheduler/*`, `worker.py`, `supervisor.py`.
- Manually reason through F=12 reduction (diagram `docs/diagrams/reduction-walkthrough.md`).
- Canvas modules **5 — Coordinator**, **6 — Python workers**.

### Phase 4 — Failure, ops, UI (days 9–10)

- `docs/diagrams/seq-failure-handling.md`, ITD-022, ITD-033, ITD-037 (`reconcilePublished.ts`).
- `cleanup/`, `paths.ts`, download endpoints.
- UI polling and fleet: `ui/src`, `PUT /fleet`.
- Canvas modules **7 — Failures & idempotency**, **8 — API surface & UI**.

### Phase 5 — Mastery drills (ongoing)

- Run `./scripts/verify-all.sh` once; map each script stage to components.
- Canvas module **9 — Tests & verify**, **10 — Invariants flash drill**.
- Use [DRILLS.md](DRILLS.md) without looking at answers, then check code-map.

## How to study a single file

1. Find it in [code-map](../code-map.md) → note LLD section.
2. Read that LLD section first.
3. Open the file; list **imports** (who it depends on) and **exports** (who depends on it).
4. Find tests: `api/test`, `worker/tests`, `ui` — tests are executable spec.
5. In chat: paste [TUTOR.md](TUTOR.md) “deep dive one file” prompt with `@path`.

## Interview readiness

After Phase 5 you should explain without notes:

- Why workers never touch Postgres (ITD-004).
- Why the outbox relay exists and fair-share rules (ITD-005, ITD-034).
- Exactly when MERGE tasks appear (barrier / IPD-001).
- What happens on duplicate task results (ITD-009).
- Broker or API death and restart (ITD-033).

See also design-doc **§10 Architecture FAQ**.

## Updating this path

When behaviour or paths change, update the same PR: LLD, code-map, Academy canvas module text, and DRILLS if affected.

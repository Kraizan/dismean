# Location drills (hide answers while practicing)

Cover the prompt, answer aloud or on paper, then reveal.

---

**Q1.** Where is the only place job filesystem paths are built?

<details><summary>Answer</summary>

`api/src/paths.ts` (ITD-028). Coordinator ignores worker-reported paths for authority.

</details>

---

**Q2.** Where are AMQP queue/exchange names defined for local docker?

<details><summary>Answer</summary>

`infra/rabbitmq/definitions.json` (ITD-023). Code only checks topology exists.

</details>

---

**Q3.** Where does fair-share task dispatch (round-robin jobs, MERGE depth) live?

<details><summary>Answer</summary>

`api/src/relay/index.ts` — `selectTasksForDispatch`, `relayOnce` (ITD-034).

</details>

---

**Q4.** Where is exactly-once task completion applied in the DB?

<details><summary>Answer</summary>

Coordinator apply path under `api/src/coordinator/` — updates tasks only when `status IN ('CREATED','PUBLISHED')` (ITD-009).

</details>

---

**Q5.** Where do workers parse task and result JSON schemas?

<details><summary>Answer</summary>

`worker/src/dismean_worker/messages.py` and mirror `api/src/messages.ts`.

</details>

---

**Q6.** Where is PUBLISHED → CREATED reconciliation on stale publishes?

<details><summary>Answer</summary>

`api/src/relay/reconcilePublished.ts` (ITD-037), invoked from relay startup/tick.

</details>

---

**Q7.** Where does the supervisor learn desired worker count W?

<details><summary>Answer</summary>

`worker/src/dismean_worker/supervisor.py` polls `GET /fleet`; API table seeded in `api/src/routes/fleet.ts`.

</details>

---

**Q8.** Where is uint8 NPY validation before streaming a download?

<details><summary>Answer</summary>

`api/src/storage/npy.ts`.

</details>

---

**Q9.** Where does job cancel publish a control message?

<details><summary>Answer</summary>

`api/src/routes/jobs.ts` (control exchange); workers handle in `worker.py`.

</details>

---

**Q10.** Where is the API restart loop that redelivers unacked coordinator messages?

<details><summary>Answer</summary>

`scripts/run-api.sh` (ITD-033) — process exit on fatal broker/consumer errors.

</details>

---

**Q11.** Where are partial sums merged in the reduction tree?

<details><summary>Answer</summary>

Worker `merge` task handler; scheduler creates MERGE tasks in `api/src/scheduler/`.

</details>

---

**Q12.** Where is the in-memory event ring for the UI poll?

<details><summary>Answer</summary>

`api/src/events.ts`, exposed via `api/src/routes/events.ts`.

</details>

Add more drills as you discover gaps; keep answers pointing at **path + LLD §**.

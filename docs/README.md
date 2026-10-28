# Docs

Read in this order: design doc (why), HLD (what), LLD (how). The decision logs record each choice.

| Doc | Contents |
|---|---|
| [problem-statement.md](problem-statement.md) | The assignment, verbatim |
| [design-doc.md](design-doc.md) | Algorithm, job completion, multi-job behaviour, efficiency, trade-offs, tests |
| [hld.md](hld.md) | Components, topology, data flow, deployment, production mapping, limits |
| [lld.md](lld.md) | System spec: schema, queues, flows, HTTP API, config |
| [code-map.md](code-map.md) | Every source path → role → LLD section (onboarding index) |
| [decisions/itd.md](decisions/itd.md) | Technical decisions (`ITD-001` – `ITD-014`) |
| [decisions/ipd.md](decisions/ipd.md) | Product decisions (`IPD-001` – `IPD-006`) |
| [future-work.md](future-work.md) | Designed but not built |
| [open-questions.md](open-questions.md) | Waiting for the user / to verify |

| Diagram | Shows |
|---|---|
| [components](diagrams/components.md) | Components and RabbitMQ topology |
| [state machines](diagrams/job-state-machine.md) | Job, task and item lifecycles |
| [job lifecycle](diagrams/seq-job-lifecycle.md) | Submit through generation, barrier, reduction and result |
| [failure handling](diagrams/seq-failure-handling.md) | Crash, hang, duplicate, retry, poison message, outbox recovery, coordinator errors |
| [cancel](diagrams/seq-cancel.md) | Cancelling a job |
| [reduction walkthrough](diagrams/reduction-walkthrough.md) | Pool merge for F=12, plus dynamic pool vs static tree |

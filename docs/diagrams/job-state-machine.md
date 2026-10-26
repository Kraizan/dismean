# State machines

## Job

```mermaid
stateDiagram-v2
  [*] --> GENERATING: POST /jobs (job + ⌈F/5⌉ GENERATE tasks in one transaction)
  GENERATING --> REDUCING: GENERATE completion makes generated_files = F<br/>(same transaction: seed pool, create leaf MERGEs)
  REDUCING --> REDUCING: MERGE completion: partial joins the pool, scheduler runs
  REDUCING --> COMPLETED: final MERGE (input counts add up to F) applied
  GENERATING --> FAILED: task out of attempts / dead-lettered
  REDUCING --> FAILED: task out of attempts / dead-lettered
  GENERATING --> CANCELLED: POST /jobs/:id/cancel
  REDUCING --> CANCELLED: POST /jobs/:id/cancel
  COMPLETED --> [*]: DELETE /jobs/:id
  FAILED --> [*]: DELETE /jobs/:id
  CANCELLED --> [*]: DELETE /jobs/:id
```

"Ready to be evaluated" (IPD-001) is the GENERATING → REDUCING transition, recorded as `generation_completed_at`.

## Task

```mermaid
stateDiagram-v2
  [*] --> CREATED: inserted by routes or coordinator (outbox)
  CREATED --> PUBLISHED: relay publishes and the broker confirms
  CREATED --> DONE: completion arrives before the relay marks PUBLISHED
  PUBLISHED --> DONE: first task.completed applied
  PUBLISHED --> CREATED: task.failed and attempt < 3 (attempt += 1)
  PUBLISHED --> FAILED: out of attempts / dead-lettered (fails the job)
  PUBLISHED --> CANCELLED: job cancelled or failed
  CREATED --> CANCELLED: job cancelled or failed
  DONE --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

A task that runs out of attempts becomes `FAILED` and fails its whole job. The job's other open tasks become `CANCELLED`.

## Item (pool entry)

```mermaid
stateDiagram-v2
  [*] --> READY: input seeded at barrier / partial produced by MERGE
  READY --> RESERVED: scheduler assigns it to a MERGE
  RESERVED --> CONSUMED: that MERGE completes
  CONSUMED --> DELETED: cleanup sweep (partials only)
```

Invariant: for a `REDUCING` job, Σ count over `READY` and `RESERVED` items = F.

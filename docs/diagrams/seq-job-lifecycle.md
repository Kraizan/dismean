# Sequence: job lifecycle (happy path)

Example: F = 12, so 3 GENERATE tasks and 3 MERGE tasks.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant API as API routes
  participant DB as Postgres
  participant RL as Outbox relay
  participant MQ as RabbitMQ
  participant W as Workers (W)
  participant FS as DATA_DIR
  participant CO as Coordinator

  U->>API: POST /jobs {file_count:12, values_per_file:1000}
  API->>DB: tx: INSERT job (GENERATING, seed) + 3 GENERATE tasks (CREATED)
  API-->>U: 201 {job, estimate}
  API--)RL: signal

  RL->>MQ: passive declare dm.tasks (ready, consumers) → budget = 2 × consumers − ready
  RL->>DB: round-robin pick of CREATED tasks (≤ budget) ... FOR UPDATE SKIP LOCKED
  RL->>MQ: publish 3 GENERATE messages (confirm)
  MQ-->>RL: confirms
  RL->>DB: UPDATE tasks SET PUBLISHED

  par each idle worker (prefetch=1)
    MQ->>W: deliver GENERATE (files 0..4 / 5..9 / 10..11)
    W->>FS: write seeded uint8 .npy (temp file, then rename)
    W->>MQ: task.completed (confirmed)
    W->>MQ: ack
  end

  loop each completion, one at a time
    MQ->>CO: task.completed
    CO->>DB: tx: lock job, task DONE (if open), generated_files += n
    alt generated_files = F (barrier)
      CO->>DB: job REDUCING, INSERT 12 INPUT items, create MERGE A {0..4} and MERGE B {5..9}
      Note over CO,DB: items 10, 11 stay READY (2 items, but merges are open, so wait)
    end
    CO->>DB: COMMIT
    CO->>MQ: ack
  end

  RL->>MQ: publish MERGE A, B (merges before this job's GENERATE; other jobs get their own slots in the same round)
  MQ->>W: MERGE B (fast worker)
  W->>FS: read 5 inputs, write partial P_B (int64)
  W->>MQ: task.completed {count:5}
  MQ->>CO: completed B
  CO->>DB: consume B's inputs, INSERT P_B READY (path from paths.partialPath), pool = {10, 11, P_B}, open merges = 1, so wait

  MQ->>W: MERGE A (slower worker)
  W->>MQ: task.completed {count:5}
  MQ->>CO: completed A
  CO->>DB: INSERT P_A, pool = {10, 11, P_B, P_A}, open merges = 0, so<br/>create MERGE C (counts 1+1+5+5 = 12 = F, so final=true)

  RL->>MQ: publish MERGE C (final)
  MQ->>W: MERGE C
  W->>FS: read 4 items, sum (int64), divide by 12, write result.npy + result.csv
  W->>MQ: task.completed (final)
  MQ->>CO: completed C
  CO->>DB: job COMPLETED, finished_at

  U->>API: GET /jobs/:id
  API-->>U: COMPLETED, progress 1.0
  U->>API: GET /jobs/:id/result.csv
  API->>FS: stream
  API-->>U: result.csv
```

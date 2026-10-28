# Sequences: failure handling

## 1. Worker crashes mid-task: redelivery

```mermaid
sequenceDiagram
  participant MQ as RabbitMQ
  participant W1 as Worker 1
  participant W2 as Worker 2
  participant CO as Coordinator

  MQ->>W1: MERGE X (unacked)
  W1->>W1: writing partial to a temp file...
  Note over W1: process killed (or network lost, AMQP heartbeat 10 s expires)
  MQ->>MQ: connection closed, so X is requeued
  MQ->>W2: MERGE X (redelivered)
  W2->>W2: same inputs give the same bytes, atomic rename over any stale file
  W2->>MQ: task.completed X
  MQ->>CO: completed X, applied once
```

A worker that hangs while its connection stays open is caught by `x-consumer-timeout` (15 min):

```mermaid
sequenceDiagram
  participant MQ as RabbitMQ
  participant W1 as Worker 1 (stuck task thread)
  participant SUP as Supervisor
  participant W2 as Worker 2

  MQ->>W1: MERGE X (unacked)
  Note over W1: task thread stuck, main thread still heartbeating
  MQ->>MQ: 15 min without ack, so close W1's channel and requeue X
  MQ-->>W1: channel closed
  W1->>W1: any channel error, so exit(1) (kills the stuck thread)
  SUP->>SUP: child exited non-zero, so restart the slot
  MQ->>W2: MERGE X (redelivered)
```

## 2. Duplicate completion is ignored

```mermaid
sequenceDiagram
  participant W as Worker
  participant MQ as RabbitMQ
  participant CO as Coordinator
  participant DB as Postgres

  W->>MQ: task.completed X (confirmed)
  Note over W: crashes before ack
  MQ->>W: X redelivered to some worker, which runs it again
  W->>MQ: task.completed X (second copy)
  MQ->>CO: completed X (#1)
  CO->>DB: UPDATE ... WHERE id=X AND status IN (CREATED, PUBLISHED): 1 row, applied
  MQ->>CO: completed X (#2)
  CO->>DB: same UPDATE: 0 rows, so dropped
  CO->>CO: event duplicate_completion (in-memory log)
```

## 3. Task raises an error: retry, then fail the job

```mermaid
sequenceDiagram
  participant W as Worker
  participant MQ as RabbitMQ
  participant CO as Coordinator
  participant DB as Postgres
  participant RL as Relay

  W->>MQ: task.failed X (attempt 1)
  W->>MQ: ack
  MQ->>CO: failed X a1
  CO->>DB: attempt=2, status CREATED (inputs stay RESERVED)
  RL->>MQ: republish X (attempt 2)
  Note over W,CO: ...fails again at attempt 2, then attempt 3...
  MQ->>CO: failed X a3
  CO->>DB: job FAILED (reason), open tasks CANCELLED
  CO->>MQ: job.stopped on dm.control (after commit)
```

## 4. Poison message: delivery limit, dead letter, job failed

```mermaid
sequenceDiagram
  participant MQ as dm.tasks (quorum)
  participant W as Workers
  participant DLX as dm.tasks.dead
  participant CO as Coordinator

  loop 3 deliveries
    MQ->>W: X
    Note over W: worker crashes (no ack), supervisor restarts it
  end
  MQ->>DLX: X exceeded x-delivery-limit=3
  DLX->>CO: X (dead-lettered)
  CO->>CO: task still open? yes, so fail job (reason: crash loop)
```

## 5. API crash between commit and publish: outbox recovery

```mermaid
sequenceDiagram
  participant CO as Coordinator
  participant DB as Postgres
  participant RL as Relay
  participant MQ as RabbitMQ

  CO->>DB: COMMIT (new MERGE Y, status CREATED)
  Note over CO,RL: API process crashes before the relay runs
  Note over RL: API restarts
  RL->>DB: SELECT CREATED, finds Y
  RL->>MQ: publish Y (confirm)
  RL->>DB: Y PUBLISHED
```

If the crash happens after the coordinator commits but before it acks, the triggering completion is redelivered. The coordinator sees it as a duplicate and drops it, and the work it already committed stands.

## 6. Coordinator errors (ITD-002)

```mermaid
sequenceDiagram
  participant MQ as dm.coordinator
  participant CO as Coordinator
  participant DB as Postgres

  MQ->>CO: task.completed X
  CO->>DB: tx
  alt DB unreachable
    DB--xCO: connection error
    CO->>CO: rollback, keep X unacked, back off (1 s, 2 s, ... 30 s)
    CO->>DB: retry the same message until the DB is back
  else unexpected exception (bug)
    CO->>DB: rollback
    CO->>DB: new tx: job FAILED "internal error: ...", open tasks CANCELLED
    CO->>MQ: ack X
    CO->>CO: publish job.stopped
  end
```

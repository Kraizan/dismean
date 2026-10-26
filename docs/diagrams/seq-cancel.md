# Sequence: cancel a job

```mermaid
sequenceDiagram
  actor U as User
  participant API as API routes
  participant DB as Postgres
  participant MQ as RabbitMQ
  participant W as Workers
  participant CO as Coordinator

  U->>API: POST /jobs/:id/cancel
  API->>DB: tx: lock job, status CANCELLED + finished_at, open tasks CANCELLED
  API-->>U: 202 {job}
  API->>MQ: job.stopped {job_id} on dm.control (fanout, best-effort)
  MQ->>W: every worker: stopped_jobs.add(job_id)

  MQ->>W: a queued task of the cancelled job
  W->>MQ: ack without running it

  Note over W,CO: a task that was already running finishes normally
  W->>MQ: task.completed
  MQ->>CO: completed
  CO->>DB: job not active, so ignore (event ignored_inactive_job), then ack
```

A worker that misses the broadcast runs the task anyway, and the coordinator ignores the result. That wastes work but stays correct. A job that fails follows the same path, with the coordinator publishing `job.stopped`.

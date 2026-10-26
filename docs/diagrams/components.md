# Component and topology diagram

```mermaid
flowchart TB
  subgraph Client
    UI[UI / curl]
  end

  subgraph API["API process (Node.js / Express / TS)"]
    R[HTTP routes]
    CO[Coordinator<br/>single consumer]
    RE[Outbox relay]
    CL[Cleanup sweep]
    ST[Stats: in-memory worker list<br/>+ last-500 event buffer]
    PA[paths helper]
  end

  subgraph PG["Postgres"]
    J[(jobs)]
    T[(tasks = outbox)]
    I[(items = pool)]
  end

  subgraph MQ["RabbitMQ (topology from definitions.json)"]
    XT{{dm.tasks<br/>direct}} --> QT[[dm.tasks<br/>quorum, 2 priority levels,<br/>delivery-limit 3, consumer-timeout 15m]]
    QT -. dead-letter .-> XD{{dm.dlx}} --> QD[[dm.tasks.dead]]
    XE{{dm.events<br/>topic}} -->|task.*| QC[[dm.coordinator]]
    XE -->|worker.heartbeat| QH[[dm.heartbeats<br/>TTL 10s]]
    XC{{dm.control<br/>fanout}} --> QW[[per-worker<br/>control queue]]
  end

  subgraph Fleet["Worker fleet (Python)"]
    SUP[Supervisor]
    W1[Worker]
    W2[Worker]
    WN[Worker]
    SUP --> W1 & W2 & WN
  end

  FS[(DATA_DIR<br/>inputs / partials / results)]

  UI -->|REST, polls /stats + /events every 1s| R
  R --> J & T
  R --> ST
  RE -->|SELECT CREATED| T
  RE -->|publish + confirm<br/>MERGE prio 9, GENERATE prio 0| XT
  R -->|job.stopped on cancel| XC
  CO -->|job.stopped on failure| XC
  QC --> CO
  QD --> CO
  CO --> J & T & I
  CO -->|events after commit| ST
  QH --> ST
  ST -. management API .-> MQ
  CL --> J & I
  CL --> FS
  R --> FS
  CO & RE & R --> PA

  QT -->|prefetch 1| W1 & W2 & WN
  QW --> W1 & W2 & WN
  W1 & W2 & WN -->|task.completed / failed / heartbeat| XE
  W1 & W2 & WN <--> FS
```

Rules shown here:
- Workers never connect to Postgres.
- Only the relay publishes tasks.
- Every file path comes from the API's `paths` helper.
- Worker state and events live only in API memory.

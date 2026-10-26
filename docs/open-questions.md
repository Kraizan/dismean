# Open questions

Lists only what's waiting for the user, plus what to verify during implementation. Settled questions live in the decision logs.

## Waiting for the user

None.

## Verify during implementation

Checked on `rabbitmq:4-management` via `scripts/verify-rabbitmq.py` (2026-10-26).

| # | Check on the pinned RabbitMQ 4.x image | Needed by | Fallback | Fallback decided by | Status |
|---|---|---|---|---|---|
| V-1 | Quorum queues support two priority levels with 2:1 delivery | ITD-020 | Classic queue with `x-max-priority=2` (loses the delivery limit; see future-work §2) | **User** (changes the architecture) | **Assumed** (quorum `dm.tasks` OK; ratio not automated) |
| V-2 | Per-queue `x-consumer-timeout` argument | ITD-008 | Broker-wide `consumer_timeout` in `rabbitmq.conf` | Agent | **OK** (`900000` on `dm.tasks`) |
| V-3 | `x-delivery-limit=-1` means unlimited | ITD-022 | A very large limit (1,000,000) | Agent | **Fallback** (`dm.coordinator` uses `1000000`; `-1` not used at import) |
| V-4 | Quorum queue dead-letters a message once its delivery limit is exceeded | ITD-010 | Worker reads the delivery count and publishes `task.failed` at the limit | Agent | **OK** (DLX + `dm.tasks.dead` present; limit `3`) |

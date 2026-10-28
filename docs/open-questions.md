# Open questions

Items that need a **user** decision before we change behaviour or product scope. Settled choices live in [ITD](decisions/itd.md) and [IPD](decisions/ipd.md).

## Waiting for the user

None.

## Broker assumptions (regression check)

RabbitMQ 4.x behaviour used by ITD-003, ITD-005, ITD-007, and ITD-011 was verified at implementation time (consumer timeout on the task queue, delivery limits and dead-lettering, passive queue depth for dispatch, no workable 2:1 priority on quorum queues—fair share is in SQL instead).

After upgrading the broker image or changing queue arguments, run `scripts/verify-rabbitmq.py` and update the decision logs if anything changed.

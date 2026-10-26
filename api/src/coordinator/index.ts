import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import type { EventEmitter } from "node:events";
import type pg from "pg";
import type { Config } from "../config.js";
import { isDbAvailabilityError } from "../db/pool.js";
import type { JobRow } from "../db/types.js";
import { pushEvent } from "../events.js";
import { parseCoordinatorPayload } from "../messages.js";
import {
  QUEUE_COORDINATOR,
  QUEUE_DEAD,
  passiveDeclareQueues,
  publishJobStopped,
} from "../mq/connection.js";
import { failJob, type PendingEvent } from "./failJob.js";
import { flushEvents, routeMessage } from "./handlers.js";

export const RELAY_SIGNAL = "relay";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function parseRawMessage(
  msg: ConsumeMessage,
  fromDead: boolean,
): { routingKey: string; payload: unknown } | null {
  try {
    const payload = JSON.parse(msg.content.toString()) as unknown;
    if (fromDead) {
      return { routingKey: "dead", payload };
    }
    const rk = msg.fields.routingKey ?? "";
    return { routingKey: rk, payload };
  } catch {
    return null;
  }
}

async function processMessage(
  pool: pg.Pool,
  config: Config,
  controlCh: Channel,
  relayEmitter: EventEmitter,
  msg: ConsumeMessage,
  fromDead: boolean,
  ch: Channel,
): Promise<void> {
  const raw = parseRawMessage(msg, fromDead);
  if (!raw) {
    pushEvent({ type: "invalid_message", message: "json parse failed" });
    ch.ack(msg);
    return;
  }

  const parsed = parseCoordinatorPayload(raw.routingKey, raw.payload);
  if (!parsed) {
    pushEvent({ type: "invalid_message", message: "schema validation failed" });
    ch.ack(msg);
    return;
  }

  const jobId = parsed.body.job_id;
  const client = await pool.connect();
  let released = false;

  try {
    await client.query("BEGIN");
    const { rows } = await client.query<JobRow>(
      `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const job = rows[0];
    if (!job || (job.status !== "GENERATING" && job.status !== "REDUCING")) {
      await client.query("COMMIT");
      ch.ack(msg);
      pushEvent({
        type: "ignored_inactive_job",
        job_id: jobId,
        task_id: "task_id" in parsed.body ? parsed.body.task_id : undefined,
      });
      return;
    }

    const handlerResult = await routeMessage(
      client,
      job,
      parsed,
      config,
      controlCh,
    );
    await client.query("COMMIT");
    ch.ack(msg);

    flushEvents(handlerResult.events);
    if (handlerResult.relaySignal) {
      relayEmitter.emit(RELAY_SIGNAL);
    }
    if (handlerResult.jobStopped && handlerResult.jobId && handlerResult.stopStatus) {
      try {
        await publishJobStopped(controlCh, {
          schema_version: 1,
          type: "job.stopped",
          job_id: handlerResult.jobId,
          status: handlerResult.stopStatus,
        });
      } catch {
        // best-effort broadcast (ITD-013)
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (isDbAvailabilityError(err)) {
      client.release();
      released = true;
      let backoff = 1000;
      for (;;) {
        await sleep(backoff);
        try {
          await processMessage(
            pool,
            config,
            controlCh,
            relayEmitter,
            msg,
            fromDead,
            ch,
          );
          return;
        } catch (retryErr) {
          if (!isDbAvailabilityError(retryErr)) throw retryErr;
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    }

    try {
      await client.query("BEGIN");
      const { rows } = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const job = rows[0];
      const errEvents: PendingEvent[] = [];
      if (job) {
        await failJob(
          client,
          job,
          `internal error: ${err instanceof Error ? err.message : String(err)}`,
          errEvents,
        );
      }
      await client.query("COMMIT");
      ch.ack(msg);
      flushEvents(errEvents);
      if (job) {
        try {
          await publishJobStopped(controlCh, {
            schema_version: 1,
            type: "job.stopped",
            job_id: job.id,
            status: "FAILED",
          });
        } catch {
          // best-effort broadcast (ITD-013)
        }
      }
    } catch (inner) {
      await client.query("ROLLBACK").catch(() => {});
      throw inner;
    }
  } finally {
    if (!released) client.release();
  }
}

let processing = false;
const pending: Array<{
  msg: ConsumeMessage;
  fromDead: boolean;
  ch: Channel;
}> = [];

async function drainQueue(
  pool: pg.Pool,
  config: Config,
  controlCh: Channel,
  relayEmitter: EventEmitter,
): Promise<void> {
  if (processing) return;
  processing = true;
  while (pending.length > 0) {
    const next = pending.shift()!;
    await processMessage(
      pool,
      config,
      controlCh,
      relayEmitter,
      next.msg,
      next.fromDead,
      next.ch,
    );
  }
  processing = false;
}

function enqueue(
  pool: pg.Pool,
  config: Config,
  controlCh: Channel,
  relayEmitter: EventEmitter,
  msg: ConsumeMessage,
  fromDead: boolean,
  ch: Channel,
): void {
  pending.push({ msg, fromDead, ch });
  void drainQueue(pool, config, controlCh, relayEmitter);
}

export async function startCoordinator(
  conn: ChannelModel,
  pool: pg.Pool,
  config: Config,
  controlCh: Channel,
  relayEmitter: EventEmitter,
): Promise<Channel[]> {
  const channels: Channel[] = [];

  const coordCh = await conn.createChannel();
  await passiveDeclareQueues(coordCh);
  await coordCh.prefetch(50);
  await coordCh.consume(
    QUEUE_COORDINATOR,
    (msg) => {
      if (!msg) return;
      enqueue(pool, config, controlCh, relayEmitter, msg, false, coordCh);
    },
    { noAck: false },
  );
  channels.push(coordCh);

  const deadCh = await conn.createChannel();
  await deadCh.prefetch(50);
  await deadCh.consume(
    QUEUE_DEAD,
    (msg) => {
      if (!msg) return;
      enqueue(pool, config, controlCh, relayEmitter, msg, true, deadCh);
    },
    { noAck: false },
  );
  channels.push(deadCh);

  return channels;
}

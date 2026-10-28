import amqp from "amqplib";
import type { Channel, ChannelModel, ConfirmChannel } from "amqplib";
import type { Config } from "../config.js";
import type { JobStopped, TaskMessage } from "../messages.js";

export const EXCHANGE_TASKS = "dm.tasks";
export const EXCHANGE_EVENTS = "dm.events";
export const EXCHANGE_CONTROL = "dm.control";
export const EXCHANGE_DLX = "dm.dlx";
export const QUEUE_TASKS = "dm.tasks";
export const QUEUE_DEAD = "dm.tasks.dead";
export const QUEUE_COORDINATOR = "dm.coordinator";
export const QUEUE_HEARTBEATS = "dm.heartbeats";

let connection: ChannelModel | null = null;
let closing = false;

function exitOnBrokerLoss(what: string, err?: unknown): void {
  if (closing) return;
  // Same rule as workers: no in-process reconnect; the restart loop brings the API back (ITD-005).
  console.error(`amqp ${what}; exiting so the restart loop reconnects`, err ?? "");
  process.exit(1);
}

export function amqpConnected(): boolean {
  return connection !== null && !closing;
}

export async function connectAmqp(config: Config): Promise<ChannelModel> {
  if (connection) return connection;
  const conn = await amqp.connect(config.AMQP_URL);
  conn.on("error", (err) => exitOnBrokerLoss("connection error", err));
  conn.on("close", () => exitOnBrokerLoss("connection closed"));
  connection = conn;
  return conn;
}

export function watchChannel(ch: Channel, name: string): Channel {
  ch.on("error", (err) => exitOnBrokerLoss(`channel ${name} error`, err));
  ch.on("close", () => exitOnBrokerLoss(`channel ${name} closed`));
  return ch;
}

export function markAmqpClosing(): void {
  closing = true;
}

export async function closeAmqp(): Promise<void> {
  closing = true;
  if (connection) {
    await connection.close().catch(() => {});
    connection = null;
  }
}

export async function checkTopology(conn: ChannelModel): Promise<void> {
  const ch = await conn.createChannel();
  try {
    await ch.checkExchange(EXCHANGE_TASKS);
    await ch.checkExchange(EXCHANGE_EVENTS);
    await ch.checkExchange(EXCHANGE_CONTROL);
    await ch.checkExchange(EXCHANGE_DLX);
    await ch.checkQueue(QUEUE_TASKS);
    await ch.checkQueue(QUEUE_DEAD);
    await ch.checkQueue(QUEUE_COORDINATOR);
    await ch.checkQueue(QUEUE_HEARTBEATS);
  } catch (err) {
    throw new Error(
      `RabbitMQ topology not loaded (passive declare failed): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await ch.close();
  }
}

export async function createConfirmChannel(
  conn: ChannelModel,
): Promise<ConfirmChannel> {
  const ch = await conn.createConfirmChannel();
  watchChannel(ch, "relay");
  return ch;
}

export async function publishTaskBatch(
  ch: ConfirmChannel,
  messages: TaskMessage[],
): Promise<void> {
  for (const message of messages) {
    const body = Buffer.from(JSON.stringify(message));
    const ok = ch.publish(EXCHANGE_TASKS, "task", body, {
      contentType: "application/json",
      deliveryMode: 2,
      messageId: `${message.task_id}:${message.attempt}`,
    });
    if (!ok) {
      await new Promise<void>((resolve) => ch.once("drain", resolve));
    }
  }
  await ch.waitForConfirms();
}

export async function publishJobStopped(
  ch: Channel,
  message: JobStopped,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(message));
  ch.publish(EXCHANGE_CONTROL, "", body, {
    contentType: "application/json",
    deliveryMode: 2,
  });
}

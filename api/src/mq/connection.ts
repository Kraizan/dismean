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

const TASKS_QUEUE_ARGS = {
  "x-queue-type": "quorum",
  "x-delivery-limit": 3,
  "x-dead-letter-exchange": "dm.dlx",
  "x-consumer-timeout": 900_000,
};

const COORDINATOR_QUEUE_ARGS = {
  "x-queue-type": "quorum",
  "x-delivery-limit": 1_000_000,
};

const HEARTBEATS_QUEUE_ARGS = {
  "x-message-ttl": 10_000,
  "x-max-length": 10_000,
  "x-overflow": "drop-head",
};

let connection: ChannelModel | null = null;

export async function connectAmqp(config: Config): Promise<ChannelModel> {
  if (connection) return connection;
  connection = await amqp.connect(config.AMQP_URL);
  return connection;
}

export async function closeAmqp(): Promise<void> {
  if (connection) {
    await connection.close();
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

export async function passiveDeclareQueues(ch: Channel): Promise<void> {
  await ch.checkQueue(QUEUE_TASKS);
  await ch.checkQueue(QUEUE_DEAD);
  await ch.checkQueue(QUEUE_COORDINATOR);
  await ch.checkQueue(QUEUE_HEARTBEATS);
}

export async function createConfirmChannel(
  conn: ChannelModel,
): Promise<ConfirmChannel> {
  const ch = await conn.createConfirmChannel();
  return ch;
}

export function taskPriority(kind: "GENERATE" | "MERGE"): number {
  return kind === "MERGE" ? 9 : 0;
}

export async function publishTask(
  ch: ConfirmChannel,
  message: TaskMessage,
): Promise<void> {
  await publishTaskBatch(ch, [message]);
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
      priority: taskPriority(message.kind),
    });
    if (!ok) {
      await new Promise<void>((resolve) => ch.once("drain", resolve));
    }
  }
  await ch.waitForConfirms();
}

export async function publishEvent(
  ch: ConfirmChannel,
  routingKey: string,
  payload: unknown,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload));
  const ok = ch.publish(EXCHANGE_EVENTS, routingKey, body, {
    contentType: "application/json",
    deliveryMode: 2,
  });
  if (!ok) {
    throw new Error("publish buffer full");
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

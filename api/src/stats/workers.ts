import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import type { Config } from "../config.js";
import { pushEvent } from "../events.js";
import { workerHeartbeatSchema } from "../messages.js";
import { QUEUE_HEARTBEATS } from "../mq/connection.js";

export interface WorkerSnapshot {
  id: string;
  state: string;
  task_id: string | null;
  job_id: string | null;
  task_kind: string | null;
  tasks_done: number;
  last_heartbeat_at: string;
  hostname: string;
  pid: number;
  dead: boolean;
}

interface WorkerEntry {
  worker_id: string;
  hostname: string;
  pid: number;
  state: string;
  task_id: string | null;
  job_id: string | null;
  task_kind: string | null;
  tasks_done: number;
  started_at: string;
  last_heartbeat_at: string;
  seen: boolean;
}

const workers = new Map<string, WorkerEntry>();

export function getWorkerMap(): Map<string, WorkerEntry> {
  return workers;
}

export async function startHeartbeatConsumer(
  conn: ChannelModel,
  config: Config,
): Promise<Channel> {
  const ch = await conn.createChannel();
  await ch.checkQueue(QUEUE_HEARTBEATS);
  await ch.consume(
    QUEUE_HEARTBEATS,
    (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        const raw = JSON.parse(msg.content.toString()) as unknown;
        const parsed = workerHeartbeatSchema.safeParse(raw);
        if (!parsed.success) return;
        const hb = parsed.data;
        const prev = workers.get(hb.worker_id);
        const isNew = !prev;
        workers.set(hb.worker_id, {
          worker_id: hb.worker_id,
          hostname: hb.hostname,
          pid: hb.pid,
          state: hb.state,
          task_id: hb.task_id,
          job_id: hb.job_id,
          task_kind: hb.task_kind,
          tasks_done: hb.tasks_done,
          started_at: hb.started_at,
          last_heartbeat_at: hb.sent_at,
          seen: true,
        });
        if (isNew) {
          pushEvent({ type: "worker_started", worker_id: hb.worker_id });
        }
        if (hb.state === "STOPPED") {
          workers.delete(hb.worker_id);
          pushEvent({ type: "worker_stopped", worker_id: hb.worker_id });
        }
      } catch {
        // ignore malformed heartbeats
      }
    },
    { noAck: true },
  );
  setInterval(() => pruneWorkers(config), 1000);
  return ch;
}

function pruneWorkers(config: Config): void {
  const now = Date.now();
  for (const [id, w] of workers) {
    const age = now - new Date(w.last_heartbeat_at).getTime();
    if (age > config.WORKER_PRUNE_MS) {
      workers.delete(id);
      pushEvent({ type: "worker_dead", worker_id: id });
    } else if (age > config.WORKER_STALE_MS && w.state !== "STOPPED") {
      if (!w.seen) continue;
      w.seen = false;
      pushEvent({ type: "worker_dead", worker_id: id });
    }
  }
}

export function buildWorkerStats(config: Config): {
  total: number;
  idle: number;
  busy: number;
  stopping: number;
  dead: number;
  list: WorkerSnapshot[];
} {
  const now = Date.now();
  let idle = 0;
  let busy = 0;
  let stopping = 0;
  let dead = 0;
  const list: WorkerSnapshot[] = [];

  for (const w of workers.values()) {
    const age = now - new Date(w.last_heartbeat_at).getTime();
    const isDead = age > config.WORKER_STALE_MS;
    if (isDead) dead++;
    else if (w.state === "IDLE") idle++;
    else if (w.state === "BUSY") busy++;
    else if (w.state === "STOPPING") stopping++;

    list.push({
      id: w.worker_id,
      state: w.state,
      task_id: w.task_id,
      job_id: w.job_id,
      task_kind: w.task_kind,
      tasks_done: w.tasks_done,
      last_heartbeat_at: w.last_heartbeat_at,
      hostname: w.hostname,
      pid: w.pid,
      dead: isDead,
    });
  }

  return {
    total: workers.size,
    idle,
    busy,
    stopping,
    dead,
    list,
  };
}

export function isJobBusyOnWorkers(jobId: string): boolean {
  for (const w of workers.values()) {
    if (w.job_id === jobId && w.state === "BUSY") return true;
  }
  return false;
}

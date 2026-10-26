import type pg from "pg";
import type { Channel } from "amqplib";
import { pushEvent } from "../events.js";
import type { Config } from "../config.js";
import type { JobRow, TaskRow } from "../db/types.js";
import type {
  CoordinatorMessage,
  TaskCompleted,
  TaskFailed,
  TaskMessage,
} from "../messages.js";
import * as paths from "../paths.js";
import { failJob } from "./failJob.js";
import { barrier, schedule } from "./scheduler.js";

export interface HandlerResult {
  relaySignal: boolean;
  jobStopped: boolean;
  jobId?: string;
  stopStatus?: "FAILED" | "CANCELLED";
}

export async function onCompleted(
  client: pg.PoolClient,
  job: JobRow,
  msg: TaskCompleted,
): Promise<HandlerResult> {
  const result: HandlerResult = { relaySignal: false, jobStopped: false };

  const { rows } = await client.query<TaskRow>(
    `UPDATE tasks SET status = 'DONE', completed_at = now(),
            worker_id = $2, duration_ms = $3
     WHERE id = $1 AND status IN ('CREATED', 'PUBLISHED')
     RETURNING *`,
    [msg.task_id, msg.worker_id, msg.duration_ms],
  );
  const task = rows[0];
  if (!task) {
    pushEvent({
      type: "duplicate_completion",
      job_id: job.id,
      task_id: msg.task_id,
    });
    return result;
  }

  if (task.kind === "GENERATE") {
    const {
      rows: [updated],
    } = await client.query<{ generated_files: number }>(
      `UPDATE jobs SET generated_files = generated_files + $2
       WHERE id = $1 RETURNING generated_files`,
      [job.id, task.file_count ?? 0],
    );
    if (updated && updated.generated_files === job.f) {
      await barrier(client, job);
      result.relaySignal = true;
    }
  } else {
    await client.query(
      `UPDATE items SET state = 'CONSUMED' WHERE reserved_by = $1`,
      [task.id],
    );
    if (task.is_final) {
      await client.query(
        `UPDATE jobs SET status = 'COMPLETED', finished_at = now() WHERE id = $1`,
        [job.id],
      );
      pushEvent({ type: "job_completed", job_id: job.id });
    } else {
      const relPath = paths.partialPath(job.id, task.id);
      await client.query(
        `INSERT INTO items (id, job_id, kind, count, level, path, produced_by, state)
         VALUES (gen_random_uuid(), $1, 'PARTIAL', $2, $3, $4, $5, 'READY')`,
        [job.id, task.input_count, task.level, relPath, task.id],
      );
      result.relaySignal = await schedule(client, job);
    }
  }
  return result;
}

export async function onFailed(
  client: pg.PoolClient,
  job: JobRow,
  msg: TaskFailed,
  config: Config,
  controlCh: Channel | null,
): Promise<HandlerResult> {
  const result: HandlerResult = { relaySignal: false, jobStopped: false };

  const { rows } = await client.query<TaskRow>(
    `SELECT * FROM tasks WHERE id = $1 AND attempt = $2
     AND status IN ('CREATED', 'PUBLISHED') FOR UPDATE`,
    [msg.task_id, msg.attempt],
  );
  const task = rows[0];
  if (!task) {
    pushEvent({
      type: "stale_failure",
      job_id: job.id,
      task_id: msg.task_id,
    });
    return result;
  }

  if (task.attempt < config.MAX_ATTEMPTS) {
    await client.query(
      `UPDATE tasks SET attempt = attempt + 1, status = 'CREATED', last_error = $2
       WHERE id = $1`,
      [task.id, msg.error.message],
    );
    pushEvent({
      type: "task_retry",
      job_id: job.id,
      task_id: task.id,
      message: msg.error.message,
    });
    result.relaySignal = true;
  } else {
    await client.query(
      `UPDATE tasks SET status = 'FAILED', last_error = $2 WHERE id = $1`,
      [task.id, msg.error.message],
    );
    const reason = `task ${task.id} failed ${config.MAX_ATTEMPTS} times: ${msg.error.message}`;
    await failJob(client, job, reason, controlCh);
    result.jobStopped = true;
    result.jobId = job.id;
    result.stopStatus = "FAILED";
  }
  return result;
}

export async function onDead(
  client: pg.PoolClient,
  job: JobRow,
  msg: TaskMessage,
  controlCh: Channel | null,
): Promise<HandlerResult> {
  const result: HandlerResult = { relaySignal: false, jobStopped: false };

  const { rows } = await client.query<TaskRow>(
    `SELECT * FROM tasks WHERE id = $1 AND status IN ('CREATED', 'PUBLISHED')`,
    [msg.task_id],
  );
  const task = rows[0];
  if (!task) return result;

  pushEvent({
    type: "task_dead_lettered",
    job_id: job.id,
    task_id: task.id,
  });
  await client.query(
    `UPDATE tasks SET status = 'FAILED', last_error = 'delivery limit exceeded' WHERE id = $1`,
    [task.id],
  );
  const reason = `task ${task.id} exceeded delivery limit (worker crash loop)`;
  await failJob(client, job, reason, controlCh);
  result.jobStopped = true;
  result.jobId = job.id;
  result.stopStatus = "FAILED";
  return result;
}

export async function routeMessage(
  client: pg.PoolClient,
  job: JobRow,
  msg: CoordinatorMessage,
  config: Config,
  controlCh: Channel | null,
): Promise<HandlerResult> {
  switch (msg.routingKey) {
    case "task.completed":
      return onCompleted(client, job, msg.body);
    case "task.failed":
      return onFailed(client, job, msg.body, config, controlCh);
    case "dead":
      return onDead(client, job, msg.body, controlCh);
    default:
      return { relaySignal: false, jobStopped: false };
  }
}

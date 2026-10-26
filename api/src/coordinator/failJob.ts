import type pg from "pg";
import type { Channel } from "amqplib";
import { pushEvent } from "../events.js";
import type { JobRow } from "../db/types.js";
import { publishJobStopped } from "../mq/connection.js";

export async function failJob(
  client: pg.PoolClient,
  job: JobRow,
  reason: string,
  controlCh: Channel | null,
): Promise<void> {
  await client.query(
    `UPDATE jobs SET status = 'FAILED', failure_reason = $2, finished_at = now()
     WHERE id = $1`,
    [job.id, reason],
  );
  await client.query(
    `UPDATE tasks SET status = 'CANCELLED'
     WHERE job_id = $1 AND status IN ('CREATED', 'PUBLISHED')`,
    [job.id],
  );
  pushEvent({ type: "job_failed", job_id: job.id, message: reason });
  if (controlCh) {
    await publishJobStopped(controlCh, {
      schema_version: 1,
      type: "job.stopped",
      job_id: job.id,
      status: "FAILED",
    });
  }
}

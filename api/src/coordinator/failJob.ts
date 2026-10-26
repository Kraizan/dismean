/** Mark job FAILED and queue post-commit events. See docs/code-map.md · LLD §5. */
import type pg from "pg";
import { pushEvent, type AppEvent } from "../events.js";
import type { JobRow } from "../db/types.js";

export type PendingEvent = Omit<AppEvent, "id" | "at"> & { at?: string };

export async function failJob(
  client: pg.PoolClient,
  job: JobRow,
  reason: string,
  events?: PendingEvent[],
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
  const ev: PendingEvent = {
    type: "job_failed",
    job_id: job.id,
    message: reason,
  };
  if (events) {
    events.push(ev);
  } else {
    pushEvent(ev);
  }
}

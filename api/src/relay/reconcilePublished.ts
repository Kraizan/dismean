import type pg from "pg";
import type { Config } from "../config.js";
import { pushEvent } from "../events.js";
import { getTasksQueueDepth } from "../mq/queueStats.js";
import { isTaskBusyOnWorkers } from "../stats/workers.js";

/** Reset orphaned PUBLISHED rows so the outbox can republish (ITD-037). */
export async function reconcileStalePublished(
  pool: pg.Pool,
  config: Config,
  options?: { startup?: boolean },
): Promise<number> {
  const depth = await getTasksQueueDepth(config);
  const queueIdle = depth.ready === 0 && depth.unacked === 0;

  const client = await pool.connect();
  try {
    if (options?.startup && queueIdle) {
      const { rowCount } = await client.query(
        `UPDATE tasks t SET status = 'CREATED', published_at = NULL
         FROM jobs j
         WHERE t.job_id = j.id AND t.status = 'PUBLISHED'
           AND j.status IN ('GENERATING', 'REDUCING')`,
      );
      const n = rowCount ?? 0;
      if (n > 0) {
        pushEvent({
          type: "cleanup_ran",
          message: `reconciled ${n} PUBLISHED tasks (empty dm.tasks at startup)`,
          data: { tasks_reset: n },
        });
      }
      return n;
    }

    const { rows } = await client.query<{ id: string }>(
      `SELECT t.id FROM tasks t
       JOIN jobs j ON j.id = t.job_id
       WHERE t.status = 'PUBLISHED'
         AND j.status IN ('GENERATING', 'REDUCING')
         AND t.published_at <= now() - ($1::bigint * interval '1 millisecond')`,
      [config.PUBLISHED_STALE_MS],
    );
    let reset = 0;
    for (const { id } of rows) {
      if (isTaskBusyOnWorkers(id, config)) continue;
      const { rowCount } = await client.query(
        `UPDATE tasks SET status = 'CREATED', published_at = NULL
         WHERE id = $1 AND status = 'PUBLISHED'`,
        [id],
      );
      reset += rowCount ?? 0;
    }
    if (reset > 0) {
      pushEvent({
        type: "cleanup_ran",
        message: `reconciled ${reset} stale PUBLISHED tasks`,
        data: { tasks_reset: reset },
      });
    }
    return reset;
  } finally {
    client.release();
  }
}

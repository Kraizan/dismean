import type pg from "pg";
import { pushEvent } from "../events.js";
import type { JobRow } from "../db/types.js";
import * as paths from "../paths.js";
import type { PendingEvent } from "./failJob.js";

export async function openMerges(
  client: pg.PoolClient,
  jobId: string,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tasks
     WHERE job_id = $1 AND kind = 'MERGE' AND status IN ('CREATED', 'PUBLISHED')`,
    [jobId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function createMerge(
  client: pg.PoolClient,
  job: JobRow,
  itemIds: string[],
): Promise<string> {
  const { rows: items } = await client.query<{
    id: string;
    count: number;
    level: number;
  }>(
    `SELECT id, count, level FROM items WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [itemIds],
  );
  const total = items.reduce((s, i) => s + i.count, 0);
  const maxLevel = items.reduce((m, i) => Math.max(m, i.level), 0);
  const isFinal = total === job.f;

  const {
    rows: [task],
  } = await client.query<{ id: string }>(
    `INSERT INTO tasks (id, job_id, kind, level, input_count, is_final, status)
     VALUES (gen_random_uuid(), $1, 'MERGE', $2, $3, $4, 'CREATED')
     RETURNING id`,
    [job.id, 1 + maxLevel, total, isFinal],
  );

  const taskId = task!.id;
  await client.query(
    `UPDATE items SET state = 'RESERVED', reserved_by = $1
     WHERE id = ANY($2::uuid[])`,
    [taskId, itemIds],
  );
  return taskId;
}

export async function schedule(
  client: pg.PoolClient,
  job: JobRow,
): Promise<boolean> {
  let created = false;
  for (;;) {
    const { rows: ready } = await client.query<{
      id: string;
      count: number;
      level: number;
    }>(
      `SELECT id, count, level FROM items
       WHERE job_id = $1 AND state = 'READY'
       ORDER BY created_at, id LIMIT 5`,
      [job.id],
    );

    if (ready.length === 5) {
      await createMerge(client, job, ready.map((r) => r.id));
      created = true;
      continue;
    }

    const open = await openMerges(client, job.id);
    if (ready.length >= 2 && open === 0) {
      await createMerge(client, job, ready.map((r) => r.id));
      created = true;
      continue;
    }
    break;
  }
  return created;
}

export async function createLeafMerges(
  client: pg.PoolClient,
  jobId: string,
  f: number,
): Promise<void> {
  await client.query(
    `
    WITH numbered AS (
      SELECT id, (row_number() OVER (ORDER BY path) - 1) / 5 AS grp
      FROM items WHERE job_id = $1 AND state = 'READY'
    ), groups AS (
      SELECT grp, gen_random_uuid() AS task_id
      FROM numbered GROUP BY grp HAVING count(*) = 5
    ), ins AS (
      INSERT INTO tasks (id, job_id, kind, level, input_count, is_final, status)
      SELECT task_id, $1, 'MERGE', 1, 5, (5 = $2), 'CREATED' FROM groups
    )
    UPDATE items i SET state = 'RESERVED', reserved_by = g.task_id
    FROM numbered n JOIN groups g USING (grp)
    WHERE i.id = n.id
    `,
    [jobId, f],
  );
}

export async function barrier(
  client: pg.PoolClient,
  job: JobRow,
  events?: PendingEvent[],
): Promise<boolean> {
  await client.query(
    `UPDATE jobs SET status = 'REDUCING', generation_completed_at = now() WHERE id = $1`,
    [job.id],
  );

  const prefix = paths.inputPrefix(job.id);
  await client.query(
    `INSERT INTO items (id, job_id, kind, count, level, path, state)
     SELECT gen_random_uuid(), $1, 'INPUT', 1, 0,
            $2 || lpad(i::text, 6, '0') || '.npy', 'READY'
     FROM generate_series(0, $3 - 1) AS i`,
    [job.id, prefix, job.f],
  );

  await createLeafMerges(client, job.id, job.f);
  const scheduled = await schedule(client, job);
  const ev: PendingEvent = { type: "generation_completed", job_id: job.id };
  if (events) {
    events.push(ev);
  } else {
    pushEvent(ev);
  }
  return scheduled;
}

export async function liveItemCount(
  client: pg.PoolClient,
  jobId: string,
): Promise<number> {
  const { rows } = await client.query<{ sum: string | null }>(
    `SELECT sum(count)::text AS sum FROM items
     WHERE job_id = $1 AND state IN ('READY', 'RESERVED')`,
    [jobId],
  );
  return Number(rows[0]?.sum ?? 0);
}

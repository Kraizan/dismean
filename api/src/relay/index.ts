import type { EventEmitter } from "node:events";
import type { ChannelModel, ConfirmChannel } from "amqplib";
import type pg from "pg";
import type { Config } from "../config.js";
import type { TaskRow } from "../db/types.js";
import type { TaskMessage } from "../messages.js";
import * as paths from "../paths.js";
import { RELAY_SIGNAL } from "../coordinator/index.js";
import {
  QUEUE_TASKS,
  createConfirmChannel,
  publishTaskBatch,
} from "../mq/connection.js";
import { reconcileStalePublished } from "./reconcilePublished.js";

/** The job that received the last dispatched task; the next round starts after it. */
export interface DispatchCursor {
  jobId: string;
}

interface ItemInput {
  id: string;
  path: string;
  count: number;
  reserved_by: string;
}

type DispatchRow = TaskRow & { c: number; seed: string };

/**
 * Fair-share order (ITD-034): one task per active job per round, rotating the starting job
 * from the cursor; within a job, deepest MERGE first, then other MERGEs, then GENERATE.
 */
export async function selectTasksForDispatch(
  client: pg.PoolClient,
  budget: number,
  cursor: DispatchCursor | null,
): Promise<string[]> {
  if (budget <= 0) return [];
  // The cursor's timestamp is read in SQL: a JS Date would drop Postgres microseconds.
  const { rows } = await client.query<{ id: string }>(
    `WITH cur AS (
       SELECT created_at, id FROM jobs WHERE id = $2::uuid
     ), ranked AS (
       SELECT t.id, j.id AS job_id, j.created_at AS job_created,
              row_number() OVER (
                PARTITION BY t.job_id
                ORDER BY (t.kind = 'MERGE') DESC, t.level DESC, t.created_at, t.id
              ) AS rn
       FROM tasks t JOIN jobs j ON j.id = t.job_id
       WHERE t.status = 'CREATED' AND j.status IN ('GENERATING', 'REDUCING')
     )
     SELECT r.id FROM ranked r LEFT JOIN cur ON true
     WHERE r.rn <= $1
     ORDER BY r.rn,
       CASE WHEN cur.id IS NULL OR (r.job_created, r.job_id) > (cur.created_at, cur.id)
            THEN 0 ELSE 1 END,
       r.job_created, r.job_id
     LIMIT $1`,
    [budget, cursor?.jobId ?? null],
  );
  return rows.map((r) => r.id);
}

function buildTaskMessage(row: DispatchRow, inputs: ItemInput[]): TaskMessage {
  if (row.kind === "GENERATE") {
    const fileStart = row.file_start ?? 0;
    const fileCount = row.file_count ?? 0;
    const indices = Array.from({ length: fileCount }, (_, i) => fileStart + i);
    return {
      schema_version: 1,
      task_id: row.id,
      job_id: row.job_id,
      attempt: row.attempt,
      kind: "GENERATE",
      c: row.c,
      generate: {
        seed: Number(row.seed),
        file_indices: indices,
        output_paths: indices.map((idx) => paths.inputPath(row.job_id, idx)),
      },
    };
  }

  const mergeInputs = inputs.map((i) => ({ item_id: i.id, path: i.path, count: i.count }));
  return {
    schema_version: 1,
    task_id: row.id,
    job_id: row.job_id,
    attempt: row.attempt,
    kind: "MERGE",
    c: row.c,
    merge: row.is_final
      ? {
          inputs: mergeInputs,
          output_path: null,
          final: true,
          total_count: mergeInputs.reduce((s, i) => s + i.count, 0),
          result_paths: paths.resultPaths(row.job_id),
        }
      : {
          inputs: mergeInputs,
          output_path: paths.partialPath(row.job_id, row.id),
          final: false,
          total_count: null,
          result_paths: null,
        },
  };
}

/** Free slots in dm.tasks: about `factor` queued tasks per consuming worker (ITD-034). */
export async function dispatchBudget(
  ch: ConfirmChannel,
  config: Config,
): Promise<number> {
  const q = await ch.checkQueue(QUEUE_TASKS);
  const target = config.DISPATCH_QUEUE_FACTOR * q.consumerCount;
  return Math.max(0, Math.min(config.RELAY_BATCH, target - q.messageCount));
}

export async function relayOnce(
  pool: pg.Pool,
  confirmCh: ConfirmChannel,
  config: Config,
  state: { cursor: DispatchCursor | null },
  budgetOverride?: number,
): Promise<number> {
  const budget = budgetOverride ?? (await dispatchBudget(confirmCh, config));
  if (budget <= 0) {
    await reconcileStalePublished(pool, config).catch((err) =>
      console.error("reconcile PUBLISHED error", err),
    );
    return 0;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await selectTasksForDispatch(client, budget, state.cursor);
    if (ids.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    const { rows } = await client.query<DispatchRow>(
      `SELECT t.*, j.c, j.seed::text AS seed FROM tasks t
       JOIN jobs j ON j.id = t.job_id
       WHERE t.id = ANY($1::uuid[]) AND t.status = 'CREATED'
       FOR UPDATE OF t SKIP LOCKED`,
      [ids],
    );
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    if (rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    const mergeIds = rows.filter((r) => r.kind === "MERGE").map((r) => r.id);
    const inputsByTask = new Map<string, ItemInput[]>();
    if (mergeIds.length > 0) {
      const { rows: items } = await client.query<ItemInput>(
        `SELECT id, path, count, reserved_by FROM items
         WHERE reserved_by = ANY($1::uuid[]) ORDER BY path`,
        [mergeIds],
      );
      for (const it of items) {
        const list = inputsByTask.get(it.reserved_by) ?? [];
        list.push(it);
        inputsByTask.set(it.reserved_by, list);
      }
    }

    const messages = rows.map((r) => buildTaskMessage(r, inputsByTask.get(r.id) ?? []));
    await publishTaskBatch(confirmCh, messages);

    await client.query(
      `UPDATE tasks SET status = 'PUBLISHED', published_at = now()
       WHERE id = ANY($1::uuid[]) AND status = 'CREATED'`,
      [rows.map((r) => r.id)],
    );
    await client.query("COMMIT");

    state.cursor = { jobId: rows[rows.length - 1]!.job_id };
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function startRelay(
  pool: pg.Pool,
  conn: ChannelModel,
  config: Config,
  relayEmitter: EventEmitter,
): Promise<{ stop: () => void; channel: ConfirmChannel }> {
  let stopped = false;
  const confirmCh = await createConfirmChannel(conn);
  const state: { cursor: DispatchCursor | null } = { cursor: null };
  let ticking = false;
  let pendingSignal = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (ticking) {
      pendingSignal = true;
      return;
    }
    ticking = true;
    try {
      do {
        pendingSignal = false;
        await relayOnce(pool, confirmCh, config, state);
      } while (pendingSignal && !stopped);
    } catch (err) {
      console.error("relay error", err);
    } finally {
      ticking = false;
    }
  };

  await reconcileStalePublished(pool, config, { startup: true }).catch(
    (err) => console.error("startup reconcile PUBLISHED error", err),
  );
  await tick();

  const interval = setInterval(() => void tick(), config.RELAY_INTERVAL_MS);
  const onSignal = () => void tick();
  relayEmitter.on(RELAY_SIGNAL, onSignal);

  return {
    channel: confirmCh,
    stop: () => {
      stopped = true;
      clearInterval(interval);
      relayEmitter.off(RELAY_SIGNAL, onSignal);
    },
  };
}

import type { EventEmitter } from "node:events";
import type { ConfirmChannel } from "amqplib";
import type pg from "pg";
import type { Config } from "../config.js";
import type { TaskRow } from "../db/types.js";
import type { TaskMessage } from "../messages.js";
import * as paths from "../paths.js";
import { RELAY_SIGNAL } from "../coordinator/index.js";
import { createConfirmChannel, publishTask } from "../mq/connection.js";

interface ItemInput {
  id: string;
  path: string;
  count: number;
}

async function buildTaskMessage(
  client: pg.PoolClient,
  row: TaskRow,
  c: number,
): Promise<TaskMessage> {
  if (row.kind === "GENERATE") {
    const fileStart = row.file_start ?? 0;
    const fileCount = row.file_count ?? 0;
    const indices: number[] = [];
    const output_paths: string[] = [];
    for (let i = 0; i < fileCount; i++) {
      const idx = fileStart + i;
      indices.push(idx);
      output_paths.push(paths.inputPath(row.job_id, idx));
    }
    const { rows: seeds } = await client.query<{ seed: string }>(
      `SELECT seed::text FROM jobs WHERE id = $1`,
      [row.job_id],
    );
    return {
      schema_version: 1,
      task_id: row.id,
      job_id: row.job_id,
      attempt: row.attempt,
      kind: "GENERATE",
      c,
      generate: {
        seed: Number(seeds[0]?.seed ?? 0),
        file_indices: indices,
        output_paths,
      },
    };
  }

  const { rows: inputs } = await client.query<ItemInput>(
    `SELECT id, path, count FROM items WHERE reserved_by = $1 ORDER BY path`,
    [row.id],
  );

  if (row.is_final) {
    const result_paths = paths.resultPaths(row.job_id);
    return {
      schema_version: 1,
      task_id: row.id,
      job_id: row.job_id,
      attempt: row.attempt,
      kind: "MERGE",
      c,
      merge: {
        inputs: inputs.map((i) => ({
          item_id: i.id,
          path: i.path,
          count: i.count,
        })),
        output_path: null,
        final: true,
        total_count: inputs.reduce((s, i) => s + i.count, 0),
        result_paths,
      },
    };
  }

  return {
    schema_version: 1,
    task_id: row.id,
    job_id: row.job_id,
    attempt: row.attempt,
    kind: "MERGE",
    c,
    merge: {
      inputs: inputs.map((i) => ({
        item_id: i.id,
        path: i.path,
        count: i.count,
      })),
      output_path: paths.partialPath(row.job_id, row.id),
      final: false,
      total_count: null,
      result_paths: null,
    },
  };
}

export async function relayOnce(
  pool: pg.Pool,
  confirmCh: ConfirmChannel,
  config: Config,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<TaskRow & { c: number }>(
      `SELECT t.*, j.c FROM tasks t
       JOIN jobs j ON j.id = t.job_id
       WHERE t.status = 'CREATED'
       ORDER BY t.created_at
       LIMIT $1
       FOR UPDATE OF t SKIP LOCKED`,
      [config.RELAY_BATCH],
    );

    if (rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    const messages: TaskMessage[] = [];
    for (const row of rows) {
      messages.push(await buildTaskMessage(client, row, row.c));
    }

    for (const msg of messages) {
      await publishTask(confirmCh, msg);
    }

    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE tasks SET status = 'PUBLISHED', published_at = now()
       WHERE id = ANY($1::uuid[]) AND status = 'CREATED'`,
      [ids],
    );

    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function startRelay(
  pool: pg.Pool,
  conn: import("amqplib").ChannelModel,
  config: Config,
  relayEmitter: EventEmitter,
): Promise<{ stop: () => void; channel: ConfirmChannel }> {
  let stopped = false;
  const confirmCh = await createConfirmChannel(conn);
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await relayOnce(pool, confirmCh, config);
    } catch (err) {
      console.error("relay error", err);
    } finally {
      ticking = false;
    }
  };

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

/** Pool scheduler integration. See docs/code-map.md · LLD §5. */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { onCompleted } from "../src/coordinator/handlers.js";
import { liveFileCoverage } from "../src/coordinator/scheduler.js";
import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import type { JobRow } from "../src/db/types.js";
import { reductionProgress } from "../src/stats/progress.js";

const runIntegration = process.env.DISMEAN_INTEGRATION === "1";

type Order = "random" | "newest-first" | "one-slow-worker";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadJob(client: pg.PoolClient, id: string): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return rows[0]!;
}

async function openTasks(client: pg.PoolClient, jobId: string, kind: string) {
  const { rows } = await client.query<{ id: string; input_count: number | null; file_count: number | null }>(
    `SELECT id, input_count, file_count FROM tasks
     WHERE job_id = $1 AND kind = $2 AND status IN ('CREATED', 'PUBLISHED')
     ORDER BY created_at, id`,
    [jobId, kind],
  );
  return rows;
}

async function liveRows(client: pg.PoolClient, jobId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM items WHERE job_id = $1 AND state IN ('READY', 'RESERVED')`,
    [jobId],
  );
  return Number(rows[0]!.n);
}

/** Drives the real coordinator handlers and scheduler SQL through a whole job. */
async function runJob(client: pg.PoolClient, f: number, order: Order, seed: number) {
  const rnd = mulberry32(seed);
  const jobId = crypto.randomUUID();
  await client.query(
    `WITH j AS (INSERT INTO jobs (id, f, c, seed) VALUES ($1, $2, 3, 1) RETURNING id, f)
     INSERT INTO tasks (id, job_id, kind, level, file_start, file_count)
     SELECT gen_random_uuid(), j.id, 'GENERATE', 0, s, LEAST(5, j.f - s)
     FROM j, generate_series(0, j.f - 1, 5) AS s`,
    [jobId, f],
  );

  const gens = await openTasks(client, jobId, "GENERATE");
  const shuffled = [...gens].sort(() => rnd() - 0.5);
  for (const t of shuffled) {
    await onCompleted(client, await loadJob(client, jobId), {
      schema_version: 1, task_id: t.id, job_id: jobId, attempt: 1, kind: "GENERATE",
      worker_id: "w", duration_ms: 1, output: { files_written: t.file_count! },
    });
  }
  expect((await loadJob(client, jobId)).status).toBe("REDUCING");

  let slowTask: string | null = null;
  let lastProgress = -1;
  for (let guard = 0; guard < 10 * f; guard++) {
    const job = await loadJob(client, jobId);
    if (job.status === "COMPLETED") break;

    expect(await liveFileCoverage(client, jobId)).toBe(f);
    const progress = reductionProgress(job.status, f, await liveRows(client, jobId));
    expect(progress).toBeGreaterThanOrEqual(lastProgress);
    expect(progress).toBeLessThan(1);
    lastProgress = progress;

    const open = await openTasks(client, jobId, "MERGE");
    expect(open.length).toBeGreaterThan(0);
    let pick = open[Math.floor(rnd() * open.length)]!;
    if (order === "newest-first") pick = open[open.length - 1]!;
    if (order === "one-slow-worker") {
      slowTask ??= open[0]!.id;
      const others = open.filter((t) => t.id !== slowTask);
      pick = others.length > 0 ? others[Math.floor(rnd() * others.length)]! : open[0]!;
    }
    await onCompleted(client, job, {
      schema_version: 1, task_id: pick.id, job_id: jobId, attempt: 1, kind: "MERGE",
      worker_id: "w", duration_ms: 1, output: { count: pick.input_count! },
    });
  }

  const { rows: merges } = await client.query<{ total: string; finals: string }>(
    `SELECT count(*)::text AS total, count(*) FILTER (WHERE is_final)::text AS finals
     FROM tasks WHERE job_id = $1 AND kind = 'MERGE' AND status = 'DONE'`,
    [jobId],
  );
  return {
    status: (await loadJob(client, jobId)).status,
    merges: Number(merges[0]!.total),
    finals: Number(merges[0]!.finals),
  };
}

describe.runIf(runIntegration)("scheduler over real SQL (design doc §9)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = getPool(loadConfig());
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const sizes = [2, 3, 4, 5, 6, 7, 9, 11, 12, 24, 25, 26, 57, 126];
  const orders: Order[] = ["random", "newest-first", "one-slow-worker"];

  for (const order of orders) {
    it(`completes with ⌈(F−1)/4⌉ merges and one final merge (${order})`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const [i, f] of sizes.entries()) {
          const r = await runJob(client, f, order, 1000 + i);
          expect(r.status, `f=${f}`).toBe("COMPLETED");
          expect(r.finals, `f=${f}`).toBe(1);
          expect(r.merges, `f=${f}`).toBe(Math.ceil((f - 1) / 4));
        }
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }, 60_000);
  }
});

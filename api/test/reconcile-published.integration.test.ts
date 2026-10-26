import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { reconcileStalePublished } from "../src/relay/reconcilePublished.js";

describe("reconcileStalePublished", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!process.env.DISMEAN_INTEGRATION) return;
    const config = loadConfig();
    pool = getPool(config);
    await runMigrations(pool);
  });

  it("resets stale PUBLISHED when no worker is busy on that task", async () => {
    if (!process.env.DISMEAN_INTEGRATION) return;
    const config = loadConfig();
    const jobId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query(`INSERT INTO jobs (id, f, c, seed) VALUES ($1, 5, 3, 1)`, [jobId]);
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, file_start, file_count, status, published_at)
         VALUES ($1, $2, 'GENERATE', 0, 0, 5, 'PUBLISHED', now() - interval '10 minutes')`,
        [taskId, jobId],
      );
      const n = await reconcileStalePublished(pool, config);
      expect(n).toBeGreaterThanOrEqual(1);
      const { rows } = await client.query<{ status: string }>(
        `SELECT status::text AS status FROM tasks WHERE id = $1`,
        [taskId],
      );
      expect(rows[0]!.status).toBe("CREATED");
      await client.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
    } finally {
      client.release();
    }
  });
});

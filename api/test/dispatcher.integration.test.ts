import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { selectTasksForDispatch } from "../src/relay/index.js";

const runIntegration = process.env.DISMEAN_INTEGRATION === "1";

describe.runIf(runIntegration)("fair-share dispatch order (ITD-003)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = getPool(loadConfig());
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function setup(client: pg.PoolClient) {
    // Hide tasks of any other live job inside this rolled-back transaction.
    await client.query(`UPDATE tasks SET status = 'CANCELLED' WHERE status = 'CREATED'`);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await client.query(
      `INSERT INTO jobs (id, file_count, values_per_file, seed, status, created_at) VALUES
         ($1, 50, 3, 1, 'REDUCING', now() - interval '2 minutes'),
         ($2, 50, 3, 1, 'GENERATING', now() - interval '1 minute')`,
      [a, b],
    );
    const ids = {
      aMerge2: crypto.randomUUID(),
      aMerge1: crypto.randomUUID(),
      aGen: crypto.randomUUID(),
      bGen1: crypto.randomUUID(),
      bGen2: crypto.randomUUID(),
    };
    await client.query(
      `INSERT INTO tasks (id, job_id, kind, level, input_count, file_start, file_count, created_at) VALUES
         ($1, $6, 'MERGE', 2, 25, NULL, NULL, now() - interval '30 seconds'),
         ($2, $6, 'MERGE', 1, 5,  NULL, NULL, now() - interval '40 seconds'),
         ($3, $6, 'GENERATE', 0, NULL, 45, 5, now() - interval '50 seconds'),
         ($4, $7, 'GENERATE', 0, NULL, 0, 5,  now() - interval '20 seconds'),
         ($5, $7, 'GENERATE', 0, NULL, 5, 5,  now() - interval '10 seconds')`,
      [ids.aMerge2, ids.aMerge1, ids.aGen, ids.bGen1, ids.bGen2, a, b],
    );
    return { a, b, ids };
  }

  it("interleaves jobs and runs the deepest merge first within a job", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { ids } = await setup(client);
      const order = await selectTasksForDispatch(client, 5, null);
      expect(order).toEqual([ids.aMerge2, ids.bGen1, ids.aMerge1, ids.bGen2, ids.aGen]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rotates the starting job from the cursor so a small budget cannot starve a job", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { a, b, ids } = await setup(client);
      expect(await selectTasksForDispatch(client, 1, { jobId: a })).toEqual([ids.bGen1]);
      expect(await selectTasksForDispatch(client, 1, { jobId: b })).toEqual([ids.aMerge2]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("returns nothing when the budget is zero", async () => {
    const client = await pool.connect();
    try {
      expect(await selectTasksForDispatch(client, 0, null)).toEqual([]);
    } finally {
      client.release();
    }
  });
});

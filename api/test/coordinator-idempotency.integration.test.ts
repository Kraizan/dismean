import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { onCompleted } from "../src/coordinator/handlers.js";
import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import type { JobRow } from "../src/db/types.js";
import type { TaskCompleted } from "../src/messages.js";

const runIntegration = process.env.DISMEAN_INTEGRATION === "1";

describe.runIf(runIntegration)("coordinator idempotency (postgres)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const config = loadConfig();
    pool = getPool(config);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("ignores duplicate GENERATE completion (task counts once)", async () => {
    const jobId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO jobs (id, f, c, seed, generated_files) VALUES ($1, 5, 3, 1, 0)`,
        [jobId],
      );
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, file_start, file_count, status)
         VALUES ($1, $2, 'GENERATE', 0, 0, 5, 'PUBLISHED')`,
        [taskId, jobId],
      );
      const {
        rows: [job],
      } = await client.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
      const msg: TaskCompleted = {
        schema_version: 1,
        task_id: taskId,
        job_id: jobId,
        attempt: 1,
        kind: "GENERATE",
        worker_id: "test-worker",
        duration_ms: 1,
        output: { files_written: 5 },
      };
      await onCompleted(client, job!, msg);
      await onCompleted(client, job!, msg);
      const {
        rows: [after],
      } = await client.query<{ generated_files: number; status: string }>(
        `SELECT generated_files, status::text FROM jobs WHERE id = $1`,
        [jobId],
      );
      expect(after!.generated_files).toBe(5);
      expect(after!.status).toBe("REDUCING");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

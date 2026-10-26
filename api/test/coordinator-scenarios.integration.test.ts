import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { onCompleted, onDead, onFailed } from "../src/coordinator/handlers.js";
import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import type { JobRow, TaskRow } from "../src/db/types.js";
import type { TaskCompleted, TaskFailed, TaskMessage } from "../src/messages.js";

const runIntegration = process.env.DISMEAN_INTEGRATION === "1";

async function loadJob(client: pg.PoolClient, jobId: string): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  return rows[0]!;
}

describe.runIf(runIntegration)("coordinator scenarios (postgres)", () => {
  let pool: pg.Pool;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    config = loadConfig();
    pool = getPool(config);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies generation completions out of order before barrier", async () => {
    const jobId = crypto.randomUUID();
    const taskA = crypto.randomUUID();
    const taskB = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO jobs (id, f, c, seed) VALUES ($1, 10, 4, 99)`,
        [jobId],
      );
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, file_start, file_count, status)
         VALUES ($1, $2, 'GENERATE', 0, 0, 5, 'PUBLISHED'),
                ($3, $2, 'GENERATE', 0, 5, 5, 'PUBLISHED')`,
        [taskA, jobId, taskB],
      );
      const mk = (taskId: string): TaskCompleted => ({
        schema_version: 1,
        task_id: taskId,
        job_id: jobId,
        attempt: 1,
        kind: "GENERATE",
        worker_id: "w",
        duration_ms: 1,
        output: { files_written: 5 },
      });
      let job = await loadJob(client, jobId);
      await onCompleted(client, job, mk(taskB));
      job = await loadJob(client, jobId);
      expect(job.generated_files).toBe(5);
      expect(job.status).toBe("GENERATING");
      await onCompleted(client, job, mk(taskA));
      job = await loadJob(client, jobId);
      expect(job.generated_files).toBe(10);
      expect(job.status).toBe("REDUCING");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("ignores duplicate MERGE completion", async () => {
    const jobId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO jobs (id, f, c, seed, status, generated_files) VALUES ($1, 5, 3, 1, 'REDUCING', 5)`,
        [jobId],
      );
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, input_count, is_final, status)
         VALUES ($1, $2, 'MERGE', 1, 5, true, 'PUBLISHED')`,
        [taskId, jobId],
      );
      const job = await loadJob(client, jobId);
      const msg: TaskCompleted = {
        schema_version: 1,
        task_id: taskId,
        job_id: jobId,
        attempt: 1,
        kind: "MERGE",
        worker_id: "w",
        duration_ms: 1,
        output: { count: 5 },
      };
      await onCompleted(client, job, msg);
      await onCompleted(client, job, msg);
      const { rows } = await client.query<{ status: string }>(
        `SELECT status::text FROM jobs WHERE id = $1`,
        [jobId],
      );
      expect(rows[0]!.status).toBe("COMPLETED");
      const { rows: tasks } = await client.query<TaskRow>(
        `SELECT * FROM tasks WHERE id = $1`,
        [taskId],
      );
      expect(tasks[0]!.status).toBe("DONE");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("retries failed task then fails job after max attempts", async () => {
    const jobId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO jobs (id, f, c, seed) VALUES ($1, 5, 3, 1)`, [jobId]);
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, file_start, file_count, status, attempt)
         VALUES ($1, $2, 'GENERATE', 0, 0, 5, 'PUBLISHED', 3)`,
        [taskId, jobId],
      );
      const job = await loadJob(client, jobId);
      const fail: TaskFailed = {
        schema_version: 1,
        task_id: taskId,
        job_id: jobId,
        attempt: 3,
        kind: "GENERATE",
        worker_id: "w",
        error: { type: "TestError", message: "boom" },
      };
      const result = await onFailed(client, job, fail, config, null);
      expect(result.jobStopped).toBe(true);
      const after = await loadJob(client, jobId);
      expect(after.status).toBe("FAILED");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("resets task to CREATED when attempts remain", async () => {
    const jobId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO jobs (id, f, c, seed) VALUES ($1, 5, 3, 1)`, [jobId]);
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, file_start, file_count, status, attempt)
         VALUES ($1, $2, 'GENERATE', 0, 0, 5, 'PUBLISHED', 1)`,
        [taskId, jobId],
      );
      const job = await loadJob(client, jobId);
      const fail: TaskFailed = {
        schema_version: 1,
        task_id: taskId,
        job_id: jobId,
        attempt: 1,
        kind: "GENERATE",
        worker_id: "w",
        error: { type: "TestError", message: "retry me" },
      };
      const result = await onFailed(client, job, fail, config, null);
      expect(result.relaySignal).toBe(true);
      expect(result.jobStopped).toBe(false);
      const { rows } = await client.query<{ status: string; attempt: number }>(
        `SELECT status::text, attempt FROM tasks WHERE id = $1`,
        [taskId],
      );
      expect(rows[0]!.status).toBe("CREATED");
      expect(rows[0]!.attempt).toBe(2);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("fails job on dead-letter delivery limit", async () => {
    const jobId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO jobs (id, f, c, seed) VALUES ($1, 5, 3, 1)`, [jobId]);
      await client.query(
        `INSERT INTO tasks (id, job_id, kind, level, file_start, file_count, status)
         VALUES ($1, $2, 'GENERATE', 0, 0, 5, 'PUBLISHED')`,
        [taskId, jobId],
      );
      const job = await loadJob(client, jobId);
      const dead: TaskMessage = {
        schema_version: 1,
        task_id: taskId,
        job_id: jobId,
        attempt: 1,
        kind: "GENERATE",
        c: 3,
        generate: { seed: 1, file_indices: [0], output_paths: ["jobs/x/inputs/000000.npy"] },
      };
      const result = await onDead(client, job, dead, null);
      expect(result.jobStopped).toBe(true);
      const after = await loadJob(client, jobId);
      expect(after.status).toBe("FAILED");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

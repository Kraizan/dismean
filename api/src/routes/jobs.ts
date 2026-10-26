import { Router } from "express";
import path from "node:path";
import type { EventEmitter } from "node:events";
import type { Channel } from "amqplib";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { pushEvent } from "../events.js";
import type { JobRow } from "../db/types.js";
import { publishJobStopped } from "../mq/connection.js";
import { inputPath, resultPaths } from "../paths.js";
import { RELAY_SIGNAL } from "../coordinator/index.js";
import { streamCsvFile } from "../storage/csv.js";
import { deleteJobDir } from "../storage/deleteJobDir.js";
import crypto from "node:crypto";

const createBodySchema = z.object({
  f: z.number().int().min(2).max(99_999),
  c: z.number().int().min(2).max(999_999),
});

const listQuerySchema = z.object({
  status: z
    .enum([
      "GENERATING",
      "REDUCING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ])
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function mergeTaskEstimate(f: number): number {
  return Math.ceil((f - 1) / 4);
}

function jobEstimate(f: number, c: number) {
  const merge_tasks = mergeTaskEstimate(f);
  return {
    input_bytes: f * c,
    peak_partial_bytes: (merge_tasks - 1) * 8 * c,
    generate_tasks: Math.ceil(f / 5),
    merge_tasks,
  };
}

async function taskCounts(pool: pg.Pool, jobId: string) {
  const { rows } = await pool.query<{ kind: string; status: string; count: string }>(
    `SELECT kind::text, status::text, count(*)::text AS count
     FROM tasks WHERE job_id = $1 GROUP BY kind, status`,
    [jobId],
  );
  const tasks: Record<string, Record<string, number>> = {
    GENERATE: {},
    MERGE: {},
  };
  for (const row of rows) {
    const bucket = tasks[row.kind] ?? {};
    bucket[row.status] = Number(row.count);
    tasks[row.kind] = bucket;
  }
  return tasks;
}

async function jobTimings(pool: pg.Pool, jobId: string) {
  const { rows } = await pool.query<{
    kind: string;
    total_ms: string | null;
  }>(
    `SELECT kind::text, sum(duration_ms)::text AS total_ms
     FROM tasks WHERE job_id = $1 AND status = 'DONE'
     GROUP BY kind`,
    [jobId],
  );
  let generation: number | null = null;
  let reduction: number | null = null;
  for (const row of rows) {
    const ms = row.total_ms ? Number(row.total_ms) : null;
    if (row.kind === "GENERATE") generation = ms;
    if (row.kind === "MERGE") reduction = ms;
  }
  const total =
    generation !== null && reduction !== null
      ? generation + reduction
      : generation ?? reduction;
  return { generation, reduction, total };
}

async function reductionProgress(
  pool: pg.Pool,
  job: JobRow,
): Promise<number> {
  if (job.status === "COMPLETED") return 1;
  if (job.status === "GENERATING") return 0;
  const { rows } = await pool.query<{ sum: string | null }>(
    `SELECT sum(count)::text AS sum FROM items
     WHERE job_id = $1 AND state IN ('READY', 'RESERVED')`,
    [job.id],
  );
  const live = Number(rows[0]?.sum ?? 0);
  if (job.f <= 1) return 1;
  return 1 - (live - 1) / (job.f - 1);
}

async function formatJob(pool: pg.Pool, job: JobRow) {
  const tasks = await taskCounts(pool, job.id);
  const timings_ms = await jobTimings(pool, job.id);
  const estimate = jobEstimate(job.f, job.c);
  const progress = {
    generation: job.generated_files / job.f,
    reduction: await reductionProgress(pool, job),
  };
  return {
    id: job.id,
    f: job.f,
    c: job.c,
    status: job.status,
    seed: Number(job.seed),
    generated_files: job.generated_files,
    failure_reason: job.failure_reason,
    created_at: job.created_at.toISOString(),
    generation_completed_at: job.generation_completed_at?.toISOString() ?? null,
    finished_at: job.finished_at?.toISOString() ?? null,
    progress,
    tasks,
    timings_ms,
    estimate,
  };
}

function randomSeed(): number {
  // randomInt max must be a safe integer; seed fits in Postgres bigint.
  return Number(crypto.randomBytes(6).readUIntBE(0, 6));
}

export function jobsRouter(
  pool: pg.Pool,
  config: Config,
  controlCh: Channel,
  relayEmitter: EventEmitter,
): Router {
  const router = Router();

  router.post("/jobs", async (req, res, next) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation failed", details: parsed.error.flatten() });
      return;
    }
    const { f, c } = parsed.data;
    const id = crypto.randomUUID();
    const seed = randomSeed();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
        WITH j AS (
          INSERT INTO jobs (id, f, c, seed) VALUES ($1, $2, $3, $4) RETURNING id, f
        )
        INSERT INTO tasks (id, job_id, kind, level, file_start, file_count)
        SELECT gen_random_uuid(), j.id, 'GENERATE', 0, s, LEAST(5, j.f - s)
        FROM j, generate_series(0, j.f - 1, 5) AS s
        `,
        [id, f, c, seed],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
      return;
    } finally {
      client.release();
    }

    pushEvent({ type: "job_created", job_id: id });
    relayEmitter.emit(RELAY_SIGNAL);

    const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [
      id,
    ]);
    const job = await formatJob(pool, rows[0]!);
    res.status(201).json(job);
  });

  router.get("/jobs", async (req, res, next) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid query" });
      return;
    }
    const { status, limit, offset } = parsed.data;
    try {
      const params: unknown[] = [limit, offset];
      let sql = `SELECT * FROM jobs`;
      if (status) {
        sql += ` WHERE status = $3`;
        params.push(status);
      }
      sql += ` ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
      const { rows } = await pool.query<JobRow>(sql, params);
      const jobs = await Promise.all(rows.map((j) => formatJob(pool, j)));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id", async (req, res, next) => {
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [req.params.id],
      );
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await formatJob(pool, job));
    } catch (err) {
      next(err);
    }
  });

  router.post("/jobs/:id/cancel", async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const job = rows[0];
      if (!job) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "not found" });
        return;
      }
      if (job.status !== "GENERATING" && job.status !== "REDUCING") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "job not active" });
        return;
      }
      await client.query(
        `UPDATE jobs SET status = 'CANCELLED', finished_at = now() WHERE id = $1`,
        [job.id],
      );
      await client.query(
        `UPDATE tasks SET status = 'CANCELLED'
         WHERE job_id = $1 AND status IN ('CREATED', 'PUBLISHED')`,
        [job.id],
      );
      await client.query("COMMIT");

      await publishJobStopped(controlCh, {
        schema_version: 1,
        type: "job.stopped",
        job_id: job.id,
        status: "CANCELLED",
      });
      pushEvent({ type: "job_cancelled", job_id: job.id });

      const { rows: updated } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [job.id],
      );
      res.status(202).json(await formatJob(pool, updated[0]!));
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  });

  router.delete("/jobs/:id", async (req, res, next) => {
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [req.params.id],
      );
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (job.status === "GENERATING" || job.status === "REDUCING") {
        res.status(409).json({ error: "job still active" });
        return;
      }
      await deleteJobDir(config, job.id);
      await pool.query(`DELETE FROM jobs WHERE id = $1`, [job.id]);
      pushEvent({ type: "job_deleted", job_id: job.id });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/result.csv", async (req, res, next) => {
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [req.params.id],
      );
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (job.status !== "COMPLETED") {
        res.status(409).json({ error: "job not completed" });
        return;
      }
      const rel = resultPaths(job.id).csv;
      const abs = path.join(config.DATA_DIR, rel);
      await streamCsvFile(abs, res);
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/result.npy", async (req, res, next) => {
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [req.params.id],
      );
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (job.status !== "COMPLETED") {
        res.status(409).json({ error: "job not completed" });
        return;
      }
      const rel = resultPaths(job.id).npy;
      const abs = path.join(config.DATA_DIR, rel);
      res.sendFile(abs);
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/inputs/:index.csv", async (req, res, next) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        res.status(400).json({ error: "invalid index" });
        return;
      }
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [req.params.id],
      );
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (job.generated_files <= index) {
        res.status(404).json({ error: "input not generated" });
        return;
      }
      const npyRel = inputPath(job.id, index);
      const csvRel = npyRel.replace(/\.npy$/, ".csv");
      const abs = path.join(config.DATA_DIR, csvRel);
      await streamCsvFile(abs, res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

import { Router } from "express";
import { access } from "node:fs/promises";
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
import { streamNpyAsCsv } from "../storage/npy.js";
import { deleteJobDir } from "../storage/deleteJobDir.js";
import crypto from "node:crypto";

const uuidParamSchema = z.string().uuid();

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

export function jobEstimate(f: number, c: number) {
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

async function jobTimings(pool: pg.Pool, job: JobRow) {
  const createdMs = job.created_at.getTime();
  const genCompletedMs = job.generation_completed_at?.getTime() ?? null;
  const finishedMs = job.finished_at?.getTime() ?? null;

  const generation =
    genCompletedMs !== null ? Math.max(0, genCompletedMs - createdMs) : null;
  const reduction =
    genCompletedMs !== null &&
    finishedMs !== null &&
    job.status === "COMPLETED"
      ? Math.max(0, finishedMs - genCompletedMs)
      : null;
  const total =
    finishedMs !== null ? Math.max(0, finishedMs - createdMs) : null;

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
  if (rows[0]?.sum === null || rows[0]?.sum === undefined) {
    return 0;
  }
  const live = Number(rows[0].sum);
  if (job.f <= 1) return 1;
  return Math.max(0, Math.min(1, 1 - (live - 1) / (job.f - 1)));
}

async function poolBreakdown(pool: pg.Pool, jobId: string) {
  const { rows } = await pool.query<{
    kind: string;
    state: string;
    cnt: string;
    covered: string;
  }>(
    `SELECT kind::text, state::text, count(*)::text AS cnt, coalesce(sum(count), 0)::text AS covered
     FROM items WHERE job_id = $1 GROUP BY kind, state`,
    [jobId],
  );
  const out: Record<string, { items: number; files_covered: number }> = {
    READY: { items: 0, files_covered: 0 },
    RESERVED: { items: 0, files_covered: 0 },
    CONSUMED: { items: 0, files_covered: 0 },
    DELETED: { items: 0, files_covered: 0 },
  };
  for (const r of rows) {
    const cur = out[r.state] ?? { items: 0, files_covered: 0 };
    cur.items += Number(r.cnt);
    cur.files_covered += Number(r.covered);
    out[r.state] = cur;
  }
  return out;
}

async function formatJob(pool: pg.Pool, job: JobRow) {
  const tasks = await taskCounts(pool, job.id);
  const pool_items = await poolBreakdown(pool, job.id);
  const timings_ms = await jobTimings(pool, job);
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
    partials_cleaned_at: job.partials_cleaned_at?.toISOString() ?? null,
    progress,
    tasks,
    pool_items,
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
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [idCheck.data],
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

  router.get("/jobs/:id/tasks", async (req, res, next) => {
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const { rows: jobRows } = await pool.query<{ id: string }>(
        `SELECT id FROM jobs WHERE id = $1`,
        [idCheck.data],
      );
      if (jobRows.length === 0) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const { rows } = await pool.query<{
        id: string;
        kind: string;
        status: string;
        attempt: number;
        level: number;
        file_start: number | null;
        file_count: number | null;
        input_count: number | null;
        is_final: boolean;
        worker_id: string | null;
        duration_ms: number | null;
        last_error: string | null;
        created_at: Date;
        published_at: Date | null;
        completed_at: Date | null;
      }>(
        `SELECT id, kind::text, status::text, attempt, level, file_start, file_count,
                input_count, is_final, worker_id, duration_ms, last_error,
                created_at, published_at, completed_at
         FROM tasks WHERE job_id = $1
         ORDER BY level ASC, file_start ASC NULLS LAST, created_at ASC`,
        [idCheck.data],
      );
      res.json({
        tasks: rows.map((t) => ({
          ...t,
          created_at: t.created_at.toISOString(),
          published_at: t.published_at?.toISOString() ?? null,
          completed_at: t.completed_at?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/jobs/:id/cancel", async (req, res, next) => {
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
        [idCheck.data],
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

      try {
        await publishJobStopped(controlCh, {
          schema_version: 1,
          type: "job.stopped",
          job_id: job.id,
          status: "CANCELLED",
        });
      } catch {
        // best-effort broadcast (ITD-013)
      }
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
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [idCheck.data],
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
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [idCheck.data],
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
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${job.id.slice(0, 8)}-result.csv"`,
      );
      await streamCsvFile(abs, res);
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/result.npy", async (req, res, next) => {
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [idCheck.data],
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
      await access(abs);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${job.id.slice(0, 8)}-result.npy"`,
      );
      res.sendFile(abs);
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/inputs/:index.csv", async (req, res, next) => {
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        res.status(400).json({ error: "invalid index" });
        return;
      }
      const { rows } = await pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [idCheck.data],
      );
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (index >= job.f) {
        res.status(404).json({ error: "input index out of range" });
        return;
      }
      const npyRel = inputPath(job.id, index);
      const abs = path.join(config.DATA_DIR, npyRel);
      try {
        await access(abs);
      } catch {
        res.status(404).json({ error: "input not generated" });
        return;
      }
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${job.id.slice(0, 8)}-input-${String(index).padStart(6, "0")}.csv"`,
      );
      await streamNpyAsCsv(abs, res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

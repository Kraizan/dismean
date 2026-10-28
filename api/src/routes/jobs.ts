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
import { streamNpyAsCsv, streamNpyFile } from "../storage/npy.js";
import { deleteJobDir } from "../storage/deleteJobDir.js";
import { formatJob, formatJobs } from "./jobFormat.js";
import { fetchTaskGraph } from "./taskGraph.js";
import { partialPath } from "../paths.js";
import crypto from "node:crypto";

const uuidParamSchema = z.string().uuid();

const createBodySchema = z.object({
  file_count: z.number().int().min(2).max(99_999),
  values_per_file: z.number().int().min(2).max(999_999),
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

const tasksQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(5000).default(500),
  offset: z.coerce.number().int().nonnegative().default(0),
  kind: z.enum(["GENERATE", "MERGE"]).optional(),
  status: z
    .enum(["CREATED", "PUBLISHED", "DONE", "FAILED", "CANCELLED"])
    .optional(),
});

function randomSeed(): number {
  // 48 bits: crypto.randomInt only accepts safe integers, and the seed must survive JSON.
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
    const { file_count, values_per_file } = parsed.data;
    const id = crypto.randomUUID();
    const seed = randomSeed();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
        WITH j AS (
          INSERT INTO jobs (id, file_count, values_per_file, seed) VALUES ($1, $2, $3, $4) RETURNING id, file_count
        )
        INSERT INTO tasks (id, job_id, kind, level, file_start, file_count)
        SELECT gen_random_uuid(), j.id, 'GENERATE', 0, s, LEAST(5, j.file_count - s)
        FROM j, generate_series(0, j.file_count - 1, 5) AS s
        `,
        [id, file_count, values_per_file, seed],
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
      res.json({ jobs: await formatJobs(pool, rows) });
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

  router.get("/jobs/:id/task-graph", async (req, res, next) => {
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      const graph = await fetchTaskGraph(pool, idCheck.data);
      if (!graph) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(graph);
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
    const query = tasksQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid query" });
      return;
    }
    const { limit, offset, kind, status } = query.data;
    try {
      const { rows: jobRows } = await pool.query<{ id: string }>(
        `SELECT id FROM jobs WHERE id = $1`,
        [idCheck.data],
      );
      if (jobRows.length === 0) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const filters: string[] = ["job_id = $1"];
      const params: unknown[] = [idCheck.data];
      if (kind) {
        params.push(kind);
        filters.push(`kind = $${params.length}::task_kind`);
      }
      if (status) {
        params.push(status);
        filters.push(`status = $${params.length}::task_status`);
      }
      const where = filters.join(" AND ");
      const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tasks WHERE ${where}`,
        params,
      );
      const total = Number(countRows[0]?.count ?? 0);
      const listParams = [...params, limit, offset];
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
         FROM tasks WHERE ${where}
         ORDER BY level ASC, file_start ASC NULLS LAST, created_at ASC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams,
      );
      res.json({
        total,
        limit,
        offset,
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
        // best-effort broadcast (ITD-009)
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
      try {
        await access(abs);
      } catch {
        res.status(404).json({ error: "result file missing on disk" });
        return;
      }
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
      try {
        await access(abs);
      } catch {
        res.status(404).json({ error: "result file missing on disk" });
        return;
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${job.id.slice(0, 8)}-result.npy"`,
      );
      await streamNpyFile(abs, res);
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/partials/:taskId.csv", async (req, res, next) => {
    const idCheck = uuidParamSchema.safeParse(req.params.id);
    const taskIdCheck = uuidParamSchema.safeParse(req.params.taskId);
    if (!idCheck.success || !taskIdCheck.success) {
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
      const { rows: taskRows } = await pool.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = $1 AND job_id = $2 AND kind = 'MERGE'`,
        [taskIdCheck.data, job.id],
      );
      if (taskRows.length === 0) {
        res.status(404).json({ error: "merge task not found" });
        return;
      }
      const npyRel = partialPath(job.id, taskIdCheck.data);
      const abs = path.join(config.DATA_DIR, npyRel);
      try {
        await access(abs);
      } catch {
        res.status(404).json({ error: "partial not on disk" });
        return;
      }
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${job.id.slice(0, 8)}-partial-${taskIdCheck.data.slice(0, 8)}.csv"`,
      );
      await streamNpyAsCsv(abs, res);
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
      if (index >= job.file_count) {
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

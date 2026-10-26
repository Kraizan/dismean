import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { pushEvent } from "../events.js";
import { buildWorkerStats } from "../stats/workers.js";

const putFleetSchema = z.object({
  desired_workers: z.number().int().min(1).max(32),
});

export async function getDesiredWorkers(
  pool: pg.Pool,
  fallback: number,
): Promise<{ desired_workers: number; updated_at: string | null }> {
  try {
    const { rows } = await pool.query<{
      desired_workers: number;
      updated_at: Date;
    }>(`SELECT desired_workers, updated_at FROM fleet WHERE id = 1`);
    const row = rows[0];
    if (!row) {
      return { desired_workers: fallback, updated_at: null };
    }
    return {
      desired_workers: Number(row.desired_workers),
      updated_at: row.updated_at.toISOString(),
    };
  } catch {
    return { desired_workers: fallback, updated_at: null };
  }
}

export function fleetRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();

  router.get("/fleet", async (_req, res, next) => {
    try {
      const fleet = await getDesiredWorkers(pool, config.WORKER_COUNT);
      const workers = buildWorkerStats(config);
      res.json({
        desired_workers: fleet.desired_workers,
        updated_at: fleet.updated_at,
        workers: {
          total: workers.total,
          idle: workers.idle,
          busy: workers.busy,
          stopping: workers.stopping,
          dead: workers.dead,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/fleet", async (req, res, next) => {
    const parsed = putFleetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { desired_workers } = parsed.data;
    try {
      const {
        rows: [row],
      } = await pool.query<{ desired_workers: number; updated_at: Date }>(
        `INSERT INTO fleet (id, desired_workers, updated_at)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE
           SET desired_workers = EXCLUDED.desired_workers,
               updated_at = now()
         RETURNING desired_workers, updated_at`,
        [desired_workers],
      );
      pushEvent({
        type: "fleet_scaled",
        message: `desired_workers = ${desired_workers}`,
        data: { desired_workers },
      });
      const workers = buildWorkerStats(config);
      res.json({
        desired_workers: Number(row!.desired_workers),
        updated_at: row!.updated_at.toISOString(),
        workers: {
          total: workers.total,
          idle: workers.idle,
          busy: workers.busy,
          stopping: workers.stopping,
          dead: workers.dead,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

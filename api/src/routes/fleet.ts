/** Fleet size GET/PUT and dead-worker prune. See docs/code-map.md · LLD §10. */
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { pushEvent } from "../events.js";
import { buildWorkerStats, clearDeadWorkers } from "../stats/workers.js";

const putFleetSchema = z.object({
  desired_workers: z.number().int().min(1).max(32),
});

/** WORKER_COUNT is the default target until an operator sets one through PUT /fleet. */
export async function seedFleetDefault(pool: pg.Pool, workerCount: number): Promise<void> {
  await pool.query(
    `INSERT INTO fleet (id, desired_workers, set_by_api) VALUES (1, $1, false)
     ON CONFLICT (id) DO UPDATE SET desired_workers = EXCLUDED.desired_workers, updated_at = now()
     WHERE fleet.set_by_api = false`,
    [workerCount],
  );
}

export async function getDesiredWorkers(
  pool: pg.Pool,
  fallback: number,
): Promise<{ desired_workers: number; updated_at: string | null; set_by_api: boolean }> {
  try {
    const { rows } = await pool.query<{
      desired_workers: number;
      updated_at: Date;
      set_by_api: boolean;
    }>(`SELECT desired_workers, updated_at, set_by_api FROM fleet WHERE id = 1`);
    const row = rows[0];
    if (!row) return { desired_workers: fallback, updated_at: null, set_by_api: false };
    return {
      desired_workers: Number(row.desired_workers),
      updated_at: row.updated_at.toISOString(),
      set_by_api: row.set_by_api,
    };
  } catch {
    return { desired_workers: fallback, updated_at: null, set_by_api: false };
  }
}

function fleetBody(
  fleet: { desired_workers: number; updated_at: string | null; set_by_api: boolean },
  config: Config,
) {
  const workers = buildWorkerStats(config);
  return {
    desired_workers: fleet.desired_workers,
    updated_at: fleet.updated_at,
    source: fleet.set_by_api ? "api" : "WORKER_COUNT",
    workers: {
      total: workers.total,
      idle: workers.idle,
      busy: workers.busy,
      stopping: workers.stopping,
      dead: workers.dead,
      // The supervisor matches these by pid to drain idle workers first on scale-down.
      list: workers.list.map((w) => ({
        id: w.id,
        hostname: w.hostname,
        pid: w.pid,
        state: w.dead ? "DEAD" : w.state,
      })),
    },
  };
}

export function fleetRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();

  router.get("/fleet", async (_req, res, next) => {
    try {
      res.json(fleetBody(await getDesiredWorkers(pool, config.WORKER_COUNT), config));
    } catch (err) {
      next(err);
    }
  });

  router.put("/fleet", async (req, res, next) => {
    const parsed = putFleetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation failed", details: parsed.error.flatten() });
      return;
    }
    const { desired_workers } = parsed.data;
    try {
      const {
        rows: [row],
      } = await pool.query<{ desired_workers: number; updated_at: Date }>(
        `INSERT INTO fleet (id, desired_workers, set_by_api, updated_at)
         VALUES (1, $1, true, now())
         ON CONFLICT (id) DO UPDATE
           SET desired_workers = EXCLUDED.desired_workers, set_by_api = true, updated_at = now()
         RETURNING desired_workers, updated_at`,
        [desired_workers],
      );
      pushEvent({
        type: "fleet_scaled",
        message: `desired_workers = ${desired_workers}`,
        data: { desired_workers },
      });
      res.json(
        fleetBody(
          {
            desired_workers: Number(row!.desired_workers),
            updated_at: row!.updated_at.toISOString(),
            set_by_api: true,
          },
          config,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/fleet/prune-dead", (_req, res) => {
    res.json({ removed: clearDeadWorkers(config) });
  });

  return router;
}

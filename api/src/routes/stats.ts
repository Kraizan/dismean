/** Aggregated system snapshot endpoint. See docs/code-map.md · LLD §10. */
import { Router } from "express";
import type pg from "pg";
import type { Config } from "../config.js";
import { buildStatsSnapshot } from "../stats/snapshot.js";

export function statsRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();

  router.get("/stats", async (_req, res, next) => {
    try {
      const snapshot = await buildStatsSnapshot(pool, config);
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

import { Router } from "express";
import type pg from "pg";
import type { Config } from "../config.js";
import { runCleanup } from "../cleanup/index.js";

export function cleanupRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();

  router.post("/cleanup", async (req, res, next) => {
    try {
      const force =
        req.query.force === "true" ||
        req.query.force === "1" ||
        Boolean((req.body as { force?: boolean } | undefined)?.force);
      const result = await runCleanup(pool, config, { force });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

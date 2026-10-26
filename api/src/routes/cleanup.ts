import { Router } from "express";
import type pg from "pg";
import type { Config } from "../config.js";
import { runCleanup } from "../cleanup/index.js";

export function cleanupRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();

  router.post("/cleanup", async (_req, res, next) => {
    try {
      const result = await runCleanup(pool, config);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

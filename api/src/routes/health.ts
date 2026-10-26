/** Liveness probe. See docs/code-map.md · LLD §10. */
import { Router } from "express";
import type pg from "pg";
import { amqpConnected } from "../mq/connection.js";

export function healthRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    let db = "ok";
    try {
      await pool.query("SELECT 1");
    } catch {
      db = "error";
    }
    const amqp = amqpConnected() ? "ok" : "error";
    res.status(db === "ok" && amqp === "ok" ? 200 : 503).json({ db, amqp });
  });

  return router;
}

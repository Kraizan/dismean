import { Router } from "express";
import type pg from "pg";
import type { ChannelModel } from "amqplib";

export function healthRouter(pool: pg.Pool, amqp: ChannelModel | null): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    let db = "ok";
    let amqpStatus = "ok";
    try {
      await pool.query("SELECT 1");
    } catch {
      db = "error";
    }
    if (!amqp) {
      amqpStatus = "error";
    } else {
      try {
        const ch = await amqp.createChannel();
        await ch.close();
      } catch {
        amqpStatus = "error";
      }
    }
    const ok = db === "ok" && amqpStatus === "ok";
    res.status(ok ? 200 : 503).json({ db, amqp: amqpStatus });
  });

  return router;
}

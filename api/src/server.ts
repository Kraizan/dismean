import express from "express";
import { EventEmitter } from "node:events";
import { loadConfig } from "./config.js";
import { getPool, closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { connectAmqp, closeAmqp, checkTopology } from "./mq/connection.js";
import { initEventBuffer } from "./events.js";
import { startHeartbeatConsumer } from "./stats/workers.js";
import { startCoordinator } from "./coordinator/index.js";
import { startRelay } from "./relay/index.js";
import { startCleanupSweep } from "./cleanup/index.js";
import { jobsRouter } from "./routes/jobs.js";
import { cleanupRouter } from "./routes/cleanup.js";
import { statsRouter } from "./routes/stats.js";
import { eventsRouter } from "./routes/events.js";
import { healthRouter } from "./routes/health.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initEventBuffer(config);

  const pool = getPool(config);
  await runMigrations(pool);

  const amqpConn = await connectAmqp(config);
  await checkTopology(amqpConn);

  const relayEmitter = new EventEmitter();
  const controlCh = await amqpConn.createChannel();

  const hb = await startHeartbeatConsumer(amqpConn, config);
  const coordChannels = await startCoordinator(
    amqpConn,
    pool,
    config,
    controlCh,
    relayEmitter,
  );

  const relay = await startRelay(pool, amqpConn, config, relayEmitter);
  const cleanup = startCleanupSweep(pool, config);

  const app = express();
  app.use(express.json());

  app.use(jobsRouter(pool, config, controlCh, relayEmitter));
  app.use(cleanupRouter(pool, config));
  app.use(statsRouter(pool, config));
  app.use(eventsRouter());
  app.use(healthRouter(pool, amqpConn));

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "internal error",
      });
    },
  );

  const server = app.listen(config.PORT, () => {
    console.log(`dismean-api listening on :${config.PORT}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    relay.stop();
    cleanup.stop();
    hb.stop();
    await hb.channel.close().catch(() => {});
    for (const ch of coordChannels) {
      await ch.close().catch(() => {});
    }
    await controlCh.close().catch(() => {});
    await closeAmqp();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

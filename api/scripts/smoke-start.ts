/** CI smoke: migrate, connect AMQP, exit. See docs/code-map.md. */
import amqp from "amqplib";
import { loadConfig } from "../src/config.js";
import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { connectAmqp, checkTopology } from "../src/mq/connection.js";

async function main() {
  const config = loadConfig();
  const pool = getPool(config);
  await runMigrations(pool);
  console.log("migrations ok");
  const conn = await connectAmqp(config);
  console.log("amqp connect ok");
  await checkTopology(conn);
  console.log("topology ok");
  await pool.end();
  await conn.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

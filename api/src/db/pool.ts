/** Postgres pool and DB availability helper. See docs/code-map.md · LLD §2. */
import pg from "pg";
import type { Config } from "../config.js";

let pool: pg.Pool | null = null;

export function getPool(config: Config): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.DATABASE_URL });
    // An idle client losing its connection must not crash the API; queries surface the outage instead.
    pool.on("error", (err) => console.error("postgres idle client error", err.message));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function isDbAvailabilityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "57P01" ||
    code === "57P03" ||
    code === "08006" ||
    code === "08001" ||
    err.message.includes("Connection terminated")
  );
}

/** Apply ordered SQL migrations at startup. See docs/code-map.md · LLD §2. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export async function runMigrations(client: pg.Pool): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      [file],
    );
    if (rows.length > 0) continue;

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const conn = await client.connect();
    try {
      await conn.query("BEGIN");
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await conn.query("COMMIT");
    } catch (err) {
      await conn.query("ROLLBACK");
      throw err;
    } finally {
      conn.release();
    }
  }
}

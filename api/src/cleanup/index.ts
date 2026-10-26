import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { Config } from "../config.js";
import { pushEvent } from "../events.js";
import { jobDirRelative } from "../paths.js";

async function dirSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = await dirSize(full);
        files += sub.files;
        bytes += sub.bytes;
      } else {
        files += 1;
        const s = await stat(full);
        bytes += s.size;
      }
    }
  } catch {
    // missing dir
  }
  return { files, bytes };
}

async function deleteTmpFiles(jobDir: string): Promise<number> {
  let deleted = 0;
  try {
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.name.includes(".tmp-")) {
          await rm(full);
          deleted += 1;
        }
      }
    };
    await walk(jobDir);
  } catch {
    // ignore
  }
  return deleted;
}

export async function runCleanup(pool: pg.Pool, config: Config): Promise<{
  jobs_cleaned: number;
  files_deleted: number;
  bytes_freed: number;
}> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED')
       AND finished_at < now() - ($1::bigint * interval '1 millisecond')
       AND partials_cleaned_at IS NULL`,
    [config.PARTIAL_RETENTION_MS],
  );

  let jobsCleaned = 0;
  let filesDeleted = 0;
  let bytesFreed = 0;

  for (const { id } of rows) {
    const jobDir = path.join(config.DATA_DIR, jobDirRelative(id));
    const partialsDir = path.join(jobDir, "partials");

    const before = await dirSize(partialsDir);
    try {
      await rm(partialsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const tmpDeleted = await deleteTmpFiles(jobDir);
    filesDeleted += before.files + tmpDeleted;
    bytesFreed += before.bytes;

    await pool.query(
      `UPDATE items SET state = 'DELETED' WHERE job_id = $1 AND kind = 'PARTIAL'`,
      [id],
    );
    await pool.query(
      `UPDATE jobs SET partials_cleaned_at = now() WHERE id = $1`,
      [id],
    );
    jobsCleaned += 1;
  }

  pushEvent({
    type: "cleanup_ran",
    message: `cleaned ${jobsCleaned} jobs, ${filesDeleted} files (${bytesFreed} B)`,
    data: { jobs_cleaned: jobsCleaned, files_deleted: filesDeleted, bytes_freed: bytesFreed },
  });

  return {
    jobs_cleaned: jobsCleaned,
    files_deleted: filesDeleted,
    bytes_freed: bytesFreed,
  };
}

export function startCleanupSweep(
  pool: pg.Pool,
  config: Config,
): { stop: () => void } {
  const interval = setInterval(() => {
    void runCleanup(pool, config).catch((err) =>
      console.error("cleanup sweep error", err),
    );
  }, config.CLEANUP_INTERVAL_MS);

  return {
    stop: () => clearInterval(interval),
  };
}

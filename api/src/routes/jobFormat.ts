import type pg from "pg";
import type { JobRow } from "../db/types.js";
import { reductionProgress } from "../stats/progress.js";

export function jobEstimate(f: number, c: number) {
  const merge_tasks = Math.ceil((f - 1) / 4);
  return {
    input_bytes: f * c,
    peak_partial_bytes: (merge_tasks - 1) * 8 * c,
    generate_tasks: Math.ceil(f / 5),
    merge_tasks,
  };
}

function jobTimings(job: JobRow) {
  const createdMs = job.created_at.getTime();
  const genCompletedMs = job.generation_completed_at?.getTime() ?? null;
  const finishedMs = job.finished_at?.getTime() ?? null;
  const generation =
    genCompletedMs !== null ? Math.max(0, genCompletedMs - createdMs) : null;
  const reduction =
    genCompletedMs !== null && finishedMs !== null && job.status === "COMPLETED"
      ? Math.max(0, finishedMs - genCompletedMs)
      : null;
  const total = finishedMs !== null ? Math.max(0, finishedMs - createdMs) : null;
  return { generation, reduction, total };
}

type PoolState = { items: number; files_covered: number };

function emptyPool(): Record<string, PoolState> {
  return {
    READY: { items: 0, files_covered: 0 },
    RESERVED: { items: 0, files_covered: 0 },
    CONSUMED: { items: 0, files_covered: 0 },
    DELETED: { items: 0, files_covered: 0 },
  };
}

/** Formats many jobs with three grouped queries instead of several per job. */
export async function formatJobs(pool: pg.Pool, jobs: JobRow[]) {
  if (jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);

  const [{ rows: taskRows }, { rows: itemRows }] = await Promise.all([
    pool.query<{ job_id: string; kind: string; status: string; count: string }>(
      `SELECT job_id, kind::text, status::text, count(*)::text AS count
       FROM tasks WHERE job_id = ANY($1::uuid[]) GROUP BY job_id, kind, status`,
      [ids],
    ),
    pool.query<{ job_id: string; state: string; cnt: string; covered: string }>(
      `SELECT job_id, state::text, count(*)::text AS cnt,
              coalesce(sum(count), 0)::text AS covered
       FROM items WHERE job_id = ANY($1::uuid[]) GROUP BY job_id, state`,
      [ids],
    ),
  ]);

  const tasksByJob = new Map<string, Record<string, Record<string, number>>>();
  for (const r of taskRows) {
    const t = tasksByJob.get(r.job_id) ?? { GENERATE: {}, MERGE: {} };
    t[r.kind] = { ...(t[r.kind] ?? {}), [r.status]: Number(r.count) };
    tasksByJob.set(r.job_id, t);
  }

  const poolByJob = new Map<string, Record<string, PoolState>>();
  for (const r of itemRows) {
    const p = poolByJob.get(r.job_id) ?? emptyPool();
    p[r.state] = { items: Number(r.cnt), files_covered: Number(r.covered) };
    poolByJob.set(r.job_id, p);
  }

  return jobs.map((job) => {
    const pool_items = poolByJob.get(job.id) ?? emptyPool();
    const live = poolByJob.has(job.id)
      ? pool_items.READY!.items + pool_items.RESERVED!.items
      : null;
    return {
      id: job.id,
      f: job.f,
      c: job.c,
      status: job.status,
      seed: Number(job.seed),
      generated_files: job.generated_files,
      failure_reason: job.failure_reason,
      created_at: job.created_at.toISOString(),
      generation_completed_at: job.generation_completed_at?.toISOString() ?? null,
      finished_at: job.finished_at?.toISOString() ?? null,
      partials_cleaned_at: job.partials_cleaned_at?.toISOString() ?? null,
      progress: {
        generation: job.generated_files / job.f,
        reduction: reductionProgress(job.status, job.f, live),
      },
      tasks: tasksByJob.get(job.id) ?? { GENERATE: {}, MERGE: {} },
      pool_items,
      timings_ms: jobTimings(job),
      estimate: jobEstimate(job.f, job.c),
    };
  });
}

export async function formatJob(pool: pg.Pool, job: JobRow) {
  const [formatted] = await formatJobs(pool, [job]);
  return formatted!;
}

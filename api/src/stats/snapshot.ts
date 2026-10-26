import type pg from "pg";
import type { Config } from "../config.js";
import { getDesiredWorkers } from "../routes/fleet.js";
import { isJobBusyOnWorkers, buildWorkerStats } from "./workers.js";

interface QueueStats {
  tasks_ready: number;
  tasks_unacked: number;
  coordinator_backlog: number;
  tasks_dead: number;
}

function parseMgmtUrl(rawUrl: string): { baseUrl: string; authHeader: string | null } {
  try {
    const parsed = new URL(rawUrl);
    let authHeader: string | null = null;
    if (parsed.username || parsed.password) {
      const user = decodeURIComponent(parsed.username);
      const pass = decodeURIComponent(parsed.password);
      authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      parsed.username = "";
      parsed.password = "";
    }
    return { baseUrl: parsed.toString().replace(/\/$/, ""), authHeader };
  } catch {
    return { baseUrl: rawUrl.replace(/\/$/, ""), authHeader: null };
  }
}

async function fetchQueueStats(config: Config): Promise<QueueStats> {
  const names = ["dm.tasks", "dm.coordinator", "dm.tasks.dead"];
  const out: QueueStats = {
    tasks_ready: 0,
    tasks_unacked: 0,
    coordinator_backlog: 0,
    tasks_dead: 0,
  };
  try {
    const { baseUrl, authHeader } = parseMgmtUrl(config.RABBITMQ_MGMT_URL);
    const headers: Record<string, string> = {};
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    for (const name of names) {
      const encoded = encodeURIComponent(name);
      const res = await fetch(`${baseUrl}/api/queues/%2F/${encoded}`, {
        headers,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        messages_ready?: number;
        messages_unacknowledged?: number;
      };
      const ready = data.messages_ready ?? 0;
      const unacked = data.messages_unacknowledged ?? 0;
      if (name === "dm.tasks") {
        out.tasks_ready = ready;
        out.tasks_unacked = unacked;
      } else if (name === "dm.coordinator") {
        out.coordinator_backlog = ready + unacked;
      } else if (name === "dm.tasks.dead") {
        out.tasks_dead = ready;
      }
    }
  } catch {
    // management API unavailable
  }
  return out;
}

function reductionProgress(
  status: string,
  f: number,
  live: number,
): number {
  if (status === "COMPLETED") return 1;
  if (status === "GENERATING") return 0;
  if (f <= 1) return 1;
  return Math.max(0, Math.min(1, 1 - (live - 1) / (f - 1)));
}

export async function buildStatsSnapshot(
  pool: pg.Pool,
  config: Config,
): Promise<Record<string, unknown>> {
  const workers = buildWorkerStats(config);
  const fleet = await getDesiredWorkers(pool, config.WORKER_COUNT);
  const queue = await fetchQueueStats(config);

  const { rows: outboxRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tasks WHERE status = 'CREATED'`,
  );
  const outbox_pending = Number(outboxRows[0]?.count ?? 0);

  const { rows: jobCounts } = await pool.query<{
    status: string;
    count: string;
  }>(`SELECT status, count(*)::text AS count FROM jobs GROUP BY status`);

  const jobs: Record<string, number> = {
    WAITING: 0,
    GENERATING: 0,
    REDUCING: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };

  for (const row of jobCounts) {
    if (row.status === "GENERATING") {
      jobs.GENERATING = Number(row.count);
    } else if (row.status in jobs) {
      jobs[row.status] = Number(row.count);
    }
  }

  const { rows: genJobs } = await pool.query<{
    id: string;
    f: number;
    c: number;
    status: string;
    generated_files: number;
  }>(
    `SELECT id, f, c, status::text, generated_files FROM jobs
     WHERE status IN ('GENERATING', 'REDUCING')
     ORDER BY created_at DESC`,
  );

  const active_jobs: Array<Record<string, unknown>> = [];
  let waitingCount = 0;

  for (const j of genJobs) {
    const { rows: doneRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks
       WHERE job_id = $1 AND status = 'DONE'`,
      [j.id],
    );
    const doneCount = Number(doneRows[0]?.count ?? 0);
    const busy = isJobBusyOnWorkers(j.id, config);
    const waiting =
      j.status === "GENERATING" && doneCount === 0 && !busy;
    if (waiting) waitingCount += 1;

    let live = j.f;
    if (j.status === "REDUCING") {
      const { rows: liveRows } = await pool.query<{ sum: string | null }>(
        `SELECT sum(count)::text AS sum FROM items
         WHERE job_id = $1 AND state IN ('READY', 'RESERVED')`,
        [j.id],
      );
      if (liveRows[0]?.sum !== null && liveRows[0]?.sum !== undefined) {
        live = Number(liveRows[0].sum);
      }
    }

    const progress = {
      generation: j.generated_files / j.f,
      reduction: reductionProgress(j.status, j.f, live),
    };

    active_jobs.push({
      id: j.id,
      f: j.f,
      c: j.c,
      status: j.status,
      waiting,
      progress,
    });
  }

  jobs.WAITING = waitingCount;
  jobs.GENERATING = Math.max(0, (jobs.GENERATING ?? 0) - waitingCount);

  const { rows: throughputRows } = await pool.query<{
    kind: string;
    cnt: string;
    avg_ms: string | null;
  }>(
    `SELECT kind::text, count(*)::text AS cnt, avg(duration_ms)::text AS avg_ms
     FROM tasks
     WHERE completed_at > now() - interval '1 minute' AND status = 'DONE'
     GROUP BY kind`,
  );

  let tasksPerSec = 0;
  const avg_ms_1m: Record<string, number> = {};
  for (const row of throughputRows) {
    const cnt = Number(row.cnt);
    tasksPerSec += cnt / 60;
    if (row.avg_ms) {
      avg_ms_1m[row.kind] = Math.round(Number(row.avg_ms));
    }
  }

  return {
    at: new Date().toISOString(),
    workers: {
      desired: fleet.desired_workers,
      total: workers.total,
      idle: workers.idle,
      busy: workers.busy,
      stopping: workers.stopping,
      dead: workers.dead,
      list: workers.list.map((w) => ({
        id: w.id,
        state: w.dead ? "DEAD" : w.state,
        task_id: w.task_id,
        job_id: w.job_id,
        task_kind: w.task_kind,
        tasks_done: w.tasks_done,
        last_heartbeat_at: w.last_heartbeat_at,
        hostname: w.hostname,
        pid: w.pid,
        dead: w.dead,
      })),
    },
    queue,
    outbox_pending,
    jobs,
    throughput: {
      tasks_per_sec_1m: Math.round(tasksPerSec * 10) / 10,
      avg_ms_1m,
    },
    active_jobs,
  };
}

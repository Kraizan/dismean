import type pg from "pg";
import type { Config } from "../config.js";
import { getDesiredWorkers } from "../routes/fleet.js";
import { isJobBusyOnWorkers, buildWorkerStats } from "./workers.js";
import { reductionProgress } from "./progress.js";

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
    if (row.status in jobs) {
      jobs[row.status] = Number(row.count);
    }
  }

  const { rows: genJobs } = await pool.query<{
    id: string;
    file_count: number;
    values_per_file: number;
    status: string;
    generated_files: number;
    done_tasks: string;
    live_items: string;
  }>(
    `SELECT j.id, j.file_count, j.values_per_file, j.status::text, j.generated_files,
            (SELECT count(*) FROM tasks t WHERE t.job_id = j.id AND t.status = 'DONE')::text AS done_tasks,
            (SELECT count(*) FROM items i WHERE i.job_id = j.id AND i.state IN ('READY', 'RESERVED'))::text AS live_items
     FROM jobs j
     WHERE j.status IN ('GENERATING', 'REDUCING')
     ORDER BY j.created_at DESC`,
  );

  const active_jobs: Array<Record<string, unknown>> = [];
  let waitingCount = 0;

  for (const j of genJobs) {
    const busy = isJobBusyOnWorkers(j.id, config);
    const waiting =
      j.status === "GENERATING" && Number(j.done_tasks) === 0 && !busy;
    if (waiting) waitingCount += 1;

    const progress = {
      generation: j.generated_files / j.file_count,
      reduction: reductionProgress(j.status, j.file_count, Number(j.live_items)),
    };

    active_jobs.push({
      id: j.id,
      file_count: j.file_count,
      values_per_file: j.values_per_file,
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
        started_at: w.started_at,
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

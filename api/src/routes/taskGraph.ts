import type pg from "pg";
import * as paths from "../paths.js";

export type TaskIoFile = {
  kind: "INPUT" | "PARTIAL" | "RESULT";
  path: string;
  file_index: number | null;
  count: number;
  item_id: string | null;
  item_state: string | null;
};

export type TaskGraphTask = {
  id: string;
  kind: "GENERATE" | "MERGE";
  status: string;
  attempt: number;
  level: number;
  file_start: number | null;
  file_count: number | null;
  input_count: number | null;
  is_final: boolean;
  worker_id: string | null;
  duration_ms: number | null;
  last_error: string | null;
  created_at: string;
  published_at: string | null;
  completed_at: string | null;
  inputs: TaskIoFile[];
  outputs: TaskIoFile[];
  parent_task_ids: string[];
};

export type TaskGraphResponse = {
  tasks: TaskGraphTask[];
  edges: Array<{ from: string; to: string }>;
};

type TaskRow = {
  id: string;
  kind: "GENERATE" | "MERGE";
  status: string;
  attempt: number;
  level: number;
  file_start: number | null;
  file_count: number | null;
  input_count: number | null;
  is_final: boolean;
  worker_id: string | null;
  duration_ms: number | null;
  last_error: string | null;
  created_at: Date;
  published_at: Date | null;
  completed_at: Date | null;
};

type ItemRow = {
  id: string;
  kind: "INPUT" | "PARTIAL";
  state: string;
  count: number;
  level: number;
  path: string;
  produced_by: string | null;
  reserved_by: string | null;
};

const INPUT_INDEX_RE = /(\d{6})\.npy$/;

export function inputIndexFromPath(relPath: string): number | null {
  const m = INPUT_INDEX_RE.exec(relPath);
  if (!m) return null;
  return Number(m[1]);
}

export function findGenerateTaskForIndex(
  tasks: TaskRow[],
  index: number,
): string | null {
  for (const t of tasks) {
    if (t.kind !== "GENERATE") continue;
    const start = t.file_start ?? 0;
    const count = t.file_count ?? 0;
    if (index >= start && index < start + count) return t.id;
  }
  return null;
}

export function buildTaskGraph(
  jobId: string,
  jobStatus: string,
  tasks: TaskRow[],
  items: ItemRow[],
): TaskGraphResponse {
  const inputsByTask = new Map<string, ItemRow[]>();
  const outputByProducer = new Map<string, ItemRow>();
  const inputItemByPath = new Map<string, ItemRow>();
  for (const it of items) {
    if (it.kind === "INPUT") inputItemByPath.set(it.path, it);
    if (it.reserved_by) {
      const list = inputsByTask.get(it.reserved_by) ?? [];
      list.push(it);
      inputsByTask.set(it.reserved_by, list);
    }
    if (it.produced_by) {
      outputByProducer.set(it.produced_by, it);
    }
  }

  const edges: Array<{ from: string; to: string }> = [];
  const edgeSet = new Set<string>();

  const graphTasks: TaskGraphTask[] = tasks.map((t) => {
    const inputs: TaskIoFile[] = [];
    const outputs: TaskIoFile[] = [];
    const parentIds = new Set<string>();

    if (t.kind === "GENERATE") {
      const start = t.file_start ?? 0;
      const count = t.file_count ?? 0;
      for (let i = 0; i < count; i++) {
        const idx = start + i;
        const rel = paths.inputPath(jobId, idx);
        const item = inputItemByPath.get(rel);
        outputs.push({
          kind: "INPUT",
          path: rel,
          file_index: idx,
          count: 1,
          item_id: item?.id ?? null,
          item_state: item?.state ?? null,
        });
      }
    } else {
      const reserved = inputsByTask.get(t.id) ?? [];
      for (const it of reserved) {
        inputs.push({
          kind: it.kind,
          path: it.path,
          file_index:
            it.kind === "INPUT" ? inputIndexFromPath(it.path) : null,
          count: it.count,
          item_id: it.id,
          item_state: it.state,
        });
        let parent: string | null = it.produced_by;
        if (!parent && it.kind === "INPUT") {
          const idx = inputIndexFromPath(it.path);
          if (idx != null) parent = findGenerateTaskForIndex(tasks, idx);
        }
        if (parent) {
          parentIds.add(parent);
          const key = `${parent}->${t.id}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from: parent, to: t.id });
          }
        }
      }

      const produced = outputByProducer.get(t.id);
      if (produced) {
        outputs.push({
          kind: "PARTIAL",
          path: produced.path,
          file_index: null,
          count: produced.count,
          item_id: produced.id,
          item_state: produced.state,
        });
      } else if (t.is_final && t.status === "DONE" && jobStatus === "COMPLETED") {
        const rp = paths.resultPaths(jobId);
        outputs.push({
          kind: "RESULT",
          path: rp.npy,
          file_index: null,
          count: t.input_count ?? 0,
          item_id: null,
          item_state: null,
        });
        outputs.push({
          kind: "RESULT",
          path: rp.csv,
          file_index: null,
          count: t.input_count ?? 0,
          item_id: null,
          item_state: null,
        });
      } else if (t.status === "DONE" || t.status === "PUBLISHED") {
        outputs.push({
          kind: "PARTIAL",
          path: paths.partialPath(jobId, t.id),
          file_index: null,
          count: t.input_count ?? 0,
          item_id: produced?.id ?? null,
          item_state: produced?.state ?? null,
        });
      }
    }

    return {
      id: t.id,
      kind: t.kind,
      status: t.status,
      attempt: t.attempt,
      level: t.level,
      file_start: t.file_start,
      file_count: t.file_count,
      input_count: t.input_count,
      is_final: t.is_final,
      worker_id: t.worker_id,
      duration_ms: t.duration_ms,
      last_error: t.last_error,
      created_at: t.created_at.toISOString(),
      published_at: t.published_at?.toISOString() ?? null,
      completed_at: t.completed_at?.toISOString() ?? null,
      inputs,
      outputs,
      parent_task_ids: [...parentIds],
    };
  });

  return { tasks: graphTasks, edges };
}

export async function fetchTaskGraph(
  pool: pg.Pool,
  jobId: string,
): Promise<TaskGraphResponse | null> {
  const { rows: jobRows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status::text FROM jobs WHERE id = $1`,
    [jobId],
  );
  const job = jobRows[0];
  if (!job) return null;

  const { rows: tasks } = await pool.query<TaskRow>(
    `SELECT id, kind::text AS kind, status::text AS status, attempt, level,
            file_start, file_count, input_count, is_final, worker_id, duration_ms,
            last_error, created_at, published_at, completed_at
     FROM tasks WHERE job_id = $1
     ORDER BY level ASC, file_start ASC NULLS LAST, created_at ASC`,
    [jobId],
  );

  const { rows: items } = await pool.query<ItemRow>(
    `SELECT id, kind::text AS kind, state::text AS state, count, level, path,
            produced_by, reserved_by
     FROM items WHERE job_id = $1`,
    [jobId],
  );

  return buildTaskGraph(jobId, job.status, tasks, items);
}

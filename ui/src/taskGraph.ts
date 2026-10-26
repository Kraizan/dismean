export type TaskIoFile = {
  kind: "INPUT" | "PARTIAL" | "RESULT";
  path: string;
  file_index: number | null;
  count: number;
  item_id: string | null;
  item_state: string | null;
  produced_by?: string | null;
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

export type TaskGraph = {
  tasks: TaskGraphTask[];
  edges: Array<{ from: string; to: string }>;
};

export function csvDownloadUrl(
  apiBase: string,
  jobId: string,
  file: TaskIoFile,
  mergeTaskId?: string,
): string | null {
  if (file.kind === "INPUT" && file.file_index != null) {
    return `${apiBase}/jobs/${jobId}/inputs/${file.file_index}.csv`;
  }
  if (file.kind === "PARTIAL") {
    const partialOwner = file.produced_by ?? mergeTaskId;
    if (partialOwner) {
      return `${apiBase}/jobs/${jobId}/partials/${partialOwner}.csv`;
    }
  }
  if (file.kind === "RESULT" && file.path.endsWith(".csv")) {
    return `${apiBase}/jobs/${jobId}/result.csv`;
  }
  return null;
}

export function groupTasksByLevel(tasks: TaskGraphTask[]): Map<number, TaskGraphTask[]> {
  const map = new Map<number, TaskGraphTask[]>();
  for (const t of tasks) {
    const list = map.get(t.level) ?? [];
    list.push(t);
    map.set(t.level, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "GENERATE" ? -1 : 1;
      const as = a.file_start ?? 0;
      const bs = b.file_start ?? 0;
      if (as !== bs) return as - bs;
      return a.created_at.localeCompare(b.created_at);
    });
  }
  return map;
}

export function childTaskIds(
  taskId: string,
  edges: TaskGraph["edges"],
): string[] {
  return edges.filter((e) => e.from === taskId).map((e) => e.to);
}

export function taskProgressTime(t: TaskGraphTask): number {
  const s = t.completed_at ?? t.published_at ?? t.created_at;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? 0 : ms;
}

export function sortTasksByProgress(tasks: TaskGraphTask[]): TaskGraphTask[] {
  return [...tasks].sort((a, b) => {
    const dt = taskProgressTime(a) - taskProgressTime(b);
    if (dt !== 0) return dt;
    const as = a.file_start ?? 0;
    const bs = b.file_start ?? 0;
    if (as !== bs) return as - bs;
    return a.id.localeCompare(b.id);
  });
}

export const GENERATION_HUB_ID = "__dismean_generation_hub__";
export const COLLAPSE_GENERATE_THRESHOLD = 6;

export type LayoutMetrics = {
  nodeW: number;
  nodeH: number;
  hubW: number;
  gapX: number;
  gapY: number;
  padX: number;
  padY: number;
  levelGutter: number;
};

export const LAYOUT_DENSE: LayoutMetrics = {
  nodeW: 68,
  nodeH: 46,
  hubW: 120,
  gapX: 10,
  gapY: 40,
  padX: 20,
  padY: 28,
  levelGutter: 88,
};

export const LAYOUT_NORMAL: LayoutMetrics = {
  nodeW: 88,
  nodeH: 58,
  hubW: 148,
  gapX: 14,
  gapY: 48,
  padX: 22,
  padY: 30,
  levelGutter: 96,
};

export const LAYOUT_COMFORTABLE: LayoutMetrics = {
  nodeW: 104,
  nodeH: 72,
  hubW: 168,
  gapX: 18,
  gapY: 52,
  padX: 24,
  padY: 32,
  levelGutter: 104,
};

// backwards compat for tests
export const LAYOUT_NODE_W = LAYOUT_NORMAL.nodeW;
export const LAYOUT_NODE_H = LAYOUT_NORMAL.nodeH;

export function pickLayoutMetrics(maxRowCount: number): LayoutMetrics {
  if (maxRowCount > 12) return LAYOUT_DENSE;
  if (maxRowCount > 6) return LAYOUT_NORMAL;
  return LAYOUT_COMFORTABLE;
}

export function countGenerateTasks(tasks: TaskGraphTask[]): number {
  return tasks.filter((t) => t.kind === "GENERATE").length;
}

export function shouldDefaultCollapseGenerate(tasks: TaskGraphTask[]): boolean {
  return countGenerateTasks(tasks) > COLLAPSE_GENERATE_THRESHOLD;
}

export function makeGenerationHubTask(generateTasks: TaskGraphTask[]): TaskGraphTask {
  const fileCount = generateTasks.reduce((s, t) => s + (t.file_count ?? 0), 0);
  const status = generateTasks.some((t) => t.status === "FAILED")
    ? "FAILED"
    : generateTasks.every((t) => t.status === "DONE")
      ? "DONE"
      : generateTasks[0]?.status ?? "CREATED";
  return {
    id: GENERATION_HUB_ID,
    kind: "GENERATE",
    status,
    attempt: 1,
    level: 0,
    file_start: 0,
    file_count: fileCount,
    input_count: null,
    is_final: false,
    worker_id: null,
    duration_ms: null,
    last_error: null,
    created_at: generateTasks[0]?.created_at ?? "",
    published_at: null,
    completed_at: null,
    inputs: [],
    outputs: [],
    parent_task_ids: [],
  };
}

export type DisplayGraph = {
  tasks: TaskGraphTask[];
  edges: TaskGraph["edges"];
  collapsed: boolean;
  generateIds: Set<string>;
};

export function buildDisplayGraph(
  graph: TaskGraph,
  options: {
    collapseGenerate: boolean;
    visibleIds: Set<string> | null;
  },
): DisplayGraph {
  const generates = graph.tasks.filter((t) => t.kind === "GENERATE");
  const generateIds = new Set(generates.map((t) => t.id));
  const collapsed =
    options.collapseGenerate &&
    generates.length > COLLAPSE_GENERATE_THRESHOLD;

  let tasks: TaskGraphTask[];
  let edges: TaskGraph["edges"];

  if (collapsed) {
    tasks = [makeGenerationHubTask(generates), ...graph.tasks.filter((t) => t.kind !== "GENERATE")];
    const hubEdges: TaskGraph["edges"] = [];
    const seen = new Set<string>();
    for (const e of graph.edges) {
      if (!generateIds.has(e.from)) {
        hubEdges.push(e);
        continue;
      }
      const key = `${GENERATION_HUB_ID}->${e.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        hubEdges.push({ from: GENERATION_HUB_ID, to: e.to });
      }
    }
    edges = hubEdges;
  } else {
    tasks = graph.tasks;
    edges = graph.edges;
  }

  if (options.visibleIds) {
    const vis = options.visibleIds;
    const showHub =
      collapsed && generates.some((g) => vis.has(g.id));
    tasks = tasks.filter(
      (t) => vis.has(t.id) || (t.id === GENERATION_HUB_ID && showHub),
    );
    const ids = new Set(tasks.map((t) => t.id));
    edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }

  return { tasks, edges, collapsed, generateIds };
}

export function nodeSize(
  task: TaskGraphTask,
  metrics: LayoutMetrics,
): { w: number; h: number } {
  if (task.id === GENERATION_HUB_ID) {
    return { w: metrics.hubW, h: metrics.nodeH };
  }
  return { w: metrics.nodeW, h: metrics.nodeH };
}

export type TaskGraphNodePosition = {
  x: number;
  y: number;
  w: number;
  h: number;
  level: number;
  indexInLevel: number;
};

export type TaskGraphLayout = {
  width: number;
  height: number;
  positions: Map<string, TaskGraphNodePosition>;
  levels: number[];
  metrics: LayoutMetrics;
};

export function layoutTaskGraph(
  tasks: TaskGraphTask[],
  metricsOverride?: LayoutMetrics,
): TaskGraphLayout {
  const byLevel = groupTasksByLevel(tasks);
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  let maxRowCount = 0;
  for (const level of levels) {
    const row = byLevel.get(level) ?? [];
    maxRowCount = Math.max(maxRowCount, row.length);
  }
  const metrics = metricsOverride ?? pickLayoutMetrics(maxRowCount);

  const positions = new Map<string, TaskGraphNodePosition>();
  let maxRowWidth = metrics.padX + metrics.levelGutter;

  for (const level of levels) {
    const row = sortTasksByProgress(byLevel.get(level) ?? []);
    const isHubOnly =
      row.length === 1 && row[0]!.id === GENERATION_HUB_ID;
    if (!isHubOnly) {
      let rowWidth = metrics.padX + metrics.levelGutter;
      for (const t of row) {
        rowWidth += nodeSize(t, metrics).w;
      }
      rowWidth += Math.max(0, row.length - 1) * metrics.gapX;
      maxRowWidth = Math.max(maxRowWidth, rowWidth);
    }
  }

  const canvasInner = maxRowWidth + metrics.padX;

  for (const level of levels) {
    const row = sortTasksByProgress(byLevel.get(level) ?? []);
    const y = metrics.padY + level * (metrics.nodeH + metrics.gapY);

    if (row.length === 1 && row[0]!.id === GENERATION_HUB_ID) {
      const { w, h } = nodeSize(row[0]!, metrics);
      positions.set(row[0]!.id, {
        x: (canvasInner - w) / 2,
        y,
        w,
        h,
        level,
        indexInLevel: 0,
      });
      continue;
    }

    let x = metrics.padX + metrics.levelGutter;
    row.forEach((t, i) => {
      const { w, h } = nodeSize(t, metrics);
      positions.set(t.id, {
        x,
        y,
        w,
        h,
        level,
        indexInLevel: i,
      });
      x += w + metrics.gapX;
    });
  }

  const height =
    metrics.padY * 2 +
    Math.max(1, levels.length) * metrics.nodeH +
    Math.max(0, levels.length - 1) * metrics.gapY;

  return {
    width: canvasInner,
    height,
    positions,
    levels,
    metrics,
  };
}

export function edgePathBetweenNodes(
  from: TaskGraphNodePosition,
  to: TaskGraphNodePosition,
): string {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  const dy = Math.max(24, (y2 - y1) * 0.42);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

export function fitZoomScale(
  viewportWidth: number,
  viewportHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const pad = 20;
  const vw = Math.max(1, viewportWidth - pad);
  const vh = Math.max(1, viewportHeight - pad);
  const scale = Math.min(vw / canvasWidth, vh / canvasHeight);
  return Math.min(1.25, Math.max(0.15, scale));
}

export function lineageTaskIds(
  taskId: string,
  edges: TaskGraph["edges"],
): Set<string> {
  const toParents = new Map<string, string[]>();
  const toChildren = new Map<string, string[]>();
  for (const { from, to } of edges) {
    let kids = toChildren.get(from);
    if (!kids) {
      kids = [];
      toChildren.set(from, kids);
    }
    kids.push(to);
    let pars = toParents.get(to);
    if (!pars) {
      pars = [];
      toParents.set(to, pars);
    }
    pars.push(from);
  }
  const related = new Set<string>([taskId]);
  const up = [taskId];
  while (up.length > 0) {
    const id = up.pop()!;
    for (const p of toParents.get(id) ?? []) {
      if (!related.has(p)) {
        related.add(p);
        up.push(p);
      }
    }
  }
  const down = [taskId];
  while (down.length > 0) {
    const id = down.pop()!;
    for (const c of toChildren.get(id) ?? []) {
      if (!related.has(c)) {
        related.add(c);
        down.push(c);
      }
    }
  }
  return related;
}

export function progressOrderIndex(tasks: TaskGraphTask[]): Map<string, number> {
  const sorted = sortTasksByProgress(tasks);
  const map = new Map<string, number>();
  sorted.forEach((t, i) => map.set(t.id, i + 1));
  return map;
}

export function levelRowLabel(level: number, row: TaskGraphTask[]): string {
  if (
    row.some((t) => t.id === GENERATION_HUB_ID) ||
    (level === 0 && row.length > 0 && row.every((t) => t.kind === "GENERATE"))
  ) {
    return "Generation";
  }
  return `Reduction · L${level}`;
}

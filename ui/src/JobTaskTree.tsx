import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMs, formatTime, shortId, shortWorker } from "./format";
import {
  buildDisplayGraph,
  childTaskIds,
  csvDownloadUrl,
  edgePathBetweenNodes,
  fitZoomScale,
  GENERATION_HUB_ID,
  groupTasksByLevel,
  layoutTaskGraph,
  levelRowLabel,
  lineageTaskIds,
  progressOrderIndex,
  shouldDefaultCollapseGenerate,
  type TaskGraph,
  type TaskGraphTask,
  type TaskIoFile,
} from "./taskGraph";

const API = "/api";
const ZOOM_STEP = 0.12;

function taskLabel(t: TaskGraphTask): string {
  if (t.id === GENERATION_HUB_ID) {
    return `${t.file_count ?? 0} input files`;
  }
  if (t.kind === "GENERATE") {
    const start = t.file_start ?? 0;
    const end = start + (t.file_count ?? 1) - 1;
    return `${start}–${end}`;
  }
  const fin = t.is_final ? " · final" : "";
  return `${t.input_count ?? "?"} in${fin}`;
}

function IoTable({
  jobId,
  taskId,
  title,
  files,
  onPreview,
}: {
  jobId: string;
  taskId: string;
  title: string;
  files: TaskIoFile[];
  onPreview: (url: string, label: string) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="io-block">
        <div className="kpi-label">{title}</div>
        <p className="empty compact">None</p>
      </div>
    );
  }
  return (
    <div className="io-block">
      <div className="kpi-label">{title}</div>
      <ul className="io-list">
        {files.map((f, i) => {
          const csv =
            f.kind === "PARTIAL"
              ? csvDownloadUrl(API, jobId, f, taskId)
              : csvDownloadUrl(API, jobId, f);
          const label =
            f.kind === "INPUT" && f.file_index != null
              ? `input #${f.file_index}`
              : f.path.split("/").pop() ?? f.path;
          return (
            <li key={`${f.path}-${i}`} className="io-row">
              <span className="mono io-path" title={f.path}>
                {label}
              </span>
              <span className="io-meta">
                {f.kind}
                {f.count > 1 ? ` · covers ${f.count}` : ""}
                {f.item_state ? ` · ${f.item_state}` : ""}
              </span>
              <span className="io-actions">
                {csv && (
                  <>
                    <button
                      type="button"
                      className="ghost btn-sm"
                      onClick={() => onPreview(csv, label)}
                    >
                      Preview
                    </button>
                    <a className="btn secondary btn-sm" href={csv} download>
                      CSV
                    </a>
                  </>
                )}
                {f.kind === "RESULT" && f.path.endsWith(".npy") && (
                  <a
                    className="btn secondary btn-sm"
                    href={`${API}/jobs/${jobId}/result.npy`}
                    download
                  >
                    NPY
                  </a>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TaskNode({
  task,
  selected,
  dimmed,
  progressStep,
  isHub,
  onSelect,
}: {
  task: TaskGraphTask;
  selected: boolean;
  dimmed: boolean;
  progressStep: number;
  isHub: boolean;
  onSelect: () => void;
}) {
  const title = `${task.kind} · ${taskLabel(task)} · #${progressStep} · ${task.id}`;

  if (isHub) {
    return (
      <button
        type="button"
        className={`task-node task-graph-node task-node--hub ${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}`}
        onClick={onSelect}
        title={title}
      >
        <span className="task-node-kind">Generation</span>
        <span className="mono task-node-scope">{taskLabel(task)}</span>
        <span className="task-node-hint muted">click to expand</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`task-node task-graph-node task-node--${task.kind.toLowerCase()} ${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}`}
      onClick={onSelect}
      title={title}
    >
      <span className={`task-status-dot task-status-dot--${task.status}`} />
      <span className="task-node-line">
        <span className="task-node-kind">{task.kind === "GENERATE" ? "GEN" : "MRG"}</span>
        <span className="mono task-node-scope">{taskLabel(task)}</span>
      </span>
      {task.is_final && <span className="task-node-tag">final</span>}
    </button>
  );
}

function TaskGraphCanvas({
  jobId,
  graph,
  selectedTaskId,
  onSelectTask,
  presentation,
}: {
  jobId: string;
  graph: TaskGraph;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  presentation: "inline" | "modal";
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [collapseGenerate, setCollapseGenerate] = useState(() =>
    shouldDefaultCollapseGenerate(graph.tasks),
  );
  const [focusPath, setFocusPath] = useState(true);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const collapseGenRef = useRef(collapseGenerate);

  const highlight = useMemo(() => {
    const id = hoverId ?? selectedTaskId;
    return id ? lineageTaskIds(id, graph.edges) : null;
  }, [hoverId, selectedTaskId, graph.edges]);

  const visibleIds = useMemo(() => {
    if (!focusPath || !selectedTaskId) return null;
    return lineageTaskIds(selectedTaskId, graph.edges);
  }, [focusPath, selectedTaskId, graph.edges]);

  const display = useMemo(
    () =>
      buildDisplayGraph(graph, {
        collapseGenerate,
        visibleIds,
      }),
    [graph, collapseGenerate, visibleIds],
  );

  const graphLayout = useMemo(
    () => layoutTaskGraph(display.tasks),
    [display.tasks],
  );

  const progressOrder = useMemo(
    () => progressOrderIndex(graph.tasks),
    [graph.tasks],
  );

  const tasksByLevel = useMemo(
    () => groupTasksByLevel(display.tasks),
    [display.tasks],
  );

  const applyFit = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const scale = fitZoomScale(
      el.clientWidth,
      el.clientHeight,
      graphLayout.width,
      graphLayout.height,
    );
    setZoom(scale);
  }, [graphLayout.width, graphLayout.height]);

  useEffect(() => {
    requestAnimationFrame(() => applyFit());
  }, [jobId, applyFit]);

  useEffect(() => {
    if (collapseGenRef.current === collapseGenerate) return;
    collapseGenRef.current = collapseGenerate;
    requestAnimationFrame(() => applyFit());
  }, [collapseGenerate, applyFit]);

  useEffect(() => {
    if (!selectedTaskId || !collapseGenerate) return;
    const t = graph.tasks.find((x) => x.id === selectedTaskId);
    if (t?.kind === "GENERATE") {
      setCollapseGenerate(false);
    }
  }, [selectedTaskId, collapseGenerate, graph.tasks]);

  const nudgeZoom = (delta: number) => {
    setZoom((z) =>
      Math.min(1.5, Math.max(0.15, Math.round((z + delta) * 100) / 100)),
    );
  };

  const handleNodeSelect = (t: TaskGraphTask) => {
    if (t.id === GENERATION_HUB_ID) {
      setCollapseGenerate(false);
      return;
    }
    onSelectTask(t.id === selectedTaskId ? null : t.id);
  };

  return (
    <div
      className={`task-graph-shell ${presentation === "modal" ? "task-graph-shell--modal" : ""}`}
    >
      <div className="task-graph-toolbar">
        <div className="task-graph-zoom-controls">
          <button
            type="button"
            className="ghost btn-sm"
            onClick={() => nudgeZoom(-ZOOM_STEP)}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="mono task-graph-zoom-label">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="ghost btn-sm"
            onClick={() => nudgeZoom(ZOOM_STEP)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" className="secondary btn-sm" onClick={applyFit}>
            Fit
          </button>
        </div>
        <div className="task-graph-toggles">
          <label className="task-graph-toggle">
            <input
              type="checkbox"
              checked={collapseGenerate}
              onChange={(e) => setCollapseGenerate(e.target.checked)}
            />
            Collapse generation
          </label>
          <label className="task-graph-toggle">
            <input
              type="checkbox"
              checked={focusPath}
              onChange={(e) => setFocusPath(e.target.checked)}
            />
            Focus path
          </label>
          <label className="task-graph-toggle">
            <input
              type="checkbox"
              checked={showAllEdges}
              onChange={(e) => setShowAllEdges(e.target.checked)}
            />
            All edges
          </label>
        </div>
      </div>

      <div className="task-graph-viewport" ref={viewportRef}>
        <div
          className="task-graph-zoom-layer"
          style={{
            width: graphLayout.width * zoom,
            height: graphLayout.height * zoom,
          }}
        >
          <div
            className="task-graph-canvas"
            style={{
              width: graphLayout.width,
              height: graphLayout.height,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="task-graph-edges"
              width={graphLayout.width}
              height={graphLayout.height}
              aria-hidden
            >
              {display.edges.map((e) => {
                const from = graphLayout.positions.get(e.from);
                const to = graphLayout.positions.get(e.to);
                if (!from || !to) return null;
                const onPath =
                  !highlight ||
                  (highlight.has(e.from) && highlight.has(e.to));
                const show = showAllEdges ? true : onPath;
                if (!show) return null;
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={edgePathBetweenNodes(from, to)}
                    className={`task-graph-edge ${onPath ? "active" : "muted"}`}
                  />
                );
              })}
            </svg>

            {graphLayout.levels.map((level) => {
              const row = tasksByLevel.get(level) ?? [];
              const sample = graphLayout.positions.get(row[0]?.id ?? "");
              if (!sample) return null;
              return (
                <div
                  key={level}
                  className="task-graph-level-label"
                  style={{ top: sample.y + sample.h / 2 - 8 }}
                >
                  {levelRowLabel(level, row)}
                </div>
              );
            })}

            {display.tasks.map((t) => {
              const pos = graphLayout.positions.get(t.id);
              if (!pos) return null;
              const dimmed =
                !focusPath &&
                highlight != null &&
                !highlight.has(t.id) &&
                t.id !== GENERATION_HUB_ID;
              const hubDimmed =
                t.id === GENERATION_HUB_ID &&
                highlight != null &&
                !generatesInLineage(highlight, display.generateIds);
              return (
                <div
                  key={t.id}
                  className="task-graph-node-wrap"
                  style={{
                    left: pos.x,
                    top: pos.y,
                    width: pos.w,
                    height: pos.h,
                  }}
                  onMouseEnter={() => setHoverId(t.id === GENERATION_HUB_ID ? null : t.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <TaskNode
                    task={t}
                    selected={t.id === selectedTaskId}
                    dimmed={dimmed || hubDimmed}
                    progressStep={progressOrder.get(t.id) ?? 0}
                    isHub={t.id === GENERATION_HUB_ID}
                    onSelect={() => handleNodeSelect(t)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function generatesInLineage(
  lineage: Set<string>,
  generateIds: Set<string>,
): boolean {
  for (const id of lineage) {
    if (generateIds.has(id)) return true;
  }
  return false;
}

export function JobTaskTree({
  jobId,
  graph,
  selectedTaskId,
  onSelectTask,
  onPreviewCsv,
  previewLabel,
  previewText,
  presentation = "inline",
}: {
  jobId: string;
  graph: TaskGraph;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onPreviewCsv: (url: string, label: string) => void;
  previewLabel?: string | null;
  previewText?: string | null;
  presentation?: "inline" | "modal";
}) {
  const selected = graph.tasks.find((t) => t.id === selectedTaskId) ?? null;
  const childrenOfSelected = selected
    ? childTaskIds(selected.id, graph.edges)
    : [];

  return (
    <div
      className={`task-tree-panel ${presentation === "modal" ? "task-tree-panel--modal" : ""}`}
    >
      <TaskGraphCanvas
        jobId={jobId}
        graph={graph}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
        presentation={presentation}
      />

      {selected && (
        <div className="task-node-detail card inset">
          <div className="submit-header">
            <h3>
              {selected.kind} · L{selected.level} · {shortId(selected.id)}
              {selected.is_final ? " (final)" : ""}
            </h3>
            <button
              type="button"
              className="ghost btn-sm"
              onClick={() => onSelectTask(null)}
            >
              Close
            </button>
          </div>
          <div className="task-detail-grid">
            <div>
              <span className="kpi-label">Status</span>
              <span className={`badge badge-task-${selected.status}`}>
                {selected.status}
              </span>
              {selected.attempt > 1 && (
                <span className="mono"> attempt {selected.attempt}</span>
              )}
            </div>
            <div>
              <span className="kpi-label">Worker</span>
              <div className="mono">
                {selected.worker_id ? shortWorker(selected.worker_id) : "—"}
              </div>
            </div>
            <div>
              <span className="kpi-label">Duration</span>
              <div className="mono">{formatMs(selected.duration_ms)}</div>
            </div>
            <div>
              <span className="kpi-label">Timestamps</span>
              <div className="mono detail-times">
                created {formatTime(selected.created_at)}
                {selected.published_at &&
                  ` · pub ${formatTime(selected.published_at)}`}
                {selected.completed_at &&
                  ` · done ${formatTime(selected.completed_at)}`}
              </div>
            </div>
          </div>
          {selected.last_error && (
            <div className="banner-error compact">
              {selected.last_error}
            </div>
          )}
          {(selected.parent_task_ids.length > 0 || childrenOfSelected.length > 0) && (
            <div className="task-lineage">
              {selected.parent_task_ids.length > 0 && (
                <div>
                  <span className="kpi-label">Parent tasks</span>
                  <div className="chip-row">
                    {selected.parent_task_ids.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="chip chip-btn"
                        onClick={() => onSelectTask(id)}
                      >
                        {shortId(id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {childrenOfSelected.length > 0 && (
                <div>
                  <span className="kpi-label">Child tasks</span>
                  <div className="chip-row">
                    {childrenOfSelected.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="chip chip-btn"
                        onClick={() => onSelectTask(id)}
                      >
                        {shortId(id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="io-grid">
            <IoTable
              jobId={jobId}
              taskId={selected.id}
              title="Inputs"
              files={selected.inputs}
              onPreview={onPreviewCsv}
            />
            <IoTable
              jobId={jobId}
              taskId={selected.id}
              title="Outputs"
              files={selected.outputs}
              onPreview={onPreviewCsv}
            />
          </div>
          {previewText && (
            <div className="preview-box compact">
              <div className="kpi-label">{previewLabel}</div>
              <div className="mono">{previewText}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatBytes,
  formatMs,
  matchesStatus,
  planEstimate,
  shortId,
  validJobShape,
  type StatusFilter,
} from "./format";
import { JobTaskTree } from "./JobTaskTree";
import { TaskGraphModal } from "./TaskGraphModal";
import type { TaskGraph } from "./taskGraph";

const API = "/api";

type Stats = {
  workers: {
    desired?: number;
    total: number;
    busy: number;
    dead: number;
  };
  active_jobs: Array<{
    id: string;
    f: number;
    c: number;
    status: string;
    waiting: boolean;
    progress: { generation: number; reduction: number };
  }>;
};

type PoolStateEntry = { items: number; files_covered: number };

type JobSummary = {
  id: string;
  status: string;
  f: number;
  c: number;
  seed?: number;
  generated_files?: number;
  failure_reason?: string | null;
  created_at?: string;
  generation_completed_at?: string | null;
  finished_at?: string | null;
  partials_cleaned_at?: string | null;
  progress?: { generation: number; reduction: number };
  pool_items?: Record<string, PoolStateEntry>;
  timings_ms?: {
    generation: number | null;
    reduction: number | null;
    total: number | null;
  };
};

function MiniProgress({
  generation,
  reduction,
}: {
  generation: number;
  reduction: number;
}) {
  const pct = Math.round(
    Math.min(100, Math.max(0, ((generation + reduction) / 2) * 100)),
  );
  return (
    <div
      className="mini-progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`Gen ${Math.round(generation * 100)}% · Red ${Math.round(reduction * 100)}%`}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<{ db: string; amqp: string } | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [taskGraph, setTaskGraph] = useState<TaskGraph | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskGraphOpen, setTaskGraphOpen] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const [f, setF] = useState(12);
  const [c, setC] = useState(5);
  const [desiredW, setDesiredW] = useState<number>(4);
  const [wEdited, setWEdited] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setTaskGraphOpen(false);
    setSelectedTaskId(null);
  }, [selectedJobId]);

  const liveEstimate = useMemo(() => planEstimate(f, c), [f, c]);
  const shapeError = validJobShape(f, c);

  const refreshJobs = useCallback(async () => {
    const res = await fetch(`${API}/jobs?limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    setRecentJobs(data.jobs ?? []);
  }, []);

  const refreshSelectedJob = useCallback(async (id: string) => {
    const [jobRes, graphRes] = await Promise.all([
      fetch(`${API}/jobs/${id}`),
      fetch(`${API}/jobs/${id}/task-graph`),
    ]);
    if (!jobRes.ok) {
      if (jobRes.status === 404) {
        setSelectedJobId(null);
        setSelectedJob(null);
        setTaskGraph(null);
        setSelectedTaskId(null);
      }
      return;
    }
    const data = (await jobRes.json()) as JobSummary;
    setSelectedJob(data);
    if (graphRes.ok) {
      setTaskGraph((await graphRes.json()) as TaskGraph);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const [sRes, hRes] = await Promise.all([
        fetch(`${API}/stats`),
        fetch(`${API}/health`),
      ]);
      if (hRes.ok || hRes.status === 503) {
        const h = await hRes.json().catch(() => null);
        if (h) setHealth(h);
      }
      if (!sRes.ok) throw new Error(`stats ${sRes.status}`);
      const s = (await sRes.json()) as Stats;
      setStats(s);
      if (!wEdited && typeof s.workers?.desired === "number") {
        setDesiredW(s.workers.desired);
      }
      setError(null);
      await refreshJobs();
      if (selectedJobId) {
        await refreshSelectedJob(selectedJobId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "API unreachable");
      setStats(null);
    }
  }, [refreshJobs, refreshSelectedJob, selectedJobId, wEdited]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 1000);
    return () => clearInterval(t);
  }, [poll]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 4500);
  }

  async function submitJob(submitF: number, submitC: number) {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ f: submitF, c: submitC }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Submit failed (${res.status})`);
        return;
      }
      const created = (await res.json()) as JobSummary;
      setSelectedJobId(created.id);
      setSelectedJob(created);
      setPreviewText(null);
      showToast(`Created job ${shortId(created.id)} (F=${submitF}, C=${submitC})`);
      await refreshJobs();
      await refreshSelectedJob(created.id);
      void poll();
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (shapeError) {
      setError(shapeError);
      return;
    }
    await submitJob(f, c);
  }

  async function cancelJob(id: string) {
    setError(null);
    const res = await fetch(`${API}/jobs/${id}/cancel`, { method: "POST" });
    if (!res.ok) {
      setError(`Cancel failed (${res.status})`);
    } else {
      showToast(`Cancelled job ${shortId(id)}`);
    }
    await refreshJobs();
    if (selectedJobId === id) await refreshSelectedJob(id);
  }

  async function cancelAllActive() {
    const activeIds = (stats?.active_jobs ?? []).map((j) => j.id);
    if (!activeIds.length) return;
    if (!window.confirm(`Cancel ${activeIds.length} active job(s)? Running tasks finish but their results are discarded.`)) return;
    setError(null);
    await Promise.all(
      activeIds.map((id) => fetch(`${API}/jobs/${id}/cancel`, { method: "POST" })),
    );
    showToast(`Cancelled ${activeIds.length} active job(s)`);
    await refreshJobs();
    void poll();
  }

  async function deleteJob(id: string) {
    if (!window.confirm(`Delete job ${shortId(id)} and all its files?`)) return;
    setError(null);
    const res = await fetch(`${API}/jobs/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      setError(`Delete failed (${res.status})`);
    } else {
      showToast(`Deleted job ${shortId(id)}`);
      if (selectedJobId === id) {
        setSelectedJobId(null);
        setSelectedJob(null);
        setTaskGraph(null);
        setSelectedTaskId(null);
        setPreviewText(null);
      }
    }
    await refreshJobs();
  }

  async function runCleanup(force: boolean) {
    if (force && !window.confirm("Delete intermediate partials of every finished job now?")) return;
    setError(null);
    const res = await fetch(`${API}/cleanup${force ? "?force=true" : ""}`, {
      method: "POST",
    });
    if (!res.ok) {
      setError(`Cleanup failed (${res.status})`);
      return;
    }
    const data = (await res.json()) as {
      jobs_cleaned: number;
      files_deleted: number;
      bytes_freed: number;
    };
    showToast(
      `${force ? "Force cleanup" : "Cleanup"}: ${data.jobs_cleaned} jobs, ${data.files_deleted} files (${formatBytes(data.bytes_freed)} freed)`,
    );
    void poll();
  }

  async function scaleFleet(newW: number) {
    setError(null);
    const clamped = Math.max(1, Math.min(32, Math.floor(newW)));
    setDesiredW(clamped);
    setWEdited(false);
    const res = await fetch(`${API}/fleet`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desired_workers: clamped }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Scale failed (${res.status})`);
      return;
    }
    showToast(`Target fleet size set to W=${clamped}`);
    void poll();
  }

  async function pruneDeadWorkers() {
    setError(null);
    const res = await fetch(`${API}/fleet/prune-dead`, { method: "POST" });
    if (!res.ok) return;
    const data = (await res.json()) as { removed: number };
    showToast(`Removed ${data.removed} dead worker entry(s)`);
    void poll();
  }

  async function loadCsvPreview(url: string, label: string) {
    setError(null);
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Preview failed (${res.status})`);
      return;
    }
    const text = (await res.text()).trim();
    const values = text.split(",");
    const shown =
      values.length > 32
        ? `${values.slice(0, 32).join(", ")} … (${values.length} values total)`
        : values.join(", ");
    setPreviewLabel(label);
    setPreviewText(shown);
  }

  const connected = stats !== null;
  const activeCount = stats?.active_jobs.length ?? 0;

  const mergedJobs = useMemo(() => {
    const activeMap = new Map(
      (stats?.active_jobs ?? []).map((a) => [a.id, a]),
    );
    const list: Array<JobSummary & { waiting?: boolean }> = [];
    for (const a of stats?.active_jobs ?? []) {
      const detail = recentJobs.find((r) => r.id === a.id);
      list.push({
        ...(detail ?? {}),
        ...a,
      });
    }
    for (const r of recentJobs) {
      if (!activeMap.has(r.id)) {
        list.push(r);
      }
    }
    return list.filter((j) => matchesStatus(j, statusFilter));
  }, [recentJobs, stats?.active_jobs, statusFilter]);

  const hasActiveJobs = activeCount > 0;

  return (
    <div className="app">
      <header className="header header-compact">
        <div className="brand">
          <h1>
            dis<span className="brand-accent">mean</span>
          </h1>
          <p className="brand-tagline">Distributed mean · jobs & task tree</p>
        </div>
        <div className="header-status" aria-label="System status">
          {health && (
            <>
              <span className={`status-dot ${health.db === "ok" ? "ok" : "err"}`} title="Postgres" />
              <span className={`status-dot ${health.amqp === "ok" ? "ok" : "err"}`} title="RabbitMQ" />
            </>
          )}
          <span className={`live-pill ${connected ? "ok" : "err"}`}>
            <span className="dot" aria-hidden />
            {connected
              ? `W ${stats?.workers.busy ?? 0}/${stats?.workers.total ?? 0} busy`
              : "Offline"}
          </span>
          {connected && activeCount > 0 && (
            <span className="header-meta">{activeCount} active job(s)</span>
          )}
        </div>
      </header>

      {error && (
        <div className="banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {toast && (
        <div className="banner-toast" role="status">
          <span>{toast}</span>
          <button type="button" className="ghost" onClick={() => setToast(null)}>
            Close
          </button>
        </div>
      )}

      <div className="shell">
        <aside className="sidebar card">
          <h2 className="section-title">New job</h2>
          <form className="submit-form" onSubmit={submit}>
            <div className="field-row">
              <label className="field compact">
                <span>F files</span>
                <input
                  type="number"
                  min={2}
                  max={99999}
                  value={f}
                  onChange={(e) => setF(+e.target.value)}
                  aria-label="Number of files"
                />
              </label>
              <label className="field compact">
                <span>C values</span>
                <input
                  type="number"
                  min={2}
                  max={999999}
                  value={c}
                  onChange={(e) => setC(+e.target.value)}
                  aria-label="Values per file"
                />
              </label>
            </div>
            <div className="preset-row">
              {[
                { label: "12×5", F: 12, C: 5 },
                { label: "50×100", F: 50, C: 100 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="chip chip-btn"
                  disabled={submitting || !connected}
                  onClick={() => {
                    setF(p.F);
                    setC(p.C);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button
              type="submit"
              className="primary submit-full"
              disabled={submitting || !connected || shapeError !== null}
              title={shapeError ?? undefined}
            >
              {submitting ? "Submitting…" : "Run job"}
            </button>
            {shapeError && <div className="field-error">{shapeError}</div>}
            <p className="form-hint">
              {liveEstimate.genTasks} GENERATE + {liveEstimate.mergeTasks} MERGE
              · ~{formatBytes(liveEstimate.inputBytes)} inputs
            </p>
          </form>

          <div className="sidebar-divider" />

          <div className="jobs-toolbar">
            <h2 className="section-title">Jobs</h2>
            <select
              className="filter-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="Filter jobs"
            >
              <option value="ALL">All</option>
              <option value="WAITING">Waiting</option>
              <option value="GENERATING">Generating</option>
              <option value="REDUCING">Reducing</option>
              <option value="COMPLETED">Completed</option>
              <option value="FAILED">Failed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>

          <ul className="job-list">
            {mergedJobs.length === 0 ? (
              <li className="empty">No jobs</li>
            ) : (
              mergedJobs.slice(0, 40).map((j) => {
                const status = j.status;
                const active =
                  status === "GENERATING" || status === "REDUCING";
                const isSelected = selectedJobId === j.id;
                const progress = j.progress ?? {
                  generation: 0,
                  reduction: 0,
                };
                return (
                  <li key={j.id}>
                    <button
                      type="button"
                      className={`job-list-item ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedJobId(j.id);
                        setSelectedTaskId(null);
                        setPreviewText(null);
                        void refreshSelectedJob(j.id);
                      }}
                    >
                      <span className="job-list-top">
                        <span className="mono job-list-id">{shortId(j.id)}</span>
                        <span className={`badge badge-${status}`}>{status}</span>
                      </span>
                      <span className="job-list-meta">
                        F={j.f} · C={j.c}
                      </span>
                      {(active || progress.generation < 1) && (
                        <MiniProgress
                          generation={progress.generation}
                          reduction={progress.reduction}
                        />
                      )}
                    </button>
                    <div className="job-list-actions">
                      {active && (
                        <button
                          type="button"
                          className="ghost danger btn-sm"
                          onClick={() => void cancelJob(j.id)}
                        >
                          Cancel
                        </button>
                      )}
                      {!active && (
                        <button
                          type="button"
                          className="ghost danger btn-sm"
                          onClick={() => void deleteJob(j.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>

          <details className="advanced-panel">
            <summary>Operations</summary>
            <div className="advanced-body">
              <p className="form-hint">Fleet target W</p>
              <div className="preset-row">
                {[1, 2, 4, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip chip-btn ${
                      (stats?.workers.desired ?? desiredW) === n ? "active" : ""
                    }`}
                    disabled={!connected}
                    onClick={() => void scaleFleet(n)}
                  >
                    {n}
                  </button>
                ))}
                <input
                  type="number"
                  min={1}
                  max={32}
                  className="w-input"
                  value={desiredW}
                  onChange={(e) => {
                    setWEdited(true);
                    setDesiredW(+e.target.value);
                  }}
                  aria-label="Target workers"
                />
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={!connected}
                  onClick={() => void scaleFleet(desiredW)}
                >
                  Set
                </button>
              </div>
              {hasActiveJobs && (
                <button
                  type="button"
                  className="danger btn-sm"
                  onClick={() => void cancelAllActive()}
                >
                  Cancel all active
                </button>
              )}
              <button
                type="button"
                className="secondary btn-sm"
                onClick={() => void runCleanup(false)}
                disabled={!connected}
              >
                Cleanup old partials
              </button>
              {(stats?.workers.dead ?? 0) > 0 && (
                <button
                  type="button"
                  className="ghost btn-sm"
                  onClick={() => void pruneDeadWorkers()}
                >
                  Clear dead workers ({stats?.workers.dead})
                </button>
              )}
            </div>
          </details>
        </aside>

        <main className="main-pane">
          {!selectedJob ? (
            <div className="empty-state card">
              <h2>Select a job</h2>
              <p>
                Pick a job from the list to inspect its task tree, files, and
                timings — or run a new job on the left.
              </p>
            </div>
          ) : (
            <section className="card inspector-card" aria-label="Job detail">
              <div className="job-hero">
                <div>
                  <h2 className="job-hero-title">
                    <span className={`badge badge-${selectedJob.status}`}>
                      {selectedJob.status}
                    </span>
                    <span className="mono">{shortId(selectedJob.id)}</span>
                  </h2>
                  <p className="job-hero-sub">
                    F={selectedJob.f} · C={selectedJob.c} · seed{" "}
                    {selectedJob.seed ?? "—"}
                    {selectedJob.timings_ms?.total != null && (
                      <>
                        {" "}
                        · {formatMs(selectedJob.timings_ms.total)} total
                      </>
                    )}
                  </p>
                </div>
                <div className="job-hero-actions">
                  {selectedJob.status === "COMPLETED" && (
                    <>
                      <a
                        className="btn secondary btn-sm"
                        href={`${API}/jobs/${selectedJob.id}/result.csv`}
                        download
                      >
                        Result CSV
                      </a>
                      <a
                        className="btn secondary btn-sm"
                        href={`${API}/jobs/${selectedJob.id}/result.npy`}
                        download
                      >
                        Result NPY
                      </a>
                    </>
                  )}
                  {(selectedJob.status === "GENERATING" ||
                    selectedJob.status === "REDUCING") && (
                    <button
                      type="button"
                      className="danger btn-sm"
                      onClick={() => void cancelJob(selectedJob.id)}
                    >
                      Cancel job
                    </button>
                  )}
                </div>
              </div>

              {selectedJob.progress && (
                <div className="job-progress-row">
                  <MiniProgress
                    generation={selectedJob.progress.generation}
                    reduction={selectedJob.progress.reduction}
                  />
                  <span className="job-progress-label mono">
                    Gen {Math.round(selectedJob.progress.generation * 100)}% ·
                    Red {Math.round(selectedJob.progress.reduction * 100)}%
                  </span>
                </div>
              )}

              {selectedJob.failure_reason && (
                <div className="banner-error compact">
                  {selectedJob.failure_reason}
                </div>
              )}

              <details className="diag-details">
                <summary>Diagnostics</summary>
                <dl className="diag-list mono">
                  <div>
                    <dt>UUID</dt>
                    <dd>{selectedJob.id}</dd>
                  </div>
                  <div>
                    <dt>Timings</dt>
                    <dd>
                      gen {formatMs(selectedJob.timings_ms?.generation)} · red{" "}
                      {formatMs(selectedJob.timings_ms?.reduction)}
                    </dd>
                  </div>
                  <div>
                    <dt>Pool</dt>
                    <dd>
                      ready {selectedJob.pool_items?.READY?.items ?? 0} · rsvd{" "}
                      {selectedJob.pool_items?.RESERVED?.items ?? 0} · consumed{" "}
                      {selectedJob.pool_items?.CONSUMED?.items ?? 0}
                    </dd>
                  </div>
                </dl>
              </details>

              {previewText && (
                <div className="preview-box">
                  <div className="kpi-label">{previewLabel}</div>
                  <div className="mono">{previewText}</div>
                </div>
              )}

              <div className="task-tree-launch">
                <h3 className="section-title tree-heading">Task graph</h3>
                {taskGraph && taskGraph.tasks.length > 0 ? (
                  <>
                    <p className="task-tree-teaser muted">
                      {taskGraph.tasks.length} tasks (
                      {taskGraph.tasks.filter((t) => t.kind === "MERGE").length}{" "}
                      merges)
                    </p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setTaskGraphOpen(true)}
                    >
                      Open task graph
                    </button>
                  </>
                ) : (
                  <p className="empty">No tasks yet.</p>
                )}
              </div>

              {taskGraphOpen &&
                taskGraph &&
                taskGraph.tasks.length > 0 &&
                selectedJob && (
                  <TaskGraphModal
                    title={`Task graph · ${shortId(selectedJob.id)} · F=${selectedJob.f}`}
                    onClose={() => {
                      setTaskGraphOpen(false);
                      setSelectedTaskId(null);
                    }}
                  >
                    <JobTaskTree
                      key={selectedJob.id}
                      presentation="modal"
                      jobId={selectedJob.id}
                      graph={taskGraph}
                      selectedTaskId={selectedTaskId}
                      onSelectTask={setSelectedTaskId}
                      onPreviewCsv={(url, label) =>
                        void loadCsvPreview(url, label)
                      }
                      previewLabel={previewLabel}
                      previewText={previewText}
                    />
                  </TaskGraphModal>
                )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

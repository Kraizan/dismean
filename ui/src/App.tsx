import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  eventClass,
  filterEvents,
  formatBytes,
  formatMs,
  formatTime,
  formatUptime,
  isActive,
  matchesStatus,
  planEstimate,
  shortId,
  shortWorker,
  validJobShape,
  type EventCategory,
  type StatusFilter,
} from "./format";

const API = "/api";

type WorkerRow = {
  id: string;
  state: string;
  task_id: string | null;
  job_id: string | null;
  task_kind: string | null;
  tasks_done: number;
  started_at?: string;
  last_heartbeat_at: string;
  hostname?: string;
  pid?: number;
  dead?: boolean;
};

type Stats = {
  at: string;
  workers: {
    desired?: number;
    total: number;
    idle: number;
    busy: number;
    stopping?: number;
    dead: number;
    list: WorkerRow[];
  };
  queue: {
    tasks_ready: number;
    tasks_unacked: number;
    coordinator_backlog?: number;
    tasks_dead?: number;
  };
  outbox_pending?: number;
  jobs: Record<string, number>;
  throughput: { tasks_per_sec_1m: number; avg_ms_1m: Record<string, number> };
  active_jobs: Array<{
    id: string;
    f: number;
    c: number;
    status: string;
    waiting: boolean;
    progress: { generation: number; reduction: number };
  }>;
};

type Event = {
  id: number;
  at: string;
  type: string;
  job_id?: string;
  task_id?: string;
  worker_id?: string;
  message?: string;
  data?: Record<string, unknown>;
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
  tasks?: Record<string, Record<string, number>>;
  pool_items?: Record<string, PoolStateEntry>;
  timings_ms?: {
    generation: number | null;
    reduction: number | null;
    total: number | null;
  };
  estimate?: {
    input_bytes: number;
    peak_partial_bytes: number;
    generate_tasks: number;
    merge_tasks: number;
  };
};

type TaskDetail = {
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
};

function ProgressBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div>
      <div className="progress-label">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<{ db: string; amqp: string } | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [jobTasks, setJobTasks] = useState<TaskDetail[]>([]);
  const [taskFilter, setTaskFilter] = useState<"ALL" | "GENERATE" | "MERGE">("ALL");
  const [inputPreviewIdx, setInputPreviewIdx] = useState(0);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventFilter, setEventFilter] = useState<string>("");
  const [eventCategory, setEventCategory] = useState<EventCategory>("ALL");
  const afterIdRef = useRef(0);
  const [f, setF] = useState(12);
  const [c, setC] = useState(5);
  const [desiredW, setDesiredW] = useState<number>(4);
  const [wEdited, setWEdited] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const liveEstimate = useMemo(() => planEstimate(f, c), [f, c]);
  const shapeError = validJobShape(f, c);

  const refreshJobs = useCallback(async () => {
    const res = await fetch(`${API}/jobs?limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    setRecentJobs(data.jobs ?? []);
  }, []);

  const refreshSelectedJob = useCallback(async (id: string) => {
    const [jobRes, tasksRes] = await Promise.all([
      fetch(`${API}/jobs/${id}`),
      fetch(`${API}/jobs/${id}/tasks`),
    ]);
    if (!jobRes.ok) {
      if (jobRes.status === 404) {
        setSelectedJobId(null);
        setSelectedJob(null);
        setJobTasks([]);
      }
      return;
    }
    const data = (await jobRes.json()) as JobSummary;
    setSelectedJob(data);
    if (tasksRes.ok) {
      const tData = (await tasksRes.json()) as { tasks: TaskDetail[] };
      setJobTasks(tData.tasks ?? []);
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
      const ev = await fetch(
        `${API}/events?after_id=${afterIdRef.current}&limit=100`,
      ).then((r) => r.json());
      if (ev.events?.length) {
        setEvents((prev) => [...prev, ...ev.events].slice(-500));
        afterIdRef.current = ev.events[ev.events.length - 1].id;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "API unreachable");
      setStats(null);
    }
  }, [refreshJobs, refreshSelectedJob, selectedJobId, wEdited]);

  useEffect(() => {
    void poll();
    if (paused) return;
    const t = setInterval(() => void poll(), 1000);
    return () => clearInterval(t);
  }, [poll, paused]);

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
        setJobTasks([]);
        setPreviewText(null);
      }
    }
    await refreshJobs();
  }

  async function deleteAllFinished() {
    const finished = recentJobs.filter((j) => !isActive(j.status));
    if (!finished.length) return;
    if (!window.confirm(`Delete ${finished.length} finished job(s) and all their files?`)) return;
    setError(null);
    await Promise.all(
      finished.map((j) => fetch(`${API}/jobs/${j.id}`, { method: "DELETE" })),
    );
    if (
      selectedJobId &&
      finished.some((j) => j.id === selectedJobId)
    ) {
      setSelectedJobId(null);
      setSelectedJob(null);
      setJobTasks([]);
      setPreviewText(null);
    }
    showToast(`Deleted ${finished.length} finished job(s)`);
    await refreshJobs();
    void poll();
  }

  async function runCleanup(force: boolean) {
    if (force && !window.confirm("Delete intermediate partials of every finished job now?")) return;
    setError(null);
    const res = await fetch(`${API}/cleanup${force ? "?force=true" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
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
  const jobCounts = stats?.jobs ?? {};
  const avgGen = stats?.throughput.avg_ms_1m.GENERATE;
  const avgMerge = stats?.throughput.avg_ms_1m.MERGE;

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

  const filteredTasks = useMemo(() => {
    if (taskFilter === "ALL") return jobTasks;
    return jobTasks.filter((t) => t.kind === taskFilter);
  }, [jobTasks, taskFilter]);

  const filteredEvents = useMemo(
    () => filterEvents(events, eventCategory, eventFilter),
    [events, eventFilter, eventCategory],
  );

  const hasActiveJobs = (stats?.active_jobs.length ?? 0) > 0;
  const hasFinishedJobs = recentJobs.some((j) => !isActive(j.status));

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>dismean</h1>
          <p>
            Distributed per-index mean · local control plane (W={stats?.workers.desired ?? desiredW}, ≤5 files/task)
          </p>
        </div>
        <div className="header-controls">
          {health && (
            <div className="health-badges" aria-label="Infrastructure health">
              <span className={`chip ${health.db === "ok" ? "chip-ok" : "chip-err"}`}>
                PG: <strong>{health.db}</strong>
              </span>
              <span className={`chip ${health.amqp === "ok" ? "chip-ok" : "chip-err"}`}>
                AMQP: <strong>{health.amqp}</strong>
              </span>
            </div>
          )}
          <button
            type="button"
            className="secondary btn-sm"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "Resume polling" : "Pause (1s)"}
          </button>
          <button
            type="button"
            className="secondary btn-sm"
            onClick={() => void poll()}
          >
            Refresh now
          </button>
          <div className={`live-pill ${connected ? "ok" : "err"}`}>
            <span className="dot" aria-hidden />
            {connected
              ? `${paused ? "Paused" : "Live"} · ${stats?.at ? formatTime(stats.at) : "synced"}`
              : "Disconnected"}
          </div>
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

      <section className="kpi-grid" aria-label="System overview">
        <div className="kpi">
          <div className="kpi-label">Workers (W)</div>
          <div className="kpi-value">
            {stats ? `${stats.workers.busy}/${stats.workers.total}` : "—"}
          </div>
          <div className="kpi-sub">
            {stats
              ? `target ${stats.workers.desired ?? stats.workers.total} · ${stats.workers.idle} idle · ${stats.workers.dead} dead`
              : "…"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Task queue</div>
          <div className="kpi-value">
            {stats ? stats.queue.tasks_ready : "—"}
          </div>
          <div className="kpi-sub">
            {stats
              ? `${stats.queue.tasks_unacked} in flight · ${stats.queue.tasks_dead ?? 0} DLQ`
              : "…"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Throughput</div>
          <div className="kpi-value">
            {stats ? stats.throughput.tasks_per_sec_1m : "—"}
          </div>
          <div className="kpi-sub">tasks/s (1m window)</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Dispatch backlog</div>
          <div className="kpi-value">{stats?.outbox_pending ?? "—"}</div>
          <div className="kpi-sub">tasks waiting in DB (fair-share)</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Coordinator</div>
          <div className="kpi-value">{stats?.queue.coordinator_backlog ?? "—"}</div>
          <div className="kpi-sub">event backlog</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Avg task ms</div>
          <div className="kpi-value" style={{ fontSize: "1.05rem" }}>
            {avgGen != null ? `G ${avgGen}ms` : "G —"}
            {" · "}
            {avgMerge != null ? `M ${avgMerge}ms` : "M —"}
          </div>
          <div className="kpi-sub">generate / merge (1m)</div>
        </div>
      </section>

      <section className="card submit-card" style={{ marginBottom: "1rem" }}>
        <div className="submit-header">
          <h2>Submit job & storage ops</h2>
          <div className="presets">
            <span className="preset-label">Presets:</span>
            <button
              type="button"
              className="secondary btn-sm"
              disabled={submitting || !connected}
              onClick={() => {
                setF(12);
                setC(5);
              }}
            >
              Small (12×5)
            </button>
            <button
              type="button"
              className="secondary btn-sm"
              disabled={submitting || !connected}
              onClick={() => {
                setF(50);
                setC(100);
              }}
            >
              Medium (50×100)
            </button>
            <button
              type="button"
              className="secondary btn-sm"
              disabled={submitting || !connected}
              onClick={() => {
                setF(250);
                setC(500);
              }}
            >
              Large (250×500)
            </button>
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <span>Files (F: 2–99,999)</span>
            <input
              type="number"
              min={2}
              max={99999}
              value={f}
              onChange={(e) => setF(+e.target.value)}
              aria-label="Number of files"
            />
          </div>
          <div className="field">
            <span>Values per file (C: 2–999,999)</span>
            <input
              type="number"
              min={2}
              max={999999}
              value={c}
              onChange={(e) => setC(+e.target.value)}
              aria-label="Values per file"
            />
          </div>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={submitting || !connected || shapeError !== null}
              title={shapeError ?? undefined}
            >
              {submitting ? "Submitting…" : "Run job"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void runCleanup(false)}
              disabled={!connected}
              title="Delete partials of jobs finished > 1h ago"
            >
              Cleanup (&gt;1h)
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void runCleanup(true)}
              disabled={!connected}
              title="Immediately delete partials of all finished jobs"
            >
              Force cleanup partials
            </button>
          </div>
          {shapeError && <div className="field-error">{shapeError}</div>}
          <div className="estimate-pill">
            <span>
              Plan: <strong>{liveEstimate.genTasks}</strong> GENERATE +{" "}
              <strong>{liveEstimate.mergeTasks}</strong> MERGE tasks
            </span>
            <span>
              Est. disk: <strong>{formatBytes(liveEstimate.inputBytes)}</strong> inputs +{" "}
              <strong>{formatBytes(liveEstimate.partialBytes)}</strong> peak partials
            </span>
          </div>
        </form>
      </section>

      {stats && (
        <section className="card" style={{ marginBottom: "1rem" }}>
          <div className="submit-header" style={{ marginBottom: 0 }}>
            <div className="status-row">
              <button
                type="button"
                className={`chip chip-btn ${statusFilter === "ALL" ? "active" : ""}`}
                onClick={() => setStatusFilter("ALL")}
              >
                <strong>ALL</strong>
                {Object.values(jobCounts).reduce((a, b) => a + b, 0)}
              </button>
              {(
                [
                  "WAITING",
                  "GENERATING",
                  "REDUCING",
                  "COMPLETED",
                  "FAILED",
                  "CANCELLED",
                ] as const
              ).map((key) => (
                <button
                  type="button"
                  className={`chip chip-btn ${statusFilter === key ? "active" : ""}`}
                  key={key}
                  onClick={() => setStatusFilter(key)}
                >
                  <strong>{key}</strong>
                  {jobCounts[key] ?? 0}
                </button>
              ))}
            </div>
            <div className="presets">
              {hasActiveJobs && (
                <button
                  type="button"
                  className="danger btn-sm"
                  onClick={() => void cancelAllActive()}
                >
                  Cancel all active
                </button>
              )}
              {hasFinishedJobs && (
                <button
                  type="button"
                  className="secondary btn-sm"
                  onClick={() => void deleteAllFinished()}
                >
                  Delete finished shown
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="layout">
        <div className="stack">
          <section className="card">
            <div className="submit-header">
              <h2>
                Worker fleet ({stats?.workers.total ?? 0} live /{" "}
                {stats?.workers.desired ?? desiredW} target)
              </h2>
              <div className="input-dl">
                {(stats?.workers.dead ?? 0) > 0 && (
                  <button
                    type="button"
                    className="danger btn-sm"
                    onClick={() => void pruneDeadWorkers()}
                  >
                    Clear dead ({stats?.workers.dead})
                  </button>
                )}
                <span className="preset-label">Quick W:</span>
                {[1, 2, 4, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`secondary btn-sm ${
                      (stats?.workers.desired ?? desiredW) === n ? "active-btn" : ""
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
                  value={desiredW}
                  onChange={(e) => {
                    setWEdited(true);
                    setDesiredW(+e.target.value);
                  }}
                  style={{ width: "4rem" }}
                  aria-label="Target workers W"
                />
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={!connected}
                  onClick={() => void scaleFleet(desiredW)}
                >
                  Apply W
                </button>
              </div>
            </div>
            {!stats?.workers.list.length ? (
              <p className="empty">No workers connected</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Worker</th>
                      <th>PID</th>
                      <th>State</th>
                      <th>Current task</th>
                      <th>Done</th>
                      <th>Uptime</th>
                      <th>Heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.workers.list.map((w) => (
                      <tr key={w.id}>
                        <td className="mono" title={w.id}>
                          {shortWorker(w.id)}
                        </td>
                        <td className="mono">{w.pid ?? "—"}</td>
                        <td>
                          <span className={`badge badge-worker-${w.state}`}>
                            {w.state}
                          </span>
                        </td>
                        <td className="mono">
                          {w.task_kind ?? "—"}
                          {w.job_id ? ` · ${shortId(w.job_id)}` : ""}
                        </td>
                        <td>{w.tasks_done}</td>
                        <td className="mono">{formatUptime(w.started_at)}</td>
                        <td className="mono">{formatTime(w.last_heartbeat_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Jobs ({mergedJobs.length})</h2>
            {!mergedJobs.length ? (
              <p className="empty">No matching jobs.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Status</th>
                      <th>Shape</th>
                      <th>Progress</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergedJobs.slice(0, 20).map((j) => {
                      const progress = j.progress;
                      const status = j.status;
                      const active =
                        status === "GENERATING" || status === "REDUCING";
                      const isSelected = selectedJobId === j.id;
                      return (
                        <tr
                          key={j.id}
                          className={isSelected ? "selected-row" : ""}
                          onClick={() => {
                            setSelectedJobId(j.id);
                            setPreviewText(null);
                            void refreshSelectedJob(j.id);
                          }}
                          style={{ cursor: "pointer" }}
                        >
                          <td className="mono" title={j.id}>
                            {shortId(j.id)}
                          </td>
                          <td>
                            <span className={`badge badge-${status}`}>
                              {status}
                              {j.waiting ? " · wait" : ""}
                            </span>
                            {j.partials_cleaned_at && (
                              <span className="cleaned-tag" title="Partials cleaned">
                                cleaned
                              </span>
                            )}
                          </td>
                          <td className="mono">
                            F={j.f} C={j.c}
                          </td>
                          <td style={{ minWidth: "130px" }}>
                            {progress ? (
                              <>
                                <ProgressBar
                                  label="Gen"
                                  value={progress.generation}
                                />
                                <ProgressBar
                                  label="Red"
                                  value={progress.reduction}
                                />
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <div className="row-actions">
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => {
                                  setSelectedJobId(j.id);
                                  setPreviewText(null);
                                  void refreshSelectedJob(j.id);
                                }}
                              >
                                Inspect
                              </button>
                              {active && (
                                <button
                                  type="button"
                                  className="ghost danger"
                                  onClick={() => void cancelJob(j.id)}
                                >
                                  Cancel
                                </button>
                              )}
                              {status === "COMPLETED" && (
                                <>
                                  <a
                                    href={`${API}/jobs/${j.id}/result.csv`}
                                    download
                                  >
                                    CSV
                                  </a>
                                  <a
                                    href={`${API}/jobs/${j.id}/result.npy`}
                                    download
                                  >
                                    NPY
                                  </a>
                                </>
                              )}
                              {!active && (
                                <button
                                  type="button"
                                  className="ghost danger"
                                  onClick={() => void deleteJob(j.id)}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          {selectedJob && (
            <section className="card inspector-card" aria-label="Job inspector">
              <div className="submit-header">
                <h2>Job inspector · {shortId(selectedJob.id)}</h2>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setSelectedJobId(null);
                    setSelectedJob(null);
                    setJobTasks([]);
                    setPreviewText(null);
                  }}
                >
                  Close
                </button>
              </div>
              <div className="inspector-grid">
                <div>
                  <span className="kpi-label">Job UUID</span>
                  <div className="mono">{selectedJob.id}</div>
                </div>
                <div>
                  <span className="kpi-label">Status / Seed</span>
                  <div>
                    <span className={`badge badge-${selectedJob.status}`}>
                      {selectedJob.status}
                    </span>{" "}
                    <span className="mono">seed={selectedJob.seed ?? "—"}</span>
                  </div>
                </div>
                <div>
                  <span className="kpi-label">Files generated</span>
                  <div className="mono">
                    {selectedJob.generated_files ?? 0} / {selectedJob.f} (C=
                    {selectedJob.c})
                  </div>
                </div>
                <div>
                  <span className="kpi-label">Wall timings</span>
                  <div className="mono">
                    Gen {formatMs(selectedJob.timings_ms?.generation)} · Red{" "}
                    {formatMs(selectedJob.timings_ms?.reduction)} · Total{" "}
                    {formatMs(selectedJob.timings_ms?.total)}
                  </div>
                </div>
                <div>
                  <span className="kpi-label">Pool items (files covered)</span>
                  <div className="mono">
                    READY {selectedJob.pool_items?.READY?.items ?? 0} (
                    {selectedJob.pool_items?.READY?.files_covered ?? 0}) · RSVD{" "}
                    {selectedJob.pool_items?.RESERVED?.items ?? 0} (
                    {selectedJob.pool_items?.RESERVED?.files_covered ?? 0}) · DONE{" "}
                    {selectedJob.pool_items?.CONSUMED?.items ?? 0}
                  </div>
                </div>
                <div>
                  <span className="kpi-label">Partials cleanup</span>
                  <div className="mono">
                    {selectedJob.partials_cleaned_at
                      ? `Cleaned at ${formatTime(selectedJob.partials_cleaned_at)}`
                      : "Retained on disk"}
                  </div>
                </div>
              </div>

              {selectedJob.failure_reason && (
                <div className="banner-error" style={{ marginTop: "0.75rem" }}>
                  Failure reason: {selectedJob.failure_reason}
                </div>
              )}

              <div className="inspector-actions">
                {selectedJob.status === "COMPLETED" && (
                  <>
                    <button
                      type="button"
                      className="secondary btn-sm"
                      onClick={() =>
                        void loadCsvPreview(
                          `${API}/jobs/${selectedJob.id}/result.csv`,
                          `Result mean (${selectedJob.c} values)`,
                        )
                      }
                    >
                      Preview result.csv
                    </button>
                    <a
                      className="btn secondary btn-sm"
                      href={`${API}/jobs/${selectedJob.id}/result.csv`}
                      download
                    >
                      Download result.csv
                    </a>
                    <a
                      className="btn secondary btn-sm"
                      href={`${API}/jobs/${selectedJob.id}/result.npy`}
                      download
                    >
                      Download result.npy
                    </a>
                  </>
                )}
                {(selectedJob.generated_files ?? 0) > 0 && (
                  <div className="input-dl">
                    <span className="preset-label">Input index:</span>
                    <input
                      type="number"
                      min={0}
                      max={selectedJob.f - 1}
                      value={inputPreviewIdx}
                      onChange={(e) =>
                        setInputPreviewIdx(
                          Math.max(
                            0,
                            Math.min(selectedJob.f - 1, Number(e.target.value) || 0),
                          ),
                        )
                      }
                      style={{ width: "4.5rem" }}
                      aria-label="Input file index"
                    />
                    <button
                      type="button"
                      className="secondary btn-sm"
                      onClick={() =>
                        void loadCsvPreview(
                          `${API}/jobs/${selectedJob.id}/inputs/${inputPreviewIdx}.csv`,
                          `Input file #${inputPreviewIdx}`,
                        )
                      }
                    >
                      Preview input CSV
                    </button>
                    <a
                      className="btn secondary btn-sm"
                      href={`${API}/jobs/${selectedJob.id}/inputs/${inputPreviewIdx}.csv`}
                      download
                    >
                      Download input #{inputPreviewIdx}
                    </a>
                  </div>
                )}
              </div>

              {previewText && (
                <div className="preview-box">
                  <div className="kpi-label">{previewLabel}</div>
                  <div className="mono">{previewText}</div>
                </div>
              )}

              <div className="task-section">
                <div className="submit-header" style={{ marginTop: "0.9rem" }}>
                  <h2>Task breakdown ({filteredTasks.length})</h2>
                  <div className="presets">
                    {(["ALL", "GENERATE", "MERGE"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={`chip chip-btn ${taskFilter === k ? "active" : ""}`}
                        onClick={() => setTaskFilter(k)}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="table-wrap task-table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Kind / Lvl</th>
                        <th>Scope</th>
                        <th>Status</th>
                        <th>Worker</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTasks.map((t) => (
                        <tr key={t.id}>
                          <td className="mono" title={t.id}>
                            {shortId(t.id)}
                            {t.attempt > 1 ? ` (a${t.attempt})` : ""}
                          </td>
                          <td className="mono">
                            {t.kind} L{t.level}
                            {t.is_final ? " ★" : ""}
                          </td>
                          <td className="mono">
                            {t.kind === "GENERATE"
                              ? `files ${t.file_start}..${(t.file_start ?? 0) + (t.file_count ?? 1) - 1}`
                              : `inputs=${t.input_count}`}
                          </td>
                          <td>
                            <span className={`badge badge-task-${t.status}`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="mono">
                            {t.worker_id ? shortWorker(t.worker_id) : "—"}
                          </td>
                          <td className="mono">{formatMs(t.duration_ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          <section className="card">
            <div className="submit-header">
              <h2>Event stream ({filteredEvents.length})</h2>
              <div className="presets">
                {(["ALL", "JOBS", "WORKERS", "ERRORS"] as const).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`chip chip-btn ${eventCategory === cat ? "active" : ""}`}
                    onClick={() => setEventCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
                <input
                  type="search"
                  className="search-input"
                  placeholder="Search events…"
                  value={eventFilter}
                  onChange={(e) => setEventFilter(e.target.value)}
                  aria-label="Filter events"
                />
              </div>
            </div>
            <div className="event-log">
              {filteredEvents.length === 0 ? (
                <p className="empty">No matching events…</p>
              ) : (
                filteredEvents.map((ev) => (
                  <div key={ev.id} className="event-line">
                    <span className="event-time">{formatTime(ev.at)}</span>
                    <span>
                      <span className={eventClass(ev.type)}>{ev.type}</span>
                      {ev.job_id && (
                        <button
                          type="button"
                          className="ghost mono inline-job-link"
                          onClick={() => {
                            setSelectedJobId(ev.job_id!);
                            setPreviewText(null);
                            void refreshSelectedJob(ev.job_id!);
                          }}
                        >
                          job {shortId(ev.job_id)}
                        </button>
                      )}
                      {ev.worker_id && (
                        <span className="mono">
                          {" "}
                          · {shortWorker(ev.worker_id)}
                        </span>
                      )}
                      {ev.message && (
                        <span style={{ color: "var(--text-muted)" }}>
                          {" "}
                          — {ev.message}
                        </span>
                      )}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

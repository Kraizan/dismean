import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = "/api";

type WorkerRow = {
  id: string;
  state: string;
  task_id: string | null;
  job_id: string | null;
  task_kind: string | null;
  tasks_done: number;
  last_heartbeat_at: string;
  hostname?: string;
  pid?: number;
  dead?: boolean;
};

type Stats = {
  at: string;
  workers: {
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
};

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

type StatusFilter =
  | "ALL"
  | "WAITING"
  | "GENERATING"
  | "REDUCING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function eventClass(type: string): string {
  if (
    type.includes("fail") ||
    type.includes("dead") ||
    type === "invalid_message"
  ) {
    return "event-type-fail";
  }
  if (type.includes("completed") || type === "job_created" || type === "cleanup_ran") {
    return "event-type-ok";
  }
  return "event-type";
}

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
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [inputPreviewIdx, setInputPreviewIdx] = useState(0);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventFilter, setEventFilter] = useState<string>("");
  const afterIdRef = useRef(0);
  const [f, setF] = useState(12);
  const [c, setC] = useState(5);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const liveEstimate = useMemo(() => {
    const safeF = Math.max(2, Math.min(99_999, Number.isFinite(f) ? Math.floor(f) : 2));
    const safeC = Math.max(2, Math.min(999_999, Number.isFinite(c) ? Math.floor(c) : 2));
    const genTasks = Math.ceil(safeF / 5);
    const mergeTasks = Math.ceil((safeF - 1) / 4);
    const inputBytes = safeF * safeC;
    const partialBytes = Math.max(0, mergeTasks - 1) * 8 * safeC;
    return {
      genTasks,
      mergeTasks,
      totalTasks: genTasks + mergeTasks,
      inputBytes,
      partialBytes,
      totalBytes: inputBytes + partialBytes,
    };
  }, [f, c]);

  const refreshJobs = useCallback(async () => {
    const res = await fetch(`${API}/jobs?limit=30`);
    if (!res.ok) return;
    const data = await res.json();
    setRecentJobs(data.jobs ?? []);
  }, []);

  const refreshSelectedJob = useCallback(async (id: string) => {
    const res = await fetch(`${API}/jobs/${id}`);
    if (!res.ok) {
      if (res.status === 404) {
        setSelectedJobId(null);
        setSelectedJob(null);
      }
      return;
    }
    const data = (await res.json()) as JobSummary;
    setSelectedJob(data);
  }, []);

  const poll = useCallback(async () => {
    try {
      const s = await fetch(`${API}/stats`).then((r) => {
        if (!r.ok) throw new Error(`stats ${r.status}`);
        return r.json();
      });
      setStats(s);
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
  }, [refreshJobs, refreshSelectedJob, selectedJobId]);

  useEffect(() => {
    const t = setInterval(() => void poll(), 1000);
    void poll();
    return () => clearInterval(t);
  }, [poll]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 4000);
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
      void poll();
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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

  async function deleteJob(id: string) {
    setError(null);
    const res = await fetch(`${API}/jobs/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      setError(`Delete failed (${res.status})`);
    } else {
      showToast(`Deleted job ${shortId(id)}`);
      if (selectedJobId === id) {
        setSelectedJobId(null);
        setSelectedJob(null);
        setPreviewText(null);
      }
    }
    await refreshJobs();
  }

  async function runCleanup() {
    setError(null);
    const res = await fetch(`${API}/cleanup`, { method: "POST" });
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
      `Cleanup: ${data.jobs_cleaned} jobs, ${data.files_deleted} files (${formatBytes(data.bytes_freed)} freed)`,
    );
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
      values.length > 24
        ? `${values.slice(0, 24).join(", ")} … (${values.length} values total)`
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
    return list.filter((j) => {
      if (statusFilter === "ALL") return true;
      if (statusFilter === "WAITING") return Boolean(j.waiting);
      if (statusFilter === "GENERATING") return j.status === "GENERATING" && !j.waiting;
      return j.status === statusFilter;
    });
  }, [recentJobs, stats?.active_jobs, statusFilter]);

  const filteredEvents = useMemo(() => {
    const q = eventFilter.trim().toLowerCase();
    const base = [...events].reverse();
    if (!q) return base;
    return base.filter(
      (ev) =>
        ev.type.toLowerCase().includes(q) ||
        (ev.job_id && ev.job_id.toLowerCase().includes(q)) ||
        (ev.worker_id && ev.worker_id.toLowerCase().includes(q)) ||
        (ev.message && ev.message.toLowerCase().includes(q)),
    );
  }, [events, eventFilter]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>dismean</h1>
          <p>Distributed per-index mean · local control plane (W workers, ≤5 files/task)</p>
        </div>
        <div className={`live-pill ${connected ? "ok" : "err"}`}>
          <span className="dot" aria-hidden />
          {connected ? `Live · ${stats?.at ? formatTime(stats.at) : "synced"}` : "Disconnected"}
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
          <div className="kpi-label">Workers</div>
          <div className="kpi-value">
            {stats ? `${stats.workers.busy}/${stats.workers.total}` : "—"}
          </div>
          <div className="kpi-sub">
            {stats
              ? `${stats.workers.idle} idle · ${stats.workers.dead} dead`
              : "…"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Task queue</div>
          <div className="kpi-value">
            {stats ? stats.queue.tasks_ready : "—"}
          </div>
          <div className="kpi-sub">
            {stats ? `${stats.queue.tasks_unacked} in flight · ${stats.queue.tasks_dead ?? 0} DLQ` : "…"}
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
          <div className="kpi-label">Outbox</div>
          <div className="kpi-value">{stats?.outbox_pending ?? "—"}</div>
          <div className="kpi-sub">pending publish</div>
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
          <h2>Submit job</h2>
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
            <button type="submit" className="primary" disabled={submitting || !connected}>
              {submitting ? "Submitting…" : "Run job"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void runCleanup()}
              disabled={!connected}
              title="Sweep partials of finished jobs past retention"
            >
              Cleanup old data
            </button>
          </div>
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
          <h2>Filter jobs by status</h2>
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
        </section>
      )}

      <div className="layout">
        <div className="stack">
          <section className="card">
            <h2>Worker fleet ({stats?.workers.total ?? 0})</h2>
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
                      <th>Heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.workers.list.map((w) => (
                      <tr key={w.id}>
                        <td className="mono" title={w.id}>
                          {w.id.replace(/\.local-/, "-")}
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
                    {mergedJobs.slice(0, 15).map((j) => {
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
                  <span className="kpi-label">GENERATE tasks</span>
                  <div className="mono">
                    {JSON.stringify(selectedJob.tasks?.GENERATE ?? {})}
                  </div>
                </div>
                <div>
                  <span className="kpi-label">MERGE tasks</span>
                  <div className="mono">
                    {JSON.stringify(selectedJob.tasks?.MERGE ?? {})}
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
            </section>
          )}

          <section className="card">
            <div className="submit-header">
              <h2>Event stream ({filteredEvents.length})</h2>
              <input
                type="search"
                className="search-input"
                placeholder="Filter events (type, job, worker)…"
                value={eventFilter}
                onChange={(e) => setEventFilter(e.target.value)}
                aria-label="Filter events"
              />
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
                        <span className="mono"> · job {shortId(ev.job_id)}</span>
                      )}
                      {ev.worker_id && (
                        <span className="mono">
                          {" "}
                          · {ev.worker_id.replace(/\.local-/, "-")}
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

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatUptime(startedAt: string | undefined, now = Date.now()): string {
  if (!startedAt) return "—";
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return "—";
  const sec = Math.max(0, Math.floor((now - started) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function shortWorker(id: string): string {
  return id.replace(/\.local-/, "-");
}

/** Same formulas as the API's job estimate (LLD §10.1), clamped to the accepted bounds. */
export function planEstimate(f: number, c: number) {
  const safeF = Math.max(2, Math.min(99_999, Number.isFinite(f) ? Math.floor(f) : 2));
  const safeC = Math.max(2, Math.min(999_999, Number.isFinite(c) ? Math.floor(c) : 2));
  const genTasks = Math.ceil(safeF / 5);
  const mergeTasks = Math.ceil((safeF - 1) / 4);
  const inputBytes = safeF * safeC;
  const partialBytes = Math.max(0, mergeTasks - 1) * 8 * safeC;
  return { genTasks, mergeTasks, inputBytes, partialBytes };
}

export function validJobShape(f: number, c: number): string | null {
  if (!Number.isInteger(f) || f < 2 || f > 99_999) return "F must be an integer from 2 to 99,999";
  if (!Number.isInteger(c) || c < 2 || c > 999_999) return "C must be an integer from 2 to 999,999";
  return null;
}

export type EventCategory = "ALL" | "JOBS" | "WORKERS" | "ERRORS";

export interface UiEvent {
  id: number;
  at: string;
  type: string;
  job_id?: string;
  task_id?: string;
  worker_id?: string;
  message?: string;
}

export function isErrorEvent(type: string): boolean {
  return (
    type.includes("fail") ||
    type.includes("dead") ||
    type === "task_retry" ||
    type === "invalid_message"
  );
}

export function eventClass(type: string): string {
  if (isErrorEvent(type) && type !== "task_retry") return "event-type-fail";
  if (type.includes("completed") || type === "job_created" || type === "cleanup_ran" || type === "fleet_scaled") {
    return "event-type-ok";
  }
  return "event-type";
}

/** Newest first, filtered by category and a free-text query. */
export function filterEvents(events: UiEvent[], category: EventCategory, query: string): UiEvent[] {
  const q = query.trim().toLowerCase();
  return [...events].reverse().filter((ev) => {
    if (category === "JOBS" && !ev.type.startsWith("job_") && ev.type !== "generation_completed") return false;
    if (category === "WORKERS" && !ev.type.startsWith("worker_") && ev.type !== "fleet_scaled") return false;
    if (category === "ERRORS" && !isErrorEvent(ev.type)) return false;
    if (!q) return true;
    return [ev.type, ev.job_id, ev.worker_id, ev.message].some((v) => v?.toLowerCase().includes(q));
  });
}

export type StatusFilter = "ALL" | "WAITING" | "GENERATING" | "REDUCING" | "COMPLETED" | "FAILED" | "CANCELLED";

export function matchesStatus(job: { status: string; waiting?: boolean }, filter: StatusFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "WAITING") return Boolean(job.waiting);
  if (filter === "GENERATING") return job.status === "GENERATING" && !job.waiting;
  return job.status === filter;
}

export function isActive(status: string): boolean {
  return status === "GENERATING" || status === "REDUCING";
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

export type StatusFilter = "ALL" | "WAITING" | "GENERATING" | "REDUCING" | "COMPLETED" | "FAILED" | "CANCELLED";

export function matchesStatus(job: { status: string; waiting?: boolean }, filter: StatusFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "WAITING") return Boolean(job.waiting);
  if (filter === "GENERATING") return job.status === "GENERATING" && !job.waiting;
  return job.status === filter;
}

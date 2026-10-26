export type JobStatus =
  | "GENERATING"
  | "REDUCING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type TaskKind = "GENERATE" | "MERGE";

export type TaskStatus =
  | "CREATED"
  | "PUBLISHED"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export type ItemKind = "INPUT" | "PARTIAL";
export type ItemState = "READY" | "RESERVED" | "CONSUMED" | "DELETED";

/** Typed rows for jobs, tasks, pool items, fleet. See docs/code-map.md · LLD §2. */

export interface JobRow {
  id: string;
  f: number;
  c: number;
  status: JobStatus;
  seed: string;
  generated_files: number;
  failure_reason: string | null;
  created_at: Date;
  generation_completed_at: Date | null;
  finished_at: Date | null;
  partials_cleaned_at: Date | null;
}

export interface TaskRow {
  id: string;
  job_id: string;
  kind: TaskKind;
  status: TaskStatus;
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
}

export interface ItemRow {
  id: string;
  job_id: string;
  kind: ItemKind;
  state: ItemState;
  count: number;
  level: number;
  path: string;
  produced_by: string | null;
  reserved_by: string | null;
  created_at: Date;
}

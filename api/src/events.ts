import type { Config } from "./config.js";

export type EventType =
  | "job_created"
  | "generation_completed"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "job_deleted"
  | "task_retry"
  | "task_dead_lettered"
  | "duplicate_completion"
  | "stale_failure"
  | "ignored_inactive_job"
  | "invalid_message"
  | "worker_started"
  | "worker_stopped"
  | "worker_dead"
  | "fleet_scaled"
  | "cleanup_ran";

export interface AppEvent {
  id: number;
  at: string;
  type: EventType;
  job_id?: string;
  task_id?: string;
  worker_id?: string;
  message?: string;
  data?: Record<string, unknown>;
}

let nextId = 1;
const buffer: AppEvent[] = [];
let maxSize = 500;

export function initEventBuffer(config: Config): void {
  maxSize = config.EVENT_BUFFER_SIZE;
}

export function pushEvent(
  event: Omit<AppEvent, "id" | "at"> & { at?: string },
): AppEvent {
  const entry: AppEvent = {
    id: nextId++,
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    job_id: event.job_id,
    task_id: event.task_id,
    worker_id: event.worker_id,
    message: event.message,
    data: event.data,
  };
  buffer.push(entry);
  if (buffer.length > maxSize) {
    buffer.splice(0, buffer.length - maxSize);
  }
  console.log(JSON.stringify(entry));
  return entry;
}

export function getEvents(afterId: number, limit: number): AppEvent[] {
  return buffer.filter((e) => e.id > afterId).slice(0, limit);
}

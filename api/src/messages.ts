/** Zod parsers for all AMQP message shapes. See docs/code-map.md · LLD §4. */
import { z } from "zod";

const uuid = z.string().uuid();
const schemaVersion = z.literal(1);

export const generateTaskPayloadSchema = z.object({
  seed: z.number().int().nonnegative(),
  file_indices: z.array(z.number().int().nonnegative()).min(1).max(5),
  output_paths: z.array(z.string()).min(1).max(5),
});

export const mergeInputSchema = z.object({
  item_id: uuid,
  path: z.string(),
  count: z.number().int().positive(),
});

export const mergeTaskPayloadSchema = z.object({
  inputs: z.array(mergeInputSchema).min(2).max(5),
  output_path: z.string().nullable(),
  final: z.boolean(),
  total_count: z.number().int().positive().nullable(),
  result_paths: z
    .object({ npy: z.string(), csv: z.string() })
    .nullable(),
});

export const taskMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    schema_version: schemaVersion,
    task_id: uuid,
    job_id: uuid,
    attempt: z.number().int().positive(),
    kind: z.literal("GENERATE"),
    c: z.number().int().positive(),
    generate: generateTaskPayloadSchema,
  }),
  z.object({
    schema_version: schemaVersion,
    task_id: uuid,
    job_id: uuid,
    attempt: z.number().int().positive(),
    kind: z.literal("MERGE"),
    c: z.number().int().positive(),
    merge: mergeTaskPayloadSchema,
  }),
]);

export type TaskMessage = z.infer<typeof taskMessageSchema>;

export const taskCompletedSchema = z.discriminatedUnion("kind", [
  z.object({
    schema_version: schemaVersion,
    task_id: uuid,
    job_id: uuid,
    attempt: z.number().int().positive(),
    kind: z.literal("GENERATE"),
    worker_id: z.string(),
    duration_ms: z.number().int().nonnegative(),
    output: z.object({ files_written: z.number().int().nonnegative() }),
  }),
  z.object({
    schema_version: schemaVersion,
    task_id: uuid,
    job_id: uuid,
    attempt: z.number().int().positive(),
    kind: z.literal("MERGE"),
    worker_id: z.string(),
    duration_ms: z.number().int().nonnegative(),
    output: z.object({ count: z.number().int().positive() }),
  }),
]);

export type TaskCompleted = z.infer<typeof taskCompletedSchema>;

export const taskFailedSchema = z.object({
  schema_version: schemaVersion,
  task_id: uuid,
  job_id: uuid,
  attempt: z.number().int().positive(),
  kind: z.enum(["GENERATE", "MERGE"]),
  worker_id: z.string(),
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});

export type TaskFailed = z.infer<typeof taskFailedSchema>;

export const workerHeartbeatSchema = z.object({
  schema_version: schemaVersion,
  worker_id: z.string(),
  hostname: z.string(),
  pid: z.number().int().positive(),
  state: z.enum(["IDLE", "BUSY", "STOPPING", "STOPPED"]),
  task_id: uuid.nullable(),
  job_id: uuid.nullable(),
  task_kind: z.enum(["GENERATE", "MERGE"]).nullable(),
  tasks_done: z.number().int().nonnegative(),
  started_at: z.string(),
  sent_at: z.string(),
});

export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

export const jobStoppedSchema = z.object({
  schema_version: schemaVersion,
  type: z.literal("job.stopped"),
  job_id: uuid,
  status: z.enum(["CANCELLED", "FAILED"]),
});

export type JobStopped = z.infer<typeof jobStoppedSchema>;

export type CoordinatorMessage =
  | { routingKey: "task.completed"; body: TaskCompleted }
  | { routingKey: "task.failed"; body: TaskFailed }
  | { routingKey: "dead"; body: TaskMessage };

export function parseCoordinatorPayload(
  routingKey: string,
  raw: unknown,
): CoordinatorMessage | null {
  if (routingKey === "task.completed") {
    const r = taskCompletedSchema.safeParse(raw);
    return r.success ? { routingKey, body: r.data } : null;
  }
  if (routingKey === "task.failed") {
    const r = taskFailedSchema.safeParse(raw);
    return r.success ? { routingKey, body: r.data } : null;
  }
  const r = taskMessageSchema.safeParse(raw);
  return r.success ? { routingKey: "dead", body: r.data } : null;
}

import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .default("postgres://dismean:dismean@localhost:5432/dismean"),
  AMQP_URL: z.string().default("amqp://guest:guest@localhost:5672"),
  RABBITMQ_MGMT_URL: z
    .string()
    .default("http://guest:guest@localhost:15672"),
  DATA_DIR: z
    .string()
    .refine((p) => p.startsWith("/"), { message: "DATA_DIR must be absolute" }),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  RELAY_BATCH: z.coerce.number().int().positive().default(500),
  DISPATCH_QUEUE_FACTOR: z.coerce.number().int().positive().default(2),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  PARTIAL_RETENTION_MS: z.coerce.number().int().positive().default(3_600_000),
  WORKER_COUNT: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_STALE_MS: z.coerce.number().int().positive().default(10_000),
  WORKER_PRUNE_MS: z.coerce.number().int().positive().default(60_000),
  EVENT_BUFFER_SIZE: z.coerce.number().int().positive().default(500),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}

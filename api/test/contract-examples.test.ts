import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  jobStoppedSchema,
  taskCompletedSchema,
  taskFailedSchema,
  taskMessageSchema,
  workerHeartbeatSchema,
} from "../src/messages.js";

const examplesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../contracts/examples",
);

function parserForFile(name: string) {
  const base = name.replace(/-/g, "_").replace(/\.json$/, "");
  if (base === "task_generate" || base.startsWith("task_merge")) {
    return taskMessageSchema;
  }
  if (base.startsWith("task_completed")) {
    return taskCompletedSchema;
  }
  if (base === "task_failed") {
    return taskFailedSchema;
  }
  if (base.startsWith("worker_heartbeat")) {
    return workerHeartbeatSchema;
  }
  if (base === "job_stopped") {
    return jobStoppedSchema;
  }
  return null;
}

describe("contract examples", () => {
  it("parses every JSON example", async () => {
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const parser = parserForFile(file);
      expect(parser, `no parser for ${file}`).not.toBeNull();
      const raw = JSON.parse(
        await readFile(path.join(examplesDir, file), "utf8"),
      ) as unknown;
      const result = parser!.safeParse(raw);
      expect(result.success, `failed to parse ${file}`).toBe(true);
    }
  });
});

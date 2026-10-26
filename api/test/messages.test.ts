/** Message zod parsing. See docs/code-map.md · LLD §4. */
import { describe, expect, it } from "vitest";
import {
  parseCoordinatorPayload,
  taskCompletedSchema,
  taskMessageSchema,
} from "../src/messages.js";

describe("message schemas", () => {
  it("rejects task message with >5 file indices", () => {
    const r = taskMessageSchema.safeParse({
      schema_version: 1,
      task_id: "00000000-0000-4000-8000-000000000001",
      job_id: "00000000-0000-4000-8000-000000000002",
      attempt: 1,
      kind: "GENERATE",
      c: 5,
      generate: {
        seed: 1,
        file_indices: [0, 1, 2, 3, 4, 5],
        output_paths: ["a", "b", "c", "d", "e", "f"],
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects coordinator payload with wrong routing key shape", () => {
    expect(
      parseCoordinatorPayload("task.completed", {
        schema_version: 1,
        task_id: "not-a-uuid",
        job_id: "00000000-0000-4000-8000-000000000002",
        attempt: 1,
        kind: "GENERATE",
        worker_id: "w",
        duration_ms: 0,
        output: { files_written: 1 },
      }),
    ).toBeNull();
  });

  it("accepts valid merge completion", () => {
    const r = taskCompletedSchema.safeParse({
      schema_version: 1,
      task_id: "00000000-0000-4000-8000-000000000001",
      job_id: "00000000-0000-4000-8000-000000000002",
      attempt: 1,
      kind: "MERGE",
      worker_id: "w",
      duration_ms: 10,
      output: { count: 5 },
    });
    expect(r.success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildTaskGraph,
  findGenerateTaskForIndex,
  inputIndexFromPath,
} from "../src/routes/taskGraph.js";

describe("taskGraph", () => {
  it("parses input index from path", () => {
    expect(inputIndexFromPath("jobs/x/inputs/000012.npy")).toBe(12);
    expect(inputIndexFromPath("jobs/x/partials/t.npy")).toBeNull();
  });

  it("maps file index to GENERATE task", () => {
    const tasks = [
      {
        id: "g0",
        kind: "GENERATE" as const,
        status: "DONE",
        attempt: 1,
        level: 0,
        file_start: 0,
        file_count: 5,
        input_count: null,
        is_final: false,
        worker_id: null,
        duration_ms: 1,
        last_error: null,
        created_at: new Date(),
        published_at: null,
        completed_at: null,
      },
      {
        id: "g1",
        kind: "GENERATE" as const,
        status: "DONE",
        attempt: 1,
        level: 0,
        file_start: 5,
        file_count: 2,
        input_count: null,
        is_final: false,
        worker_id: null,
        duration_ms: 1,
        last_error: null,
        created_at: new Date(),
        published_at: null,
        completed_at: null,
      },
    ];
    expect(findGenerateTaskForIndex(tasks, 3)).toBe("g0");
    expect(findGenerateTaskForIndex(tasks, 6)).toBe("g1");
  });

  it("builds edges from GENERATE to leaf MERGE via INPUT items", () => {
    const jobId = "11111111-1111-1111-1111-111111111111";
    const gId = "22222222-2222-2222-2222-222222222222";
    const mId = "33333333-3333-3333-3333-333333333333";
    const tasks = [
      {
        id: gId,
        kind: "GENERATE" as const,
        status: "DONE",
        attempt: 1,
        level: 0,
        file_start: 0,
        file_count: 2,
        input_count: null,
        is_final: false,
        worker_id: "w",
        duration_ms: 10,
        last_error: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        published_at: null,
        completed_at: null,
      },
      {
        id: mId,
        kind: "MERGE" as const,
        status: "DONE",
        attempt: 1,
        level: 1,
        file_start: null,
        file_count: null,
        input_count: 2,
        is_final: true,
        worker_id: "w",
        duration_ms: 20,
        last_error: null,
        created_at: new Date("2026-01-01T00:00:01Z"),
        published_at: null,
        completed_at: null,
      },
    ];
    const items = [
      {
        id: "i0",
        kind: "INPUT" as const,
        state: "CONSUMED",
        count: 1,
        level: 0,
        path: `jobs/${jobId}/inputs/000000.npy`,
        produced_by: null,
        reserved_by: mId,
      },
      {
        id: "i1",
        kind: "INPUT" as const,
        state: "CONSUMED",
        count: 1,
        level: 0,
        path: `jobs/${jobId}/inputs/000001.npy`,
        produced_by: null,
        reserved_by: mId,
      },
    ];
    const graph = buildTaskGraph(jobId, "COMPLETED", tasks, items);
    expect(graph.edges).toEqual([{ from: gId, to: mId }]);
    const merge = graph.tasks.find((t) => t.id === mId)!;
    expect(merge.inputs).toHaveLength(2);
    expect(merge.outputs.some((o) => o.kind === "RESULT")).toBe(true);
    const gen = graph.tasks.find((t) => t.id === gId)!;
    expect(gen.outputs).toHaveLength(2);
  });
});

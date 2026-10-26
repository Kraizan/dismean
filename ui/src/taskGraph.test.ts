import { describe, expect, it } from "vitest";
import {
  buildDisplayGraph,
  csvDownloadUrl,
  edgePathBetweenNodes,
  GENERATION_HUB_ID,
  groupTasksByLevel,
  layoutTaskGraph,
  lineageTaskIds,
  type TaskGraph,
  type TaskGraphTask,
} from "./taskGraph";

const baseTask = (overrides: Partial<TaskGraphTask>): TaskGraphTask => ({
  id: "x",
  kind: "MERGE",
  status: "DONE",
  attempt: 1,
  level: 1,
  file_start: null,
  file_count: null,
  input_count: 5,
  is_final: false,
  worker_id: null,
  duration_ms: null,
  last_error: null,
  created_at: "2026-01-01T00:00:00.000Z",
  published_at: null,
  completed_at: null,
  inputs: [],
  outputs: [],
  parent_task_ids: [],
  ...overrides,
});

describe("groupTasksByLevel", () => {
  it("sorts GENERATE by file_start", () => {
    const tasks = [
      {
        id: "b",
        kind: "GENERATE" as const,
        level: 0,
        file_start: 5,
        file_count: 1,
        status: "DONE",
        attempt: 1,
        input_count: null,
        is_final: false,
        worker_id: null,
        duration_ms: null,
        last_error: null,
        created_at: "",
        published_at: null,
        completed_at: null,
        inputs: [],
        outputs: [],
        parent_task_ids: [],
      },
      {
        id: "a",
        kind: "GENERATE" as const,
        level: 0,
        file_start: 0,
        file_count: 5,
        status: "DONE",
        attempt: 1,
        input_count: null,
        is_final: false,
        worker_id: null,
        duration_ms: null,
        last_error: null,
        created_at: "",
        published_at: null,
        completed_at: null,
        inputs: [],
        outputs: [],
        parent_task_ids: [],
      },
    ];
    const row = groupTasksByLevel(tasks).get(0)!;
    expect(row.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("layoutTaskGraph", () => {
  it("places tasks on distinct coordinates per level", () => {
    const tasks = [
      baseTask({ id: "g1", kind: "GENERATE", level: 0, file_start: 0, file_count: 5 }),
      baseTask({ id: "g2", kind: "GENERATE", level: 0, file_start: 5, file_count: 5 }),
      baseTask({
        id: "m1",
        level: 1,
        completed_at: "2026-01-01T00:00:02.000Z",
      }),
      baseTask({
        id: "m2",
        level: 1,
        completed_at: "2026-01-01T00:00:01.000Z",
      }),
    ];
    const { positions } = layoutTaskGraph(tasks);
    expect(positions.get("g1")!.y).toBe(positions.get("g2")!.y);
    expect(positions.get("m1")!.y).toBeGreaterThan(positions.get("g1")!.y);
    expect(positions.get("m2")!.x).toBeLessThan(positions.get("m1")!.x);
  });
});

describe("lineageTaskIds", () => {
  it("includes ancestors and descendants", () => {
    const edges = [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ];
    expect(lineageTaskIds("c", edges)).toEqual(new Set(["c", "a", "b", "d"]));
  });
});

describe("edgePathBetweenNodes", () => {
  it("returns an SVG path", () => {
    const d = edgePathBetweenNodes(
      { x: 0, y: 0, w: 80, h: 50, level: 0, indexInLevel: 0 },
      { x: 40, y: 120, w: 80, h: 50, level: 1, indexInLevel: 0 },
    );
    expect(d.startsWith("M ")).toBe(true);
  });
});

describe("buildDisplayGraph", () => {
  it("collapses many GENERATE nodes into one hub", () => {
    const generates = Array.from({ length: 8 }, (_, i) =>
      baseTask({
        id: `g${i}`,
        kind: "GENERATE",
        level: 0,
        file_start: i,
        file_count: 1,
      }),
    );
    const merge = baseTask({ id: "m1", level: 1 });
    const graph: TaskGraph = {
      tasks: [...generates, merge],
      edges: generates.map((g) => ({ from: g.id, to: "m1" })),
    };
    const display = buildDisplayGraph(graph, {
      collapseGenerate: true,
      visibleIds: null,
    });
    expect(display.collapsed).toBe(true);
    expect(display.tasks.filter((t) => t.kind === "GENERATE")).toHaveLength(1);
    expect(display.tasks[0]!.id).toBe(GENERATION_HUB_ID);
    expect(display.edges).toEqual([{ from: GENERATION_HUB_ID, to: "m1" }]);
  });
});

describe("csvDownloadUrl", () => {
  it("uses produced_by for PARTIAL inputs so final merge previews upstream partials", () => {
    expect(
      csvDownloadUrl(
        "/api",
        "job1",
        {
          kind: "PARTIAL",
          path: "jobs/job1/partials/m_leaf.npy",
          file_index: null,
          count: 5,
          item_id: "it1",
          item_state: "CONSUMED",
          produced_by: "m_leaf",
        },
        "m_final",
      ),
    ).toBe("/api/jobs/job1/partials/m_leaf.csv");
  });
});

import { describe, expect, it } from "vitest";
import {
  filterEvents,
  formatBytes,
  formatMs,
  formatUptime,
  matchesStatus,
  planEstimate,
  validJobShape,
  type UiEvent,
} from "./format";

describe("formatting", () => {
  it("formats bytes, durations and uptime", () => {
    expect(formatBytes(60)).toBe("60 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatMs(null)).toBe("—");
    expect(formatMs(250)).toBe("250 ms");
    expect(formatMs(1500)).toBe("1.50 s");
    const now = Date.parse("2026-10-26T10:00:00Z");
    expect(formatUptime("2026-10-26T09:59:30Z", now)).toBe("30s");
    expect(formatUptime("2026-10-26T08:58:00Z", now)).toBe("1h 2m");
    expect(formatUptime(undefined, now)).toBe("—");
  });
});

describe("planEstimate", () => {
  it("matches the API estimate for F=12, C=5", () => {
    expect(planEstimate(12, 5)).toEqual({ genTasks: 3, mergeTasks: 3, inputBytes: 60, partialBytes: 80 });
  });

  it("clamps out-of-range input instead of producing nonsense", () => {
    expect(planEstimate(1, 1).genTasks).toBe(1);
    expect(planEstimate(Number.NaN, 5).mergeTasks).toBe(1);
  });
});

describe("validJobShape", () => {
  it("accepts the spec bounds and rejects everything else", () => {
    expect(validJobShape(2, 2)).toBeNull();
    expect(validJobShape(99_999, 999_999)).toBeNull();
    expect(validJobShape(1, 5)).toMatch(/F must/);
    expect(validJobShape(10, 1_000_000)).toMatch(/C must/);
    expect(validJobShape(2.5, 5)).toMatch(/F must/);
  });
});

describe("filterEvents", () => {
  const events: UiEvent[] = [
    { id: 1, at: "t", type: "job_created", job_id: "aaaa1111" },
    { id: 2, at: "t", type: "worker_started", worker_id: "host-0-1" },
    { id: 3, at: "t", type: "job_failed", job_id: "bbbb2222", message: "boom" },
    { id: 4, at: "t", type: "fleet_scaled", message: "desired_workers = 6" },
  ];

  it("returns newest first and filters by category", () => {
    expect(filterEvents(events, "ALL", "").map((e) => e.id)).toEqual([4, 3, 2, 1]);
    expect(filterEvents(events, "JOBS", "").map((e) => e.id)).toEqual([3, 1]);
    expect(filterEvents(events, "WORKERS", "").map((e) => e.id)).toEqual([4, 2]);
    expect(filterEvents(events, "ERRORS", "").map((e) => e.id)).toEqual([3]);
  });

  it("searches type, job, worker and message", () => {
    expect(filterEvents(events, "ALL", "BOOM").map((e) => e.id)).toEqual([3]);
    expect(filterEvents(events, "ALL", "host-0").map((e) => e.id)).toEqual([2]);
  });
});

describe("matchesStatus", () => {
  it("separates waiting jobs from generating ones", () => {
    expect(matchesStatus({ status: "GENERATING", waiting: true }, "WAITING")).toBe(true);
    expect(matchesStatus({ status: "GENERATING", waiting: true }, "GENERATING")).toBe(false);
    expect(matchesStatus({ status: "COMPLETED" }, "COMPLETED")).toBe(true);
    expect(matchesStatus({ status: "FAILED" }, "ALL")).toBe(true);
  });
});

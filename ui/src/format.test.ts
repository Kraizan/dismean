import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatMs,
  matchesStatus,
  planEstimate,
  validJobShape,
} from "./format";

describe("formatting", () => {
  it("formats bytes and durations", () => {
    expect(formatBytes(60)).toBe("60 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatMs(null)).toBe("—");
    expect(formatMs(250)).toBe("250 ms");
    expect(formatMs(1500)).toBe("1.50 s");
  });
});

describe("planEstimate", () => {
  it("matches the API estimate for F=12, C=5", () => {
    expect(planEstimate(12, 5)).toEqual({
      genTasks: 3,
      mergeTasks: 3,
      inputBytes: 60,
      partialBytes: 80,
    });
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

describe("matchesStatus", () => {
  it("separates waiting jobs from generating ones", () => {
    expect(matchesStatus({ status: "GENERATING", waiting: true }, "WAITING")).toBe(
      true,
    );
    expect(matchesStatus({ status: "GENERATING", waiting: true }, "GENERATING")).toBe(
      false,
    );
    expect(matchesStatus({ status: "COMPLETED" }, "COMPLETED")).toBe(true);
    expect(matchesStatus({ status: "FAILED" }, "ALL")).toBe(true);
  });
});

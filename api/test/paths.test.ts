/** Path layout vs barrier SQL. See docs/code-map.md · ITD-028. */
import { describe, expect, it } from "vitest";
import { inputPath, inputPrefix, partialPath, resultPaths } from "../src/paths.js";

describe("paths", () => {
  it("inputPath matches barrier SQL fragment (prefix + zero-padded index)", () => {
    const jobId = "job-uuid";
    const prefix = inputPrefix(jobId);
    for (const i of [0, 1, 11, 999]) {
      expect(inputPath(jobId, i)).toBe(`${prefix}${String(i).padStart(6, "0")}.npy`);
    }
  });

  it("partial and result paths stay under jobs/{id}/", () => {
    const jobId = "abc";
    expect(partialPath(jobId, "task-1")).toBe("jobs/abc/partials/task-1.npy");
    expect(resultPaths(jobId)).toEqual({
      npy: "jobs/abc/result.npy",
      csv: "jobs/abc/result.csv",
    });
  });
});

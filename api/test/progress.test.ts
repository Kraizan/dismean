/** Reduction progress formula. See docs/code-map.md · LLD §5. */
import { describe, expect, it } from "vitest";
import { reductionProgress } from "../src/stats/progress.js";

describe("reductionProgress", () => {
  it("runs from 0 at the barrier to 1 when one item is left", () => {
    expect(reductionProgress("REDUCING", 12, 12)).toBe(0);
    expect(reductionProgress("REDUCING", 12, 4)).toBeCloseTo(8 / 11);
    expect(reductionProgress("REDUCING", 12, 1)).toBe(1);
  });

  it("is 0 while generating and 1 once completed", () => {
    expect(reductionProgress("GENERATING", 12, null)).toBe(0);
    expect(reductionProgress("COMPLETED", 12, 0)).toBe(1);
    expect(reductionProgress("REDUCING", 12, null)).toBe(0);
  });
});

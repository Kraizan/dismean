import { describe, expect, it } from "vitest";

function serialMakespan(leafTimes: number[]): number {
  return leafTimes.reduce((a, b) => a + b, 0);
}

function dynamicMakespan(leafDurations: number[]): number {
  type Node = { count: number; duration: number; state: "READY" | "CONSUMED" };
  const nodes: Node[] = leafDurations.map((d) => ({ count: 1, duration: d, state: "READY" }));
  const f = leafDurations.length;
  let time = 0;

  const readyIndices = () =>
    nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.state === "READY").map(({ i }) => i);

  const openMerges = () =>
    nodes.filter((n) => n.state === "RESERVED").length;

  const mergeReady = (indices: number[]) => {
    const dur = Math.max(...indices.map((i) => nodes[i]!.duration));
    time += dur;
    const total = indices.reduce((s, i) => s + nodes[i]!.count, 0);
    for (const i of indices) nodes[i]!.state = "CONSUMED";
    nodes.push({ count: total, duration: dur, state: "READY" });
  };

  for (let guard = 0; guard < 10_000; guard++) {
    const ready = readyIndices();
    const live = nodes
      .filter((n) => n.state === "READY")
      .reduce((s, n) => s + n.count, 0);
    if (live === f && ready.length === 1) break;

    if (ready.length >= 5) {
      mergeReady(ready.slice(0, 5));
      continue;
    }
    if (ready.length >= 2 && openMerges() === 0) {
      mergeReady(ready);
      continue;
    }
    throw new Error(`stuck: ready=${ready.length} live=${live}`);
  }
  return time;
}

describe("reduction simulation (speed variance)", () => {
  it("one merge absorbs a straggler faster than serial leaf processing", () => {
    const leaves = [10, 1, 1, 1, 1];
    expect(dynamicMakespan(leaves)).toBe(10);
    expect(serialMakespan(leaves)).toBe(14);
  });

  it("strict tail merges two leftovers without waiting for five", () => {
    const leaves = [3, 3, 3, 3];
    expect(dynamicMakespan(leaves)).toBe(3);
  });
});

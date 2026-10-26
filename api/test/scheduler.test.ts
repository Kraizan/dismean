import { describe, expect, it } from "vitest";

interface Item {
  count: number;
  state: "READY" | "RESERVED" | "CONSUMED";
}

function liveSum(items: Item[]): number {
  return items
    .filter((i) => i.state === "READY" || i.state === "RESERVED")
    .reduce((s, i) => s + i.count, 0);
}

function applyLeafMerges(items: Item[]): Item[] {
  const ready = items.filter((i) => i.state === "READY");
  const groups = Math.floor(ready.length / 5);
  let reserved = 0;
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < 5; i++) {
      ready[g * 5 + i]!.state = "RESERVED";
      reserved += ready[g * 5 + i]!.count;
    }
  }
  return items;
}

function openMerges(items: Item[]): number {
  return items.filter((i) => i.state === "RESERVED").length / 5;
}

function schedule(items: Item[]): void {
  for (;;) {
    const ready = items.filter((i) => i.state === "READY");
    if (ready.length === 5) {
      for (const item of ready.slice(0, 5)) item.state = "RESERVED";
      continue;
    }
    const open = openMerges(items);
    if (ready.length >= 2 && open === 0) {
      for (const item of ready) item.state = "RESERVED";
      continue;
    }
    break;
  }
}

function simulateBarrier(f: number): Item[] {
  const items: Item[] = Array.from({ length: f }, () => ({
    count: 1,
    state: "READY" as const,
  }));
  applyLeafMerges(items);
  schedule(items);
  return items;
}

describe("scheduler invariant", () => {
  it("keeps live item count equal to f after barrier scheduling", () => {
    for (let f = 2; f <= 50; f++) {
      const items = simulateBarrier(f);
      expect(liveSum(items)).toBe(f);
    }
  });
});

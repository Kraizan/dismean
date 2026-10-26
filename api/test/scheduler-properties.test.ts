import { describe, expect, it } from "vitest";

interface Item {
  count: number;
  state: "READY" | "RESERVED" | "CONSUMED";
}

function liveSum(items: Item[], f: number): number {
  return items
    .filter((i) => i.state === "READY" || i.state === "RESERVED")
    .reduce((s, i) => s + i.count, 0);
}

function openMerges(items: Item[]): number {
  return items.filter((i) => i.state === "RESERVED").length;
}

function applyMerge(items: Item[], f: number): { final: boolean } {
  const ready = items.filter((i) => i.state === "READY");
  const total = ready.reduce((s, i) => s + i.count, 0);
  for (const item of ready) {
    item.state = "CONSUMED";
  }
  items.push({ count: total, state: "RESERVED" });
  return { final: total === f };
}

function schedule(items: Item[], f: number): void {
  for (;;) {
    const ready = items.filter((i) => i.state === "READY");
    if (ready.length === 5) {
      applyMerge(items, f);
      const reserved = items.filter((i) => i.state === "RESERVED");
      const last = reserved[reserved.length - 1]!;
      last.state = "READY";
      items.splice(items.indexOf(last), 1);
      items.push(last);
      continue;
    }
    const open = openMerges(items);
    if (ready.length >= 2 && open === 0) {
      applyMerge(items, f);
      const reserved = items.filter((i) => i.state === "RESERVED");
      const last = reserved[reserved.length - 1]!;
      last.state = "READY";
      continue;
    }
    break;
  }
}

function simulateJob(f: number): { finalMerges: number; live: number } {
  const items: Item[] = Array.from({ length: f }, () => ({
    count: 1,
    state: "READY" as const,
  }));
  let finalMerges = 0;
  for (let g = 0; g < Math.floor(f / 5); g++) {
    for (let i = 0; i < 5; i++) {
      items[g * 5 + i]!.state = "RESERVED";
    }
    const total = 5;
    items.push({ count: total, state: "RESERVED" });
    for (let i = 0; i < 5; i++) {
      items[g * 5 + i]!.state = "CONSUMED";
    }
    const partial = items[items.length - 1]!;
    partial.state = "READY";
  }
  for (;;) {
    schedule(items, f);
    const ready = items.filter((i) => i.state === "READY");
    if (ready.length === 1 && ready[0]!.count === f) {
      const { final } = applyMerge(items, f);
      if (final) finalMerges += 1;
      break;
    }
    if (ready.length === 0 && items.every((i) => i.state === "CONSUMED")) break;
  }
  return { finalMerges, live: liveSum(items, f) };
}

describe("scheduler properties", () => {
  it("has exactly one final merge and preserves live=f for varied f", () => {
    for (let f = 2; f <= 40; f++) {
      const { finalMerges, live } = simulateJob(f);
      expect(finalMerges).toBe(1);
      expect(live).toBe(f);
    }
  });
});

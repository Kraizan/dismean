import { describe, expect, it } from "vitest";

/**
 * Discrete-event simulation of the reduction phase (design doc §9, IPD-005).
 * W workers with different speeds take merge tasks FIFO; a merge of k items costs k / speed.
 * Dynamic pool = ITD-004 (any 5 ready items, strict tail). Static = fixed 5-ary tree.
 */

interface Merge {
  inputs: number;
  onDone: () => void;
}

interface SimResult {
  makespan: number;
  idle: number;
  merges: number;
}

function simulate(
  speeds: number[],
  schedule: (enqueue: (m: Merge) => void) => { start: () => void; done: () => boolean },
): SimResult {
  const queue: Merge[] = [];
  const freeAt = speeds.map(() => 0);
  const running: Array<{ worker: number; end: number; merge: Merge }> = [];
  let now = 0;
  let busyTime = 0;
  let merges = 0;
  const policy = schedule((m) => queue.push(m));
  policy.start();

  for (let guard = 0; guard < 1_000_000 && !policy.done(); guard++) {
    for (let w = 0; w < speeds.length && queue.length > 0; w++) {
      if (freeAt[w]! <= now && !running.some((r) => r.worker === w)) {
        const merge = queue.shift()!;
        const dur = merge.inputs / speeds[w]!;
        running.push({ worker: w, end: now + dur, merge });
        busyTime += dur;
        merges += 1;
      }
    }
    if (running.length === 0) break;
    running.sort((x, y) => x.end - y.end);
    const next = running.shift()!;
    now = next.end;
    freeAt[next.worker] = now;
    next.merge.onDone();
  }
  return { makespan: now, idle: speeds.length * now - busyTime, merges };
}

function dynamicPool(f: number) {
  return (enqueue: (m: Merge) => void) => {
    let ready: number[] = Array.from({ length: f }, () => 1);
    let open = 0;
    let finished = false;
    const schedule = () => {
      for (;;) {
        if (ready.length >= 5) {
          const take = ready.splice(0, 5);
          launch(take);
        } else if (ready.length >= 2 && open === 0) {
          launch(ready.splice(0));
        } else break;
      }
    };
    const launch = (items: number[]) => {
      open += 1;
      const total = items.reduce((a, b) => a + b, 0);
      enqueue({
        inputs: items.length,
        onDone: () => {
          open -= 1;
          if (total === f) finished = true;
          else ready.push(total);
          schedule();
        },
      });
    };
    return { start: schedule, done: () => finished };
  };
}

function staticTree(f: number) {
  return (enqueue: (m: Merge) => void) => {
    let finished = false;
    // Each node waits for its own children only.
    const build = (count: number, onReady: () => void): (() => void)[] => {
      // Returns leaf triggers for a subtree covering `count` inputs.
      if (count <= 5) {
        return [() => enqueue({ inputs: count, onDone: onReady })];
      }
      const childSize = Math.ceil(count / 5);
      const sizes: number[] = [];
      for (let left = count; left > 0; left -= childSize) sizes.push(Math.min(childSize, left));
      let pending = sizes.length;
      const parentReady = () => {
        pending -= 1;
        if (pending === 0) enqueue({ inputs: sizes.length, onDone: onReady });
      };
      return sizes.flatMap((s) => (s === 1 ? [parentReady] : build(s, parentReady)));
    };
    const leaves = build(f, () => {
      finished = true;
    });
    return { start: () => leaves.forEach((l) => l()), done: () => finished };
  };
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("speed variance: dynamic pool vs static tree", () => {
  it("finishes no later and idles less when workers run at 0.5×–3× with one 10× straggler", () => {
    let dynamicTotal = 0;
    let staticTotal = 0;
    let dynamicIdle = 0;
    let staticIdle = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const w = 4 + Math.floor(r() * 5);
      const speeds = Array.from({ length: w }, () => 0.5 + r() * 2.5);
      speeds[0] = 0.1;
      const f = 50 + Math.floor(r() * 400);
      const d = simulate(speeds, dynamicPool(f));
      const s = simulate(speeds, staticTree(f));
      expect(d.makespan, `seed=${seed}`).toBeLessThanOrEqual(s.makespan * 1.0001);
      dynamicTotal += d.makespan;
      staticTotal += s.makespan;
      dynamicIdle += d.idle;
      staticIdle += s.idle;
    }
    expect(dynamicTotal).toBeLessThan(staticTotal);
    expect(dynamicIdle).toBeLessThan(staticIdle);
  });

  it("uses exactly ⌈(F−1)/4⌉ merges", () => {
    for (const f of [2, 5, 6, 12, 50, 101]) {
      expect(simulate([1, 1, 1], dynamicPool(f)).merges).toBe(Math.ceil((f - 1) / 4));
    }
  });
});

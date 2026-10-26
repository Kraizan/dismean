# Reduction walkthrough

## Example 1: F = 12

Notation: `I3` is input file 3 (count 1); `P_A` is the partial produced by MERGE A.

| Step | Event | Pool (READY) | Open MERGEs | Scheduler action |
|---|---|---|---|---|
| 0 | Barrier: generated_files = 12 | I0 … I11 (12) | — | 5 ready: **A = {I0–I4}**; 5 ready: **B = {I5–I9}**; 2 left with merges open: wait |
| 1 | B completes first (fast worker) | I10, I11, P_B(5) | A | 3 items, A still open: wait |
| 2 | A completes | I10, I11, P_B(5), P_A(5) | — | 4 items, no open merges: **C = all 4**, counts 1+1+5+5 = 12 = F, so **final** |
| 3 | C completes | — | — | Job **COMPLETED** (worker wrote the mean) |

Total merges = 3 = ⌈(12−1)/4⌉. Depth = 2.

## Example 2: why there's no fixed tree (F = 50, one slow worker)

There are 10 leaf merges, L1 … L10. L1 lands on a slow worker and takes 10× longer.

**Static 5-way tree:** the parents are fixed as `X = {L1..L5}` and `Y = {L6..L10}`, and the root is `{X, Y}`.
- Y runs as soon as L6–L10 finish.
- X waits for L1. Any worker that finished L2–L5 has no further work for this job until L1 finishes.

**Dynamic pool (this design):** the first 5 leaves to finish, say L2–L6, are merged right away into `P1(25)`, whichever leaves they are.
- L7–L10 and P1 make 5 ready items, so they merge into `P2(45)` while L1 is still running.
- When L1 finishes, the pool is {P_L1(5), P2(45)}. With no other merges open, they merge into the final result (5 + 45 = 50).

The slow worker delays only the very last merge, by its own extra time. No other merge waited for it, and the other workers kept merging while it ran.

| | Static tree | Dynamic pool |
|---|---|---|
| Merges blocked behind L1 | X, then root | only the final merge |
| Worker-time spent idle waiting on L1 | high (workers that finished L2–L5 wait for X) | ≈ 0 until the final merge |
| Total merges | 10 + 2 + 1 = 13 | 10 + 2 + 1 = 13 (≈ ⌈49/4⌉) |

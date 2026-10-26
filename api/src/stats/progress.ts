/**
 * Reduction progress from live pool items (READY or RESERVED); see docs/code-map.md · LLD §5.
 * Each merge of k items removes k−1 rows, so rows fall from F to 1 as the job reduces.
 */
export function reductionProgress(
  status: string,
  f: number,
  liveItems: number | null,
): number {
  if (status === "COMPLETED") return 1;
  if (status !== "REDUCING" || liveItems === null) return 0;
  if (f <= 1) return 1;
  return Math.max(0, Math.min(1, 1 - (liveItems - 1) / (f - 1)));
}

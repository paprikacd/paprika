import type { Threshold } from "../schema";

export function thresholdForValue(
  value: number,
  thresholds?: readonly Threshold[],
) {
  if (!Number.isFinite(value) || !thresholds?.length) return undefined;
  let match = thresholds[0];
  for (const threshold of thresholds) {
    if (threshold.value > value) break;
    match = threshold;
  }
  return match;
}

/**
 * Quantiles from cumulative-histogram buckets, with the semantics of Prometheus' histogram_quantile:
 * the rank lands in the first bucket whose cumulative count reaches it, and the value is interpolated
 * linearly inside that bucket. A rank in the +Inf bucket has no finite estimate, so it is reported as
 * overflow instead of inventing a value above the last finite bound. Averages of percentiles are never
 * computed here; callers pool bucket counts and call this once.
 */
export interface QuantileEstimate {
  q: number;
  /** Index of the bucket that holds the rank, in the ascending bounds. */
  bucket: number;
  lower: number;
  upper: number;
  /** Null when the rank falls in the +Inf bucket. */
  estimate: number | null;
  overflow: boolean;
  total: number;
}

/**
 * `bounds` are ascending upper bounds (the last may be Infinity) and `counts` the disjoint, non-negative
 * count of each bucket. Returns null when there are no observations or the input is malformed.
 */
export function bucketQuantile(bounds: readonly number[], counts: readonly number[], q: number): QuantileEstimate | null {
  if (!bounds.length || bounds.length !== counts.length || !(q >= 0 && q <= 1)) return null;
  let total = 0;
  for (let index = 0; index < bounds.length; index++) {
    const bound = bounds[index], count = counts[index];
    if (Number.isNaN(bound) || bound === -Infinity || !(count >= 0) || !Number.isFinite(count)) return null;
    if (index && bound < bounds[index - 1]) return null;
    total += count;
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const rank = Math.min(total, Math.max(0, q * total));
  // Walk the buckets that hold observations. Keep the last one seen as a fallback, so floating-point
  // rounding at the top rank still lands in the final populated bucket.
  let bucket = -1, before = 0, cumulative = 0;
  for (let index = 0; index < counts.length; index++) {
    if (!(counts[index] > 0)) continue;
    bucket = index;
    before = cumulative;
    cumulative += counts[index];
    if (cumulative >= rank) break;
  }
  const upper = bounds[bucket];
  // The first bucket interpolates from zero when its bound is positive. A non-positive first bound
  // has no known lower edge, so its estimate is the bound itself.
  const lower = bucket > 0 ? bounds[bucket - 1] : upper > 0 ? 0 : upper;
  if (upper === Infinity) return { q, bucket, lower, upper, estimate: null, overflow: true, total };
  const fraction = Math.min(1, Math.max(0, (rank - before) / counts[bucket]));
  return { q, bucket, lower, upper, estimate: lower + (upper - lower) * fraction, overflow: false, total };
}

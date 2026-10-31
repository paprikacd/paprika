import { formatMetric } from "../chart-data";
import plotHatchStyles from "../plot-hatch.module.css";
import type { DistributionCellState, WindowQuantile } from "./rich-metrics-data";
import heatmapStyles from "./distribution-heatmap.module.css";

export interface WindowHistogramBucket {
  /** Index of the bucket in the full bounds, which is also its displayed row. */
  bucket: number;
  label: string;
  value: number | null;
  state: DistributionCellState;
  /** Density colour for an observed bucket. Gap states are drawn with the hatch class instead. */
  fill: string;
}

export interface WindowHistogramProps {
  /** Displayed buckets, highest first. */
  buckets: readonly WindowHistogramBucket[];
  /** Index of the selected bucket. */
  selected: number;
  /** The window that the selected observation belongs to. Its total is the share denominator. */
  windowQuantile: WindowQuantile;
  /** Full label of any bucket, including buckets hidden above the displayed rows. */
  bucketLabel: (bucket: number) => string;
  unit: string;
  densityUnit: string;
  decimals?: number;
  /** The list is shown when pinned, and while hovering when there are twelve buckets or fewer. */
  showList: boolean;
}

/** One sentence about the window's p95, or null when a complete window has nothing to say. */
export function windowQuantileNote(entry: Pick<WindowQuantile, "state" | "gap" | "p95">, format: (value: number) => string, bucketLabel: (bucket: number) => string): string | null {
  const { state, gap, p95 } = entry;
  if (gap === "missing") return "p95 unavailable: this time has missing buckets.";
  if (gap === "invalid") return "p95 unavailable: this time has invalid buckets.";
  if (state === "unbounded") return "p95 unavailable: no +Inf bucket.";
  if (state === "empty") return "p95 unavailable: no observations at this time.";
  if (state === "ok" && p95?.overflow) return `p95 above ${format(p95.lower)} (overflow bucket).`;
  if (state === "ok" && p95?.estimate !== null && p95?.estimate !== undefined) return `p95 ≈ ${format(p95.estimate)}, estimated inside the ${bucketLabel(p95.bucket)} bucket.`;
  return null;
}

/** Each bucket's share of the window's full total, with the p95 note beneath the list. Gap buckets are hatched. */
export function DistributionWindowHistogram({ buckets, selected, windowQuantile, bucketLabel, unit, densityUnit, decimals, showList }: WindowHistogramProps) {
  const { total } = windowQuantile;
  const note = windowQuantileNote(windowQuantile, value => formatMetric(value, unit, false, decimals), bucketLabel);
  return <div className={heatmapStyles.window} data-window-state={windowQuantile.state}>
    {showList && <ul role="list" aria-label="Buckets at this time" className={heatmapStyles.windowList}>
      {buckets.map(bucket => {
        const current = bucket.bucket === selected;
        const share = bucket.state === "observed" && total && bucket.value !== null ? Math.min(1, bucket.value / total) : 0;
        return <li key={bucket.bucket} data-histogram-bucket={bucket.bucket} data-histogram-state={bucket.state} aria-current={current ? "true" : undefined}>
          <span className={heatmapStyles.windowLabel}>{bucket.label}</span>
          <span className={heatmapStyles.windowTrack}>{bucket.state === "observed"
            ? <i style={{ width: `${share * 100}%`, background: bucket.fill }} />
            : <i className={bucket.state === "missing" ? plotHatchStyles.hatch : plotHatchStyles.hatchWarning} style={{ width: "100%" }} />}</span>
          <b className={heatmapStyles.windowValue}>{bucket.state === "missing" ? "No observation" : bucket.state === "invalid" ? "Invalid counts" : formatMetric(bucket.value ?? 0, densityUnit, false, decimals)}</b>
        </li>;
      })}
    </ul>}
    {note && <p className={heatmapStyles.quantileNote}>{note}</p>}
  </div>;
}

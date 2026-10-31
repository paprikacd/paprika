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
export function windowQuantileNote(entry: Pick<WindowQuantile, "state" | "gap" | "hiddenGap" | "p95">, format: (value: number) => string, bucketLabel: (bucket: number) => string): string | null {
  const { state, gap, hiddenGap, p95 } = entry;
  // A gap above maxBuckets is not in any displayed row, so the note says where it is.
  const where = hiddenGap ? " above the shown range" : "";
  if (gap === "missing") return `p95 unavailable: this time has missing buckets${where}.`;
  if (gap === "invalid") return `p95 unavailable: this time has invalid buckets${where}.`;
  if (state === "unbounded") return "p95 unavailable: no +Inf bucket.";
  if (state === "empty") return "p95 unavailable: no observations at this time.";
  if (state === "ok" && p95?.overflow) return `p95 above ${format(p95.lower)} (overflow bucket).`;
  if (state === "ok" && p95?.estimate !== null && p95?.estimate !== undefined) return `p95 ≈ ${format(p95.estimate)}, estimated inside the ${bucketLabel(p95.bucket)} bucket.`;
  return null;
}

/** Each bucket's share of the window's full total, with the p95 note beneath the list. Gap buckets are hatched.
 * A window without a known total scales its observed buckets to the largest one shown, and says so. */
export function DistributionWindowHistogram({ buckets, selected, windowQuantile, bucketLabel, unit, densityUnit, decimals, showList }: WindowHistogramProps) {
  const { total } = windowQuantile;
  const largest = Math.max(0, ...buckets.map(bucket => bucket.state === "observed" ? bucket.value ?? 0 : 0));
  const scale = total ?? largest;
  const note = windowQuantileNote(windowQuantile, value => formatMetric(value, unit, false, decimals), bucketLabel);
  return <div className={heatmapStyles.window} data-window-state={windowQuantile.state}>
    {showList && <>
      <ul role="list" aria-label="Buckets at this time" className={heatmapStyles.windowList}>
        {buckets.map(bucket => {
          const current = bucket.bucket === selected;
          const observed = bucket.state === "observed" ? bucket.value ?? 0 : null;
          // A nonzero bucket keeps a two-pixel sliver, so a small share is never drawn as an observed zero.
          const share = observed !== null && scale > 0 ? Math.min(1, observed / scale) : 0;
          return <li key={bucket.bucket} data-histogram-bucket={bucket.bucket} data-histogram-state={bucket.state} aria-current={current ? "true" : undefined}>
            <span className={heatmapStyles.windowLabel}>{bucket.label}</span>
            <span className={heatmapStyles.windowTrack}>{observed !== null
              ? <i style={{ width: `${share * 100}%`, minWidth: observed > 0 ? 2 : undefined, background: bucket.fill }} />
              : <i className={bucket.state === "missing" ? plotHatchStyles.hatch : plotHatchStyles.hatchWarning} style={{ width: "100%" }} />}</span>
            <b className={heatmapStyles.windowValue}>{bucket.state === "missing" ? "No observation" : bucket.state === "invalid" ? "Invalid counts" : formatMetric(bucket.value ?? 0, densityUnit, false, decimals)}</b>
          </li>;
        })}
      </ul>
      {total === null && largest > 0 && <p className={heatmapStyles.quantileNote}>Scaled to the largest bucket shown; window total unknown.</p>}
    </>}
    {note && <p className={heatmapStyles.quantileNote}>{note}</p>}
  </div>;
}

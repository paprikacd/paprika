"use client";

import { useMemo, useState } from "react";
import { formatMetric } from "../chart-data.ts";
import { compareHistogramLabels, type DistributionConfig, type HeatmapRegion, type MetricSeries } from "./rich-metrics-data";

// The panel a selected latency region opens. It is loaded lazily, so the heatmap's first paint never carries its code or CSS.
// Its words describe the observations inside the region; they never call the region good or bad.

export interface DistributionRegionPanelProps {
  region: HeatmapRegion;
  series: readonly MetricSeries[];
  /** The result was truncated, so the comparison reads only the series that were returned. */
  partial?: boolean;
  config: DistributionConfig;
  bounds: readonly number[];
  /** The region's time range and bucket range, already formatted in the dashboard's zone and the bucket unit. */
  timeLabel: string;
  bucketLabel: string;
  unit: string;
  decimals?: number;
  /** The trace search this region names, or why it cannot be searched. Undefined when no trace source is configured. */
  traces?: { query: string } | { unavailable: string };
  onClear: () => void;
  onTraces?: () => void;
  /** Present only where a dashboard range can be set (view mode): sets every chart to this region's time range. */
  onUseRange?: () => void;
}

export function DistributionRegionPanel({ region, series, partial, config, timeLabel, bucketLabel, decimals, traces, onClear, onTraces, onUseRange }: DistributionRegionPanelProps) {
  const [comparing, setComparing] = useState(false);
  // One pass over the region serves both the share and the label comparison.
  const comparison = useMemo(() => compareHistogramLabels(series as MetricSeries[], config, region), [series, config, region]);
  const share = comparison.selectedShare;
  const label = comparison.keys[0];
  return (
    // The pinned panel around this one names the region, so this body carries no landmark of its own.
    <div data-distribution-region-panel className="grid gap-2 text-sm">
      <div className="grid gap-0.5">
        <strong className="font-medium">{timeLabel}</strong>
        <span className="opacity-80">{bucketLabel}</span>
        <span className="tabular-nums opacity-80">{formatMetric(share * 100, "%", false, decimals)} of this window&apos;s observations</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border px-2 py-1 text-xs" aria-pressed={comparing} onClick={() => setComparing(value => !value)}>Compare by label</button>
        {onTraces && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onTraces} disabled={!traces || "unavailable" in traces}>Traces in this range</button>}
        {onUseRange && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onUseRange}>Use this time range for all charts</button>}
        <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onClear}>Clear region</button>
      </div>
      {traces && "unavailable" in traces && <p className="text-xs opacity-80">{traces.unavailable}</p>}
      {comparing && (
        comparison.groups < 2 || !label ? (
          <p className="text-xs opacity-80">This query sums every label away. Group it by a label, for example sum by (le, route), to compare.</p>
        ) : comparison.selectedTotal <= 0 ? (
          <p className="text-xs opacity-80">No observations in this region to compare.</p>
        ) : (
          <div className="grid gap-1.5" aria-label={`Share of selected and other observations by ${label.key}`}>
            <span className="text-xs font-medium">{label.key}</span>
            {label.values.map(value => (
              <div key={value.value} className="grid gap-0.5 text-xs">
                <span>{value.value === "" ? "No value" : value.value}</span>
                <span className="block h-1.5 rounded" style={{ width: `${Math.round(value.selected * 100)}%`, background: "var(--gamma-ink)" }} aria-label={`${value.value} selected ${formatMetric(value.selected * 100, "%", false, decimals)}`} />
                <span className="block h-1.5 rounded" style={{ width: `${Math.round(value.rest * 100)}%`, background: "var(--gamma-muted)" }} aria-label={`${value.value} elsewhere ${formatMetric(value.rest * 100, "%", false, decimals)}`} />
              </div>
            ))}
            {(label.otherSelected > 0 || label.otherRest > 0) && <span className="text-xs opacity-80">Other values: {formatMetric(label.otherSelected * 100, "%", false, decimals)} selected, {formatMetric(label.otherRest * 100, "%", false, decimals)} elsewhere</span>}
            {comparison.skipped > 0 && <span className="text-xs opacity-80">{comparison.skipped} cells skipped: missing or invalid in this window</span>}
            {partial && <span className="text-xs opacity-80">Partial: the result was truncated, so only the returned series are compared.</span>}
          </div>
        )
      )}
    </div>
  );
}

export default DistributionRegionPanel;

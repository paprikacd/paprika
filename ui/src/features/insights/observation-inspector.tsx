"use client";

import { useId, useMemo, type ReactNode } from "react";
import { Clock3, Pin, X } from "lucide-react";
import { area, line } from "d3-shape";
import { GammaButton } from "./gamma/button";
import { exactMetric, formatMetricDetails, type Point, type Series } from "./chart-data";
import { calendarDateTime, DEFAULT_AREA_OPACITY } from "./chart-presentation";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import { metricTooltipTitle } from "./metric-tooltip-content";
import { widgetSeriesColors } from "./series-colors";
import {
  inspectPreparedObservation,
  prepareObservationInspector,
  type ExactObservation,
  type InspectionWindow,
  type InspectorSeries,
} from "./observation-inspector-data";
import type { Widget } from "./schema";
import { validTimestamp } from "./widget-context";
import styles from "./observation-inspector.module.css";

const TAG_KEYS = ["service", "gateway", "region", "interval", "slo", "direction"];

function exactLabel(row: InspectorSeries, unit: string, decimals?: number) {
  if (row.exact.kind === "observed") return formatMetricDetails(row.exact.value, unit, decimals);
  if (row.exact.kind === "absent") return "No sample at this time";
  if (row.exact.kind === "ambiguous") return "Multiple observations";
  return "Missing observation";
}

/** One row's history on the shared elapsed-time axis. The area fades to zero at the zero line, and the cursor marks the inspected time. */
function InspectorHistory({ row, start, end, timestamp, color }: { row: InspectorSeries; start: number; end: number; timestamp: number; color: string }) {
  const uid = useId();
  const min = Math.min(0, row.min ?? 0), max = Math.max(0, row.max ?? 0);
  const magnitude = Math.max(1, Math.abs(min), Math.abs(max));
  const low = min / magnitude, high = max / magnitude, span = high - low || 1;
  const zero = high === low ? 1 : high / span;
  const opacity = DEFAULT_AREA_OPACITY;
  const stops: [number, number][] = zero >= 1 ? [[0, opacity], [1, 0]] : zero <= 0 ? [[0, 0], [1, opacity]] : [[0, opacity], [zero, 0], [1, opacity]];
  const x = (time: number) => (start === end ? 140 : 2 + ((time - start) / (end - start)) * 276);
  const y = (value: number) => 35 - ((value / magnitude - low) / span) * 30;
  const path = line<Point>().defined((point) => point.value !== null).x((point) => x(point.timestamp)).y((point) => y(point.value!))(row.points);
  const fill = area<Point>().defined((point) => point.value !== null).x((point) => x(point.timestamp)).y0(y(0)).y1((point) => y(point.value!))(row.points);
  const selected = row.exact.kind === "observed" ? row.exact.value : null;
  // A lone observation between gaps has no line segment, so it gets a visible mark.
  const isolated = row.points.filter((point, index, points) => point.value !== null && (!index || points[index - 1].value === null) && (index === points.length - 1 || points[index + 1].value === null));
  return <svg viewBox="0 0 280 40" preserveAspectRatio="none" className={styles.history} aria-hidden="true" focusable="false" style={{ color }}>
    <defs>
      <linearGradient id={`${uid}-area`} x1="0" x2="0" y1="0" y2="1">
        {stops.map(([offset, stopOpacity]) => <stop key={offset} offset={offset} stopColor="currentColor" stopOpacity={stopOpacity} />)}
      </linearGradient>
    </defs>
    <path d={fill ?? undefined} fill={`url(#${uid}-area)`} />
    <line x1="2" x2="278" y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity=".12" />
    <path d={path ?? undefined} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    {isolated.map((point, index) => <path key={`${point.timestamp}:${index}`} d={`M${x(point.timestamp)},${y(point.value!)}h0`} stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
    {timestamp >= start && timestamp <= end && <line x1={x(timestamp)} x2={x(timestamp)} y1="2" y2="38" stroke="var(--gamma-muted, #52636f)" strokeDasharray="2 3" strokeOpacity=".65" />}
    {selected !== null && timestamp >= start && timestamp <= end && <path d={`M${x(timestamp)},${y(selected)}h0`} stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
  </svg>;
}

export interface ObservationInspectorProps {
  /** The widget whose tooltip options apply: title, value label, unit visibility and decimals. */
  widget?: Widget;
  /** Overrides the title that the widget's options would give. */
  title?: string;
  series: readonly Series[];
  selectedSeriesIndex: number;
  timestamp: number;
  unit: string;
  decimals?: number;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  /** The chart window the histories show. Without it, the histories span the returned data. */
  window?: InspectionWindow;
  /** Series colours by source index. Unset, the widget's own assignment is used, so the inspector matches the chart. */
  colors?: readonly string[];
  note?: string;
  /** Host actions, such as a drilldown, appended after the readings. */
  children?: ReactNode;
}

/**
 * Dense exact inspection for one timestamp. Every series at that exact time is shown, with a history on a shared
 * axis, the statistics of the window and the source values. A series with no sample at the time is never filled in.
 */
export function ObservationInspector({ widget, title, series, selectedSeriesIndex, timestamp, unit, decimals, pinned, onPin, onClose, window, colors, note, children }: ObservationInspectorProps) {
  const timeZone = useDashboardTimeZone();
  const sourceColors = useMemo(() => colors ?? widgetSeriesColors(series, widget ?? {}).map(choice => choice.color), [colors, series, widget]);
  const windowStart = window?.start, windowEnd = window?.end;
  const prepared = useMemo(
    () => prepareObservationInspector(series, windowStart === undefined || windowEnd === undefined ? undefined : { start: windowStart, end: windowEnd }, 12, 96, selectedSeriesIndex),
    [series, windowStart, windowEnd, selectedSeriesIndex],
  );
  const model = useMemo(() => inspectPreparedObservation(prepared, timestamp), [prepared, timestamp]);
  const selected = model.rows.find((row) => row.sourceIndex === selectedSeriesIndex) ?? model.rows[0];
  // The same precedence as MetricDetails: the widget's tooltip options refine the unit and decimals.
  const valueUnit = widget?.options?.tooltipShowUnit === false ? "" : unit;
  const valueDecimals = widget?.options?.tooltipDecimals ?? decimals ?? widget?.options?.decimals;
  const heading = title ?? (series.length ? metricTooltipTitle(widget, series[selectedSeriesIndex] ?? series[0], selectedSeriesIndex) : "Observation");
  const iso = validTimestamp(timestamp) ? new Date(timestamp).toISOString() : undefined;
  const bounds = model.start !== null && model.end !== null
    ? `${calendarDateTime(model.start, timeZone)} – ${calendarDateTime(model.end, timeZone)}`
    : "No timestamped observations";
  return <div className={styles.inspector} data-rich-observation="" data-inspection-start={model.start ?? undefined} data-inspection-end={model.end ?? undefined}>
    <header className={styles.header}>
      <div><span>{pinned ? "Pinned observation" : "Observation"}</span><strong>{heading}</strong></div>
      <GammaButton variant="ghost" size="sm" iconOnly aria-label="Close observation" onClick={onClose}><X size={14} aria-hidden="true" /></GammaButton>
    </header>
    <div className={styles.time}>
      <Clock3 size={13} aria-hidden="true" />
      {iso ? <time dateTime={iso}>{calendarDateTime(timestamp, timeZone)}</time> : <span>No valid timestamp</span>}
    </div>
    {selected && <div className={styles.tags}>
      {Object.entries(selected.labels).filter(([key]) => TAG_KEYS.includes(key)).map(([key, value]) => <span key={key} title={`${key}: ${value}`}>{value}</span>)}
    </div>}
    <div className={styles.rows}>
      {model.rows.map((row) => {
        const color = sourceColors[row.sourceIndex] ?? "var(--gamma-chart-1)";
        const exact: ExactObservation = row.exact;
        return <section key={row.key} className={styles.row} data-selected-series={row.sourceIndex === selectedSeriesIndex || undefined} data-observation-state={exact.kind}>
          <div className={styles.value}>
            <span><i style={{ background: color }} />{row.name}</span>
            <strong title={exact.kind === "observed" ? exactMetric(exact.value, valueUnit) : undefined}>{exactLabel(row, valueUnit, valueDecimals)}</strong>
          </div>
          {model.start !== null && model.end !== null && <InspectorHistory row={row} start={model.start} end={model.end} timestamp={timestamp} color={color} />}
          <div className={styles.stats}>
            <span>Min <b>{row.min === null ? "—" : formatMetricDetails(row.min, valueUnit, valueDecimals)}</b></span>
            <span>Max <b>{row.max === null ? "—" : formatMetricDetails(row.max, valueUnit, valueDecimals)}</b></span>
            <span title="Finite samples out of all returned samples in this history window">{row.finiteCount}/{row.sampleCount} observed</span>
          </div>
          {row.missingCount > 0 && <span className={styles.missing}>{row.missingCount} missing sample{row.missingCount === 1 ? "" : "s"}</span>}
          {row.invalidTimestampCount > 0 && <span className={styles.missing}>{row.invalidTimestampCount} source sample{row.invalidTimestampCount === 1 ? "" : "s"} excluded: invalid timestamp</span>}
        </section>;
      })}
    </div>
    <p className={styles.windowLine}>
      <span>{model.windowed ? "Chart window history" : "Source history"}</span>
      {bounds}
      {model.rows.some((row) => row.reduced) && <small>Histories visually reduced; statistics use all returned samples in this window.</small>}
    </p>
    {note && <p className={styles.note}>{note}</p>}
    {model.omittedSeries > 0 && <p className={styles.note}>{model.omittedSeries} additional series omitted from this inspector.</p>}
    {children}
    <details className={styles.details}>
      <summary>Exact observations &amp; labels</summary>
      <p>{iso ?? "No valid timestamp"} · raw values before display rounding</p>
      <table>
        <caption className={styles.srOnly}>Exact observations at the selected timestamp</caption>
        <thead><tr><th scope="col">Series</th><th scope="col">Value</th></tr></thead>
        <tbody>
          {model.rows.map((row) => <tr key={row.key}>
            <th scope="row">{row.name}</th>
            <td>{row.exact.kind === "observed"
              ? exactMetric(row.exact.value, valueUnit)
              : row.exact.kind === "ambiguous"
                ? row.exactSamples.map((point) => point.value === null ? "Missing" : exactMetric(point.value, valueUnit)).join("; ")
                : exactLabel(row, valueUnit)}</td>
          </tr>)}
        </tbody>
      </table>
      {selected && <dl>{Object.entries(selected.labels).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
    </details>
    <footer className={styles.footer}>
      <GammaButton size="sm" variant="quiet" onClick={onPin} aria-pressed={pinned}><Pin size={13} aria-hidden="true" />{pinned ? "Unpin observation" : "Pin observation"}</GammaButton>
      <span>Esc to close</span>
    </footer>
  </div>;
}

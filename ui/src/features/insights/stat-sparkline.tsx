"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Widget } from "./schema";
import { ObservationTooltip } from "./observation-tooltip";
import { installTooltipPointerTracking } from "./tooltip-pointer";
import { TooltipHint } from "./tooltip-content";
import { MetricDetails } from "./metric-tooltip-content";
import { nearestStatHistoryIndex, statHistoryObservations } from "./stat-history-interaction";
import { area, line } from "d3-shape";
import {
  boundHistoryPoints,
  exactMetric,
  type Point,
  type Series,
} from "./chart-data";
import { validTimestamp } from "./widget-context";
import styles from "./stat-sparkline.module.css";

export const MAX_SPARKLINE_POINTS = 240;

/** The trend uses the same series and range as the displayed latest-valid stat. */
export function StatSparkline({
  series,
  name,
  unit,
  color,
  widget,
  latestLabel = "Displayed latest valid sample",
}: {
  series: Series;
  name: string;
  unit: string;
  color?: string;
  widget?: Widget;
  latestLabel?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const gradientId = useId();
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<SVGSVGElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focused = useRef(false);
  const touchStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const enabled = !!widget && widget.options?.showTooltip !== false;
  const revision = useMemo(() => ({ series, widget, unit, name, color }), [series, widget, unit, name, color]);
  const observations = useMemo(() => statHistoryObservations(series.points), [series]);
  const [selection, setSelection] = useState<{ revision: unknown; index: number; pinned: boolean } | null>(null);
  const current = enabled && selection?.revision === revision ? selection : null;
  const selected = current ? observations[current.index] : undefined;
  const clearHide = useCallback(() => clearTimeout(hideTimer.current), []);
  const dismiss = useCallback(() => { clearHide(); setSelection(null); }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => {
      if (!focused.current) setSelection(value => value?.pinned ? value : null);
    }, 180);
  }, [clearHide]);
  useEffect(() => clearHide, [revision, clearHide]);
  useEffect(() => enabled ? installTooltipPointerTracking() : undefined, [enabled]);
  const select = (index: number, pinned = false) => {
    clearHide();
    if (index < 0) return;
    setSelection(previous => previous?.revision === revision && previous.index === index && previous.pinned === pinned ? previous : { revision, index, pinned });
  };
  const indexAt = (clientX: number, svg: SVGSVGElement) => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width || !observations.length) return -1;
    // The drawing has a one-unit inset at each end of its 240-unit viewBox.
    const fraction = Math.max(0, Math.min(1, ((clientX - bounds.left) / bounds.width * 240 - 1) / 238));
    return nearestStatHistoryIndex(observations, observations[0].timestamp + fraction * (observations[observations.length - 1].timestamp - observations[0].timestamp));
  };
  const history = useMemo(() => {
    let start = Infinity,
      end = -Infinity,
      min = Infinity,
      max = -Infinity,
      sampleCount = 0,
      missingCount = 0;
    let latest: Point | undefined;
    let latestValid: Point | undefined;
    for (const point of series.points) {
      if (!validTimestamp(point.timestamp)) continue;
      const value =
        typeof point.value === "number" && Number.isFinite(point.value)
          ? point.value
          : null;
      sampleCount++;
      start = Math.min(start, point.timestamp);
      end = Math.max(end, point.timestamp);
      if (!latest || point.timestamp >= latest.timestamp)
        latest = { timestamp: point.timestamp, value };
      if (value === null) {
        missingCount++;
        continue;
      }
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (!latestValid || point.timestamp >= latestValid.timestamp)
        latestValid = { timestamp: point.timestamp, value };
    }
    const points = boundHistoryPoints(series.points, MAX_SPARKLINE_POINTS);
    const x = (point: Point) =>
      start === end
        ? 120
        : 1 + ((point.timestamp - start) / (end - start)) * 238;
    const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
    const y = (point: Point) =>
      min === max
        ? 32
        : 60 -
          ((point.value! / magnitude - min / magnitude) /
            (max / magnitude - min / magnitude)) *
            56;
    const path = line<Point>()
      .defined((point) => point.value !== null)
      .x(x)
      .y(y)(points);
    const fill = area<Point>()
      .defined((point) => point.value !== null)
      .x(x)
      .y0(64)
      .y1(y)(points);
    const dots = points.filter(
      (point, index) =>
        point.value !== null &&
        ((point.timestamp === latestValid?.timestamp &&
          point.value === latestValid.value) ||
          ((index === 0 || points[index - 1].value === null) &&
            (index === points.length - 1 || points[index + 1].value === null))),
    );
    return {
      points,
      path,
      fill,
      dots,
      x,
      y,
      start,
      end,
      min,
      max,
      sampleCount,
      missingCount,
      latest,
      latestValid,
    };
  }, [series]);
  if (!history.latestValid) return null;
  const summary = [
    `History of the displayed series, from ${new Date(history.start).toISOString()} to ${new Date(history.end).toISOString()}.`,
    `${history.sampleCount} samples; ${history.missingCount} missing.`,
    `Minimum ${exactMetric(history.min, unit)}; maximum ${exactMetric(history.max, unit)}.`,
    `${latestLabel}: ${exactMetric(history.latestValid.value!, unit)} at ${new Date(history.latestValid.timestamp).toISOString()}.`,
    history.latest?.value === null
      ? `Latest observation is missing at ${new Date(history.latest.timestamp).toISOString()}.`
      : "",
    history.points.length < history.sampleCount
      ? `Trend reduced to ${history.points.length} plotted samples, preserving gaps and extrema.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
    <svg
      ref={setAnchor}
      className={styles.plot}
      tabIndex={enabled ? 0 : undefined}
      data-stat-interactive={enabled || undefined}
      data-stat-selected-time={selected?.timestamp}
      data-stat-selected-value={selected?.value ?? undefined}
      onPointerMove={enabled ? event => {
        if (event.pointerType === "touch") {
          if (touchStart.current && Math.hypot(event.clientX - touchStart.current.x, event.clientY - touchStart.current.y) > 8) touchStart.current.moved = true;
        } else if (!current?.pinned) select(indexAt(event.clientX, event.currentTarget));
      } : undefined}
      onPointerDown={enabled ? event => {
        if (event.pointerType === "touch") { touchStart.current = { x: event.clientX, y: event.clientY, moved: false }; return; }
        const index = indexAt(event.clientX, event.currentTarget);
        if (current?.pinned && current.index === index) dismiss();
        else select(index, true);
      } : undefined}
      onPointerUp={enabled ? event => {
        if (event.pointerType !== "touch") return;
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
        const index = indexAt(event.clientX, event.currentTarget);
        if (current?.pinned && current.index === index) dismiss();
        else select(index, true);
      } : undefined}
      onPointerCancel={enabled ? () => { touchStart.current = null; } : undefined}
      onPointerLeave={enabled ? scheduleHide : undefined}
      onFocus={enabled ? () => {
        focused.current = true;
        clearHide();
        setSelection(previous => previous?.revision === revision ? previous : { revision, index: observations.length - 1, pinned: false });
      } : undefined}
      onBlur={enabled ? () => { focused.current = false; scheduleHide(); } : undefined}
      onKeyDown={enabled ? event => {
        const index = current?.index ?? observations.length - 1;
        if (event.key === "Escape") { event.preventDefault(); dismiss(); }
        else if (["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (event.key === "Enter" || event.key === " ") select(index, !current?.pinned);
          else select(event.key === "Home" ? 0 : event.key === "End" ? observations.length - 1 : Math.max(0, Math.min(observations.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))), current?.pinned);
        }
      } : undefined}
      viewBox="0 0 240 64"
      preserveAspectRatio="none"
      role="img"
      aria-labelledby={titleId}
      aria-describedby={current ? `${descriptionId} ${tooltipId}` : descriptionId}
      data-stat-sparkline=""
      data-sample-count={history.sampleCount}
      data-rendered-samples={history.points.length}
      data-history-start={history.start}
      data-history-end={history.end}
      data-history-min={history.min}
      data-history-max={history.max}
      data-latest-valid-time={history.latestValid.timestamp}
      style={{ color }}
    >
      <title id={titleId}>History for {widget?.options?.tooltipTitle?.trim() || widget?.title || name}</title>
      <desc id={descriptionId}>{summary}{enabled ? " Move across the history to inspect recorded samples. Arrow keys move between samples; Home and End jump; Enter pins; Escape closes." : ""}</desc>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <path
        data-stat-area=""
        d={history.fill ?? undefined}
        fill={`url(#${gradientId})`}
        stroke="none"
      />
      <path
        data-stat-trend=""
        d={history.path ?? undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeOpacity="0.65"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Non-scaling round caps keep points circular as the backdrop stretches. */}
      {history.dots.map((point, index) => (
        <path
          key={`${point.timestamp}-${index}`}
          d={`M${history.x(point)},${history.y(point)}h0`}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.8"
          strokeWidth="4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          data-stat-point=""
          data-sample-time={point.timestamp}
          data-sample-value={point.value}
        />
      ))}
      {selected && <g data-stat-cursor="" aria-hidden="true">
        <line x1={history.x(selected)} x2={history.x(selected)} y1="0" y2="64" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        {selected.value !== null && <path d={`M${history.x(selected)},${history.y(selected)}h0`} stroke="currentColor" strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </g>}
    </svg>
    {selected && current && anchor && <ObservationTooltip id={tooltipId} anchor={anchor} anchorOwnsHistoryKeys pinned={current.pinned} onDismiss={dismiss} onEnter={clearHide} onLeave={scheduleHide}>
      <MetricDetails widget={widget} series={series} index={0} point={selected} unit={unit} description="Recorded sample" />
      <TooltipHint>{current.pinned ? "Pinned · Enter or tap to release" : "Move to inspect · Enter or tap to pin"}<span>Arrow keys navigate · Esc closes</span></TooltipHint>
    </ObservationTooltip>}
    </>
  );
}

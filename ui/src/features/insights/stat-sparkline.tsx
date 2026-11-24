"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Widget } from "./schema";
import { eventsInRange, type RecordedEvent } from "./annotation-events";
import { EventTicks } from "./event-ticks";
import { ObservationTooltip } from "./observation-tooltip";
import { installTooltipPointerTracking } from "./tooltip-pointer";
import { isRestoringTooltipFocus } from "./tooltip-focus";
import { useObservationOwner } from "./observation-owner";
import { MetricDetails } from "./metric-tooltip-content";
import { nearestStatHistoryIndex, statHistoryObservations, statPlotRectangle } from "./stat-history-interaction";
import { area, line } from "d3-shape";
import {
  boundHistoryPoints,
  formatMetricDetails,
  type Point,
  type Series,
} from "./chart-data";
import { validTimestamp } from "./widget-context";
import styles from "./stat-sparkline.module.css";

export const MAX_SPARKLINE_POINTS = 240;

/**
 * Whether a history is one value throughout: every sample is observed and shares that value. A missing sample is a gap,
 * so it is never steady, and neither is a single sample, which is a point rather than a trend. A steady history is shown
 * as "Steady" in place of a flat line.
 */
export function isSteadySeries(series: Series): boolean {
  let count = 0;
  let first: number | undefined;
  for (const point of series.points) {
    if (typeof point.value !== "number" || !Number.isFinite(point.value)) return false;
    if (first === undefined) first = point.value;
    else if (point.value !== first) return false;
    count++;
  }
  return count >= 2;
}

/** The trend uses the same series and range as the displayed latest-valid stat. */
export function StatSparkline({
  series,
  name,
  unit,
  color,
  widget,
  decimals,
  latestLabel = "Displayed latest valid sample",
  events,
  onSelect,
}: {
  series: Series;
  name: string;
  unit: string;
  color?: string;
  widget?: Widget;
  /** Recorded events drawn as ticks over the trend. Only the tile's own sparkline passes them. */
  events?: readonly RecordedEvent[];
  /** Fraction digits for the summary; the widget's decimals when omitted. */
  decimals?: number;
  latestLabel?: string;
  /** Called when the user focuses or activates the history, so the widget's drilldown context follows the series. */
  onSelect?: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const gradientId = useId();
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<SVGSVGElement | null>(null);
  const touchStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const enabled = !!widget && widget.options?.showTooltip !== false;
  const revision = useMemo(() => ({ series, widget, unit, name, color }), [series, widget, unit, name, color]);
  const observations = useMemo(() => statHistoryObservations(series.points), [series]);
  // Samples are kept by their position; a new series, widget or unit closes the open panel.
  const owner = useObservationOwner({ enabled, retention: { revision } });
  const current = owner.active ? { index: Number(owner.active.key), pinned: owner.active.pinned } : null;
  const selected = current ? observations[current.index] : undefined;
  useEffect(() => enabled ? installTooltipPointerTracking() : undefined, [enabled]);
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
  // Keyboard and pinned inspection rest on the selected sample's drawn point, not the whole plot.
  const sampleRect = useCallback(() => {
    if (!anchor || !selected) return new DOMRect();
    const box = statPlotRectangle(anchor.getBoundingClientRect(), history.x(selected), selected.value === null ? 32 : history.y(selected));
    return new DOMRect(box.left, box.top, box.width, box.height);
  }, [anchor, history, selected]);
  if (!history.latestValid) return null;
  const shownDecimals = decimals ?? widget?.options?.decimals;
  const summary = [
    `History of the displayed series, from ${new Date(history.start).toISOString()} to ${new Date(history.end).toISOString()}.`,
    `${history.sampleCount} samples; ${history.missingCount} missing.`,
    `Minimum ${formatMetricDetails(history.min, unit, shownDecimals)}; maximum ${formatMetricDetails(history.max, unit, shownDecimals)}.`,
    `${latestLabel}: ${formatMetricDetails(history.latestValid.value!, unit, shownDecimals)} at ${new Date(history.latestValid.timestamp).toISOString()}.`,
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
        } else if (!current?.pinned) {
          const index = indexAt(event.clientX, event.currentTarget);
          if (index >= 0) owner.engage(String(index), event.currentTarget, "pointer");
          else owner.leave(event.currentTarget, "pointer");
        }
      } : undefined}
      onPointerDown={enabled ? event => {
        if (event.pointerType === "touch") { touchStart.current = { x: event.clientX, y: event.clientY, moved: false }; return; }
        const index = indexAt(event.clientX, event.currentTarget);
        onSelect?.();
        if (index >= 0) owner.toggle(String(index), event.currentTarget);
      } : undefined}
      onPointerUp={enabled ? event => {
        if (event.pointerType !== "touch") return;
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
        const index = indexAt(event.clientX, event.currentTarget);
        onSelect?.();
        if (index >= 0) owner.toggle(String(index), event.currentTarget);
      } : undefined}
      onPointerCancel={enabled ? () => { touchStart.current = null; } : undefined}
      onPointerLeave={enabled ? event => owner.leave(event.currentTarget, "pointer") : undefined}
      onFocus={enabled ? event => {
        // Focus returned by a dismissal must neither reopen nor reselect the history.
        if (isRestoringTooltipFocus()) { owner.holdFocus(event.currentTarget); return; }
        // An open preview or pin keeps its sample; focus previews the latest one only when nothing is open.
        if (owner.active) owner.holdFocus(event.currentTarget);
        else owner.engage(String(observations.length - 1), event.currentTarget, "focus");
        onSelect?.();
      } : undefined}
      onBlur={enabled ? event => owner.leave(event.currentTarget, "focus") : undefined}
      onKeyDown={enabled ? event => {
        const index = current?.index ?? observations.length - 1;
        if (event.key === "Escape") { event.preventDefault(); owner.dismiss(); }
        else if (["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (event.key === "Enter" || event.key === " ") {
            onSelect?.();
            // A second Enter releases the pin and keeps the sample previewed, as a pointer click does not.
            if (current?.pinned && current.index === index) owner.unpin();
            else owner.toggle(String(index), event.currentTarget);
          }
          else {
            const next = event.key === "Home" ? 0 : event.key === "End" ? observations.length - 1 : Math.max(0, Math.min(observations.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
            // Keyboard movement keeps a pin on the sample it reaches, and otherwise previews it.
            if (current?.pinned) owner.pin(String(next), event.currentTarget);
            else owner.engage(String(next), event.currentTarget, "focus");
          }
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
      {events && observations.length > 0 && <EventTicks events={eventsInRange(events, observations[0].timestamp, observations[observations.length - 1].timestamp)} x={(timestamp) => history.x({ timestamp, value: null })} top={0} bottom={64} />}
      {selected && <g data-stat-cursor="" aria-hidden="true">
        <line x1={history.x(selected)} x2={history.x(selected)} y1="0" y2="64" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        {/* A ring at the sample: a currentColor band around a core in the card colour, both at fixed screen size. */}
        {selected.value !== null && <>
          <path d={`M${history.x(selected)},${history.y(selected)}h0`} stroke="currentColor" strokeWidth="9" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-stat-ring="" />
          <path d={`M${history.x(selected)},${history.y(selected)}h0`} strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--gamma-bg, #ffffff)" }} data-stat-ring-core="" />
        </>}
      </g>}
    </svg>
    {selected && current && anchor && <ObservationTooltip id={tooltipId} anchor={anchor} anchorRect={sampleRect} preferSide anchorOwnsHistoryKeys pinned={current.pinned} onDismiss={() => owner.dismiss()} onEnter={() => owner.panelEnter()} onLeave={() => owner.panelLeave()}>
      <MetricDetails widget={widget} series={series} index={0} point={selected} unit={unit} description="Recorded sample" />
    </ObservationTooltip>}
    </>
  );
}

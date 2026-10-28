"use client";

import { useId, useMemo } from "react";
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
}: {
  series: Series;
  name: string;
  unit: string;
  color?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const gradientId = useId();
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
        : 4 + ((point.timestamp - start) / (end - start)) * 232;
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
    `Displayed latest valid sample: ${exactMetric(history.latestValid.value!, unit)} at ${new Date(history.latestValid.timestamp).toISOString()}.`,
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
    <svg
      className={styles.plot}
      viewBox="0 0 240 64"
      preserveAspectRatio="none"
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
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
      <title id={titleId}>History for {name}</title>
      <desc id={descriptionId}>{summary}</desc>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.13" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.015" />
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
    </svg>
  );
}

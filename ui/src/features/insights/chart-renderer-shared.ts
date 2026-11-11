// Shared by the time-series and bar renderers and by chart-renderers.tsx. It is a separate module so that
// neither renderer imports the other.
import { useLayoutEffect, useRef, useState } from "react";
import { portal } from "@tanstack/charts/tooltip/portal";
import { widgetTextColor } from "./appearance";
import { autoAxisDomain, axisScale } from "./units";
import { inheritGammaTheme } from "./gamma/inherit-theme";
import type { QueryResult, Threshold, WidgetOptions } from "./schema";
import { validTimestamp } from "./widget-context";

export type Series = NonNullable<QueryResult["series"]>[number];
export type Point = Series["points"][number];

export const PALETTE = [
  "var(--gamma-chart-1, #c46146)",
  "var(--gamma-chart-2, #6e947a)",
  "var(--gamma-chart-3, #6a8a9c)",
  "var(--gamma-chart-4, #b29658)",
  "var(--gamma-chart-5, #9c82a1)",
  "var(--gamma-chart-6, #7d9690)",
  "var(--gamma-chart-7, #ac805f)",
  "var(--gamma-chart-8, #969f5c)",
];
export const MAX_SERIES = 12;

export const themedPortal: typeof portal = {
  ...portal,
  id: "paprika-themed-portal",
  create(context, options) {
    const stopTheme = inheritGammaTheme(context.container, context.element);
    const instance = portal.create(context, options);
    return { ...instance, destroy() { stopTheme(); instance.destroy(); } };
  },
};

const chartTheme = {
  foreground: "var(--gamma-ink, #223139)",
  muted: "var(--gamma-chart-axis, var(--gamma-muted, #52636f))",
  grid: "var(--gamma-chart-grid, var(--gamma-border, #d9e2e5))",
  background: "transparent",
  palette: PALETTE,
};

export const EMPTY_OPTIONS: WidgetOptions = Object.freeze({});

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

export function resolveChartDomain(
  series: Series[],
  options: WidgetOptions,
): [number, number] | undefined {
  if (options.min === undefined && options.max === undefined) return undefined;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const entry of series)
    for (const point of entry.points)
      if (
        validTimestamp(point.timestamp) &&
        typeof point.value === "number" &&
        Number.isFinite(point.value)
      ) {
        minimum = Math.min(minimum, point.value);
        maximum = Math.max(maximum, point.value);
      }
  let min = options.min ?? (Number.isFinite(minimum) ? minimum : 0);
  let max = options.max ?? (Number.isFinite(maximum) ? maximum : 1);
  if (min >= max) {
    if (options.min !== undefined) max = min + Math.max(1, Math.abs(min) * 0.1);
    else min = max - Math.max(1, Math.abs(max) * 0.1);
  }
  return [min, max];
}

export function configuredTheme(options: WidgetOptions) {
  const textColor = widgetTextColor(options);
  return {
    ...chartTheme,
    ...(textColor ? { foreground: textColor, muted: textColor } : {}),
  };
}

export function usePlotSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 500, height: 180 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const width = Math.round(bounds.width);
      const height = Math.max(48, Math.round(bounds.height));
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);
  return { ref, ...size };
}

export function responsiveChartTicks(width: number, height: number) {
  return {
    x: Math.max(2, Math.min(6, Math.floor((width - 60) / 80))),
    y: height < 130 ? 2 : height < 190 ? 3 : 4,
  };
}

/**
 * Whether a unit is captioned above the plot rather than repeated in the tick labels. `auto` captions units longer than
 * three characters; `caption` and `ticks` override that. A chart with no unit has no caption.
 */
export function axisUnitIsCaption(unit: string, mode: WidgetOptions["axisUnit"] = "auto"): boolean {
  if (!unit) return false;
  return mode === "caption" || (mode !== "ticks" && unit.length > 3);
}

/**
 * Reserve enough space for the formatted value-axis labels, and resolve the one unit and precision they share.
 * `domain` is the axis domain the chart actually draws; without it the values set the domain as the chart does.
 * Longer units go above the plot so they don't repeat on every tick.
 */
export function chartYAxisLayout(values: number[], unit: string, decimals?: number, axisLabel?: string, axisUnit?: WidgetOptions["axisUnit"], domain?: readonly [number, number], count = 4) {
  const axis = domain ?? autoAxisDomain(values, count, true);
  // The caller passes the domain the chart draws, already rounded once: the scale must not round it again.
  const scale = axisScale(axis, unit, { decimals, count, compact: true, fixedDomain: true });
  const separateUnit = axisUnitIsCaption(scale.unit, axisUnit);
  const labels = [...scale.ticks, axis[0], axis[1]].map(value => scale.label(value, !separateUnit));
  const width = Math.max(...labels.map(label => label.length)) * 7 + 12;
  return { separateUnit, scale, left: Math.max(54, width) + (axisLabel ? 20 : 0) };
}

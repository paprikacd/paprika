import { thresholdForValue } from "../chart-renderers";
import type { Point, Series } from "../chart-data";
import type { Threshold } from "../schema";
import { validTimestamp } from "../widget-context";

export const UTC_DAY = 86_400_000;
export type ObservationDay = { day: number; kind: "observed" | "mixed" | "unknown"; color?: string; label?: string; latest?: Point; count: number; missing: number };

/** Classify recorded samples by UTC day. No coverage, percentage or duration is inferred. */
export function uptimeObservations(series: readonly Series[], thresholds: readonly Threshold[], maxDays: number, maxSeries: number) {
  const selected = series.slice(0, maxSeries);
  const times = selected.flatMap(entry => entry.points.filter(point => validTimestamp(point.timestamp)).map(point => point.timestamp));
  if (!times.length) return { rows: [], truncatedDays: false, truncatedSeries: series.length > maxSeries };
  const lastDay = Math.floor(times.reduce((a, b) => Math.max(a, b), -Infinity) / UTC_DAY), firstDay = Math.floor(times.reduce((a, b) => Math.min(a, b), Infinity) / UTC_DAY);
  const start = Math.max(firstDay, lastDay - maxDays + 1);
  const days = Array.from({ length: lastDay - start + 1 }, (_, index) => start + index);
  return {
    truncatedDays: start > firstDay, truncatedSeries: series.length > maxSeries,
    rows: selected.map(entry => {
      const groups = new Map<number, Point[]>();
      for (const point of entry.points) {
        if (!validTimestamp(point.timestamp)) continue;
        const day = Math.floor(point.timestamp / UTC_DAY);
        if (day < start || day > lastDay) continue;
        const group = groups.get(day) ?? []; group.push(point); groups.set(day, group);
      }
      return { entry, days: days.map(day => {
        const points = groups.get(day) ?? [];
        const finite = points.filter(point => typeof point.value === "number" && Number.isFinite(point.value));
        const missing = points.length - finite.length;
        const latest = points.reduce<Point | undefined>((a, b) => !a || b.timestamp >= a.timestamp ? b : a, undefined);
        const states = new Set(finite.map(point => thresholds.length ? thresholds.indexOf(thresholdForValue(point.value!, thresholds)!) : 0));
        const kind: ObservationDay["kind"] = !finite.length ? "unknown" : missing || states.size > 1 ? "mixed" : "observed";
        const threshold = kind === "observed" ? thresholdForValue(finite[0].value!, thresholds) : undefined;
        return { day, kind, color: threshold?.color, label: threshold?.label, latest, count: points.length, missing };
      }) };
    }),
  };
}

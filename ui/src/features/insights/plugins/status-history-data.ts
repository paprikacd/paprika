import { downsamplePoints, type Series } from "../chart-data";
import type { Threshold } from "../schema";
import { validTimestamp } from "../widget-context";

/** The earliest/later retained points bound the visual interval; inspect the
 * original observations before deciding whether a single color is truthful. */
export function statusHistoryLayout(series: readonly Series[], maxPoints: number, thresholds: readonly Threshold[] = []) {
  const rows = series.map(entry => {
    const ordered = entry.points.filter(point => validTimestamp(point.timestamp)).map(point => ({
      ...point, value: typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null,
    })).toSorted((a, b) => a.timestamp - b.timestamp);
    return { entry, ordered, points: downsamplePoints(ordered, maxPoints) };
  });
  const allTimes = rows.flatMap(row => row.ordered.map(point => point.timestamp));
  if (!allTimes.length) return { rows: [], sampled: false, duplicateTimes: false, domain: undefined };
  const start = allTimes.reduce((minimum, time) => Math.min(minimum, time), Infinity);
  const end = allTimes.reduce((maximum, time) => Math.max(maximum, time), -Infinity), span = end - start;
  let duplicateTimes = false;
  const stateOf = (value: number | null) => {
    if (value === null) return -1;
    if (!thresholds.length) return 0;
    let match = 0;
    for (let index = 1; index < thresholds.length; index++) {
      if (thresholds[index].value > value) break;
      match = index;
    }
    return match;
  };
  return {
    rows: rows.map(row => {
      const gaps: number[] = [];
      for (let index = 1; index < row.ordered.length; index++) {
        const gap = row.ordered[index].timestamp - row.ordered[index - 1].timestamp;
        if (gap > 0) gaps.push(gap); else duplicateTimes = true;
      }
      gaps.sort((a, b) => a - b);
      // One interval cannot establish a cadence. Show isolated samples as
      // individual marks, not as an assumed duration.
      const cadence = gaps.length >= 2 ? gaps[Math.floor((gaps.length - 1) / 2)] : 0;
      const cells = row.points.map((point, index) => {
        if (!span || !cadence) return { point, left: span ? (point.timestamp - start) / span * 100 : 50, width: 2 };
        const previous = index ? point.timestamp - row.points[index - 1].timestamp : cadence;
        const next = index + 1 < row.points.length ? row.points[index + 1].timestamp - point.timestamp : cadence;
        const cellSpan = Math.min(cadence, previous > 0 ? previous : cadence, next > 0 ? next : cadence);
        return { point, left: (point.timestamp - start) / span * 100, width: cellSpan / span * 100 };
      });
      const lowerBound = (timestamp: number) => {
        let low = 0, high = row.ordered.length;
        while (low < high) { const middle = (low + high) >>> 1; if (row.ordered[middle].timestamp < timestamp) low = middle + 1; else high = middle; }
        return low;
      };
      const bridges = row.points.slice(1).flatMap((point, index) => {
        const prior = row.points[index], from = prior.timestamp, to = point.timestamp;
        if (!span || to <= from) return [];
        let position = lowerBound(from), previousTime: number | undefined, hasGap = !cadence, duplicate = false;
        let hasMissing = false, firstState: number | undefined, hasChange = false;
        while (position < row.ordered.length && row.ordered[position].timestamp <= to) {
          const sample = row.ordered[position++], state = stateOf(sample.value);
          if (sample.value === null) hasMissing = true;
          else if (firstState === undefined) firstState = state;
          else if (firstState !== state) hasChange = true;
          if (previousTime !== undefined) {
            const gap = sample.timestamp - previousTime;
            if (gap === 0) duplicate = true;
            else if (cadence && gap > cadence * 1.5) hasGap = true;
          }
          previousTime = sample.timestamp;
        }
        return [{
          left: (from - start) / span * 100, width: (to - from) / span * 100,
          kind: hasMissing || hasChange || duplicate ? "mixed" as const : hasGap ? "gap" as const : "stable" as const,
          hasMissing, hasChange, value: prior.value, from, to,
        }];
      });
      return { ...row, cells, bridges };
    }),
    sampled: rows.some(row => row.points.length < row.ordered.length), duplicateTimes, domain: { start, end },
  };
}

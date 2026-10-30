/** Keep the sampled time cells legible at narrow widths without exceeding the
 * authored ceiling. At extremely small sizes the schema's minimum of eight
 * columns takes precedence; shrinking a widget must never change its query. */
export function heatmapColumnLimit(plotWidth: number, maximum = 60): number {
  return Math.max(8, Math.min(maximum, Math.floor(Math.max(0, plotWidth) / 6)));
}

export interface HeatmapColumn { center: number; left: number; width: number }

/** Zero has its own color; positive values are mapped between the observed
 * positive minimum and maximum without altering the underlying bucket data. */
export function heatmapDensityLevel(value: number, max: number, minPositive: number | null, steps: number, scale: "linear" | "logarithmic"): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0 || steps < 2) return 0;
  if (scale === "linear") return Math.min(steps - 1, Math.max(0, Math.floor(value / max * (steps - 1))));
  if (minPositive === null || minPositive <= 0 || !Number.isFinite(minPositive)) return 0;
  const low = Math.log(minPositive), high = Math.log(max);
  if (high <= low) return steps - 1;
  const fraction = Math.max(0, Math.min(1, (Math.log(value) - low) / (high - low)));
  return 1 + Math.floor(fraction * (steps - 2));
}

/** Adjacent representative samples share the available timeline, but known
 * breaks in source cadence remain blank. The visible cell always identifies
 * its recorded timestamp; it is not an interpolated value. */
export function heatmapColumns(timestamps: readonly number[], left: number, width: number, gaps: readonly { left: number; right: number }[] = []): HeatmapColumn[] {
  if (!timestamps.length) return [];
  const nominal = width / timestamps.length;
  const start = timestamps[0], span = timestamps[timestamps.length - 1] - start;
  const centers = timestamps.map(timestamp => left + nominal / 2 + (span ? (timestamp - start) / span : .5) * Math.max(0, width - nominal));
  return centers.map((center, index) => {
    let start = index ? (centers[index - 1] + center) / 2 : left;
    let end = index + 1 < centers.length ? (center + centers[index + 1]) / 2 : left + width;
    for (const gap of gaps) {
      if (gap.right <= center) start = Math.max(start, gap.right);
      if (gap.left >= center) end = Math.min(end, gap.left);
    }
    // A half-pixel inset on each side creates the fine grid without large,
    // irregular gutters from sampling. Very narrow columns remain visible.
    const inset = Math.min(.5, Math.max(0, (end - start - .1) / 2));
    return { center, left: start + inset, width: Math.max(.1, end - start - inset * 2) };
  });
}

/** A long break in the raw source cadence is not made continuous by downsampling. */
export function heatmapGaps(timestamps: readonly number[], left: number, width: number, visibleColumns: number): { left: number; right: number }[] {
  if (timestamps.length < 3 || !visibleColumns) return [];
  const gaps = timestamps.slice(1).map((time, index) => time - timestamps[index]).filter(gap => gap > 0).sort((a, b) => a - b);
  if (gaps.length < 2) return [];
  const cadence = gaps[Math.floor((gaps.length - 1) / 2)], span = timestamps[timestamps.length - 1] - timestamps[0];
  if (!cadence || !span) return [];
  const nominal = width / visibleColumns, scale = Math.max(0, width - nominal) / span;
  const position = (time: number) => left + nominal / 2 + (time - timestamps[0]) * scale;
  return timestamps.slice(1).flatMap((time, index) => time - timestamps[index] > cadence * 1.5 ? [{
    left: position(timestamps[index] + cadence / 2), right: position(time - cadence / 2),
  }] : []);
}

/** Snap across sampled gutters but never across an unobserved source interval. */
export function heatmapColumnAt(columns: readonly HeatmapColumn[], x: number, gaps: readonly { left: number; right: number }[] = []): number | undefined {
  if (!columns.length || x < columns[0].left - .5 || x > columns[columns.length - 1].left + columns[columns.length - 1].width + .5 || gaps.some(gap => x > gap.left && x < gap.right)) return undefined;
  return columns.reduce((nearest, column, index) => Math.abs(column.center - x) < Math.abs(columns[nearest].center - x) ? index : nearest, 0);
}

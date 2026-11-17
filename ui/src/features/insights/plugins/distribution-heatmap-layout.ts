/** Keep the sampled time cells legible at narrow widths without exceeding the
 * authored ceiling. At extremely small sizes the schema's minimum of eight
 * columns takes precedence; shrinking a widget must never change its query. */
export function heatmapColumnLimit(plotWidth: number, maximum = 60): number {
  return Math.max(8, Math.min(maximum, Math.floor(Math.max(0, plotWidth) / 6)));
}

export interface HeatmapColumn { center: number; left: number; width: number }

/** Zero is not a density step: it returns null, so the caller draws observed zero as the empty fill.
 * Positive values map to steps 0..steps-1 against the maximum, linearly or, when logarithmic, between
 * the smallest positive value (step 0) and the maximum. A single positive value takes the top step. */
export function heatmapDensityLevel(value: number, max: number, minPositive: number | null, steps: number, scale: "linear" | "logarithmic"): number | null {
  if (!Number.isFinite(value) || value <= 0 || steps < 2) return null;
  const logarithmic = scale === "logarithmic" && minPositive !== null && minPositive > 0 && Number.isFinite(minPositive) && max > 0 && Number.isFinite(max);
  let unit = max > 0 && Number.isFinite(max) ? value / max : 1;
  if (logarithmic) {
    const low = Math.log(minPositive), high = Math.log(max);
    unit = high <= low ? 1 : (Math.log(value) - low) / (high - low);
  }
  return Math.min(steps - 1, Math.max(0, Math.round(Math.min(1, Math.max(0, unit)) * (steps - 1))));
}

export interface QuantileLineInput {
  columns: readonly HeatmapColumn[];
  /** The p95 bucket of each column, or null when the column has no drawable p95. */
  buckets: readonly (number | null)[];
  /** True where the line must not join the previous column. */
  breaks: readonly boolean[];
  /** Displayed rows. A bucket at or above this index is hidden, so it cannot be drawn. */
  rows: number;
  rowCentre: (row: number) => number;
  gaps: readonly { left: number; right: number }[];
}

/** The step line for the p95 bucket. `d` joins every run of drawable columns with one path; `above`
 * lists the centres of columns whose p95 bucket is hidden above the displayed rows. */
export function quantileLine({ columns, buckets, breaks, rows, rowCentre, gaps }: QuantileLineInput): { d: string; above: number[] } {
  const runs: number[][] = [], above: number[] = [];
  let run: number[] = [];
  columns.forEach((column, index) => {
    const bucket = buckets[index];
    if (bucket === null || bucket >= rows) {
      if (bucket !== null) above.push(column.center);
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    // A column joins the run only if it is the next column, no window in between is unsampled and not
    // ok, and no source gap lies between their centres. Each of those breaks the line rather than bridging.
    if (run.length && (breaks[index] || gaps.some(gap => gap.right > columns[index - 1].center && gap.left < column.center))) {
      runs.push(run);
      run = [];
    }
    run.push(index);
  });
  if (run.length) runs.push(run);
  const round = (value: number) => Number(value.toFixed(2));
  const d = runs.map(members => {
    const points: string[] = [];
    members.forEach((index, position) => {
      const column = columns[index], y = rowCentre(buckets[index]!);
      if (position) {
        // The vertical join sits midway in the gutter between the two columns.
        const previous = columns[index - 1], join = round((previous.left + previous.width + column.left) / 2);
        points.push(`${join},${round(rowCentre(buckets[index - 1]!))}`, `${join},${round(y)}`);
      }
      points.push(`${round(column.left)},${round(y)}`, `${round(column.left + column.width)},${round(y)}`);
    });
    return `M${points.join("L")}`;
  }).join("");
  return { d, above };
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

import { z } from "zod";
import type { QueryResult } from "../schema";
import { seriesName } from "../chart-data";
import { validTimestamp } from "../widget-context";
import { seriesColorRulesSchema } from "../series-colors";
import { bucketQuantile, type QuantileEstimate } from "./distribution-quantile";

export type MetricSeries = NonNullable<QueryResult["series"]>[number];
const label = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100);
const plotBounds = {
  seriesColors: seriesColorRulesSchema.optional(),
  maxSeries: z.number().int().min(1).max(12).optional(),
  maxPoints: z.number().int().min(12).max(240).optional(),
  legendDisplay: z.enum(["compact", "table"]).optional(),
  legendPosition: z.enum(["bottom", "right"]).optional(),
};
export const distributionConfigSchema = z.strictObject({
  bucketLabel: label.optional(),
  bucketUnit: z.string().max(24).optional(),
  densityUnit: z.string().max(40).optional(),
  group: z.record(label, z.string().max(256)).refine(value => Object.keys(value).length <= 8, "Choose at most eight histogram labels").optional(),
  aggregation: z.enum(["none", "sum"]).optional(),
  colorScale: z.enum(["linear", "logarithmic"]).optional(),
  maxBuckets: z.number().int().min(1).max(48).optional(),
  maxColumns: z.number().int().min(8).max(120).optional(),
});
export const metricAnnotationSchema = z.strictObject({
  timestamp: z.iso.datetime({ offset: true }),
  label: z.string().trim().min(1).max(100),
  severity: z.enum(["info", "warning", "critical"]).optional(),
});
export const stackedConfigSchema = z.strictObject({ display: z.enum(["area", "bar"]).optional(), annotations: z.array(metricAnnotationSchema).max(20).optional(), ...plotBounds });
export const directionalConfigSchema = z.strictObject({
  directionLabel: label.optional(),
  outboundValue: z.string().min(1).max(100).optional(),
  symmetricAxis: z.boolean().optional(),
  ...plotBounds,
});
export type DistributionConfig = z.infer<typeof distributionConfigSchema>;
export type StackedConfig = z.infer<typeof stackedConfigSchema>;
export type DirectionalConfig = z.infer<typeof directionalConfigSchema>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** Expected semantic data errors can be shown without hiding renderer bugs. */
export class MetricDataError extends Error {}

/** Duplicate timestamps are ambiguous; silently choosing or summing one would invent an aggregation. */
function observations(series: MetricSeries) {
  const points = new Map<number, number | null>();
  for (const point of series.points) {
    if (!validTimestamp(point.timestamp)) continue;
    if (points.has(point.timestamp)) throw new MetricDataError("Duplicate observation timestamps. Aggregate the query before charting.");
    points.set(point.timestamp, finite(point.value) ? point.value : null);
  }
  return points;
}

/**
 * Keep recorded timestamps only, one per output bucket. Inside a bucket the priority is: the first
 * missing column (so sampling never bridges a known gap), then a `peak` column, then the largest
 * magnitude. Without a `peak` predicate this is the magnitude rule alone.
 */
export function sampleTimeIndices(length: number, limit: number, missing: (index: number) => boolean, magnitude: (index: number) => number, peak: (index: number) => boolean = () => false) {
  if (length <= limit) return Array.from({ length }, (_, i) => i);
  const indices = [0];
  for (let bucket = 0; bucket < limit - 2; bucket++) {
    const start = 1 + Math.floor(bucket * (length - 2) / (limit - 2));
    const end = 1 + Math.floor((bucket + 1) * (length - 2) / (limit - 2));
    let selected = start, selectedPeak = peak(start);
    for (let index = start; index < end; index++) {
      if (missing(index)) { selected = index; break; }
      const isPeak = peak(index);
      if (isPeak !== selectedPeak ? isPeak : magnitude(index) > magnitude(selected)) { selected = index; selectedPeak = isPeak; }
    }
    indices.push(selected);
  }
  indices.push(length - 1);
  return indices;
}

export interface MetricCell {
  timestamp: number;
  /** The raw observation; directional display never changes it. */
  value: number | null;
  lower: number | null;
  upper: number | null;
  /** A complete stack could not be represented as a finite number. */
  overflow?: boolean;
}
export interface MetricTrack {
  series: MetricSeries;
  name: string;
  index: number;
  cells: MetricCell[];
  statistics: MetricStatistics;
  /** The last finite observation in the unzoomed history, or null if the track never reported. Ended tracks name it. */
  lastFinite: number | null;
}
export interface MetricStatistics {
  current: number | null;
  currentTimestamp: number | null;
  mean: number | null;
  max: number | null;
  finiteSamples: number;
  totalSamples: number;
}

/** Statistics describe raw returned observations, before alignment, stacking or display sampling. */
function metricStatistics(points: Map<number, number | null>): MetricStatistics {
  let current: number | null = null, currentTimestamp: number | null = null;
  let max: number | null = null, finiteSamples = 0;
  // Float64 values are integer multiples of 2^-1074. Accumulating those
  // integers exactly prevents both overflow and loss of small observations
  // when large values later cancel. The accumulator is bounded by the
  // float64 exponent range plus the bits needed for the observation count.
  let sum = 0n;
  const view = new DataView(new ArrayBuffer(8));
  for (const [timestamp, value] of points) {
    if (currentTimestamp === null || timestamp > currentTimestamp) { currentTimestamp = timestamp; current = value; }
    if (value === null) continue;
    finiteSamples++;
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
    const term = mantissa << BigInt(Math.max(0, exponent - 1));
    sum += bits >> 63n ? -term : term;
    max = max === null ? value : Math.max(max, value);
  }
  let mean: number | null = null;
  if (finiteSamples) {
    const negative = sum < 0n;
    const magnitude = negative ? -sum : sum;
    const count = BigInt(finiteSamples);
    // Divide at a precision that retains at most 53 significant bits. Round
    // the integer quotient to nearest, ties to even before binary scaling.
    const difference = magnitude.toString(2).length - count.toString(2).length;
    const quotientBits = difference < 0 ? 0 : difference + (magnitude >= (count << BigInt(difference)) ? 1 : 0);
    const shift = Math.max(0, quotientBits - 53);
    const divisor = count << BigInt(shift);
    let rounded = magnitude / divisor;
    const remainder = magnitude % divisor;
    if (2n * remainder > divisor || (2n * remainder === divisor && (rounded & 1n) === 1n)) rounded++;
    mean = Number(rounded) * 2 ** (shift - 1074);
    if (negative) mean = -mean;
  }
  return { current, currentTimestamp, mean, max, finiteSamples, totalSamples: points.size };
}
/** A track's stacked bounds in an incomplete column. The running sums are the complete stack's, over the reporting tracks only. */
export interface MetricPartial {
  index: number;
  lower: number;
  upper: number;
}
/** One time column, aligned with the sampled timestamps. Track indices are listed in track order. */
export interface MetricColumn {
  timestamp: number;
  /** The sum of the reporting tracks, when no track is missing, at least one reports and the sum is finite. Null otherwise. */
  total: number | null;
  /** Tracks with a finite value before and after this time but none here: a gap inside their lifetime. Bar mode hatches each one. */
  missing: number[];
  /** Tracks whose first finite observation is later than this time. Bar mode draws nothing for them. */
  notStarted: number[];
  /** Tracks whose last finite observation is earlier than this time. Bar mode draws nothing for them and does not count them as missing. */
  ended: number[];
  /** Bounds of the reporting tracks in an incomplete column. Empty for complete and overflowed columns and for directional traffic. Only bar mode draws them. */
  partial: MetricPartial[];
  /** Set when the stack exceeds the finite range, so the column is not drawn. Area mode flags only complete overflows. */
  overflow?: boolean;
}
/** The stack total at one unsampled timestamp. Null where a track is missing, no track reports, or the stack overflows. */
export interface MetricTotal {
  timestamp: number;
  value: number | null;
}
export interface MetricPlotData {
  tracks: MetricTrack[];
  timestamps: number[];
  /** Aligned with `timestamps`. */
  columns: MetricColumn[];
  /** Every unsampled timestamp, so the stack-total trend keeps its gaps when display sampling drops columns. */
  totals: MetricTotal[];
  domain: [number, number];
  sampled: boolean;
  omittedSeries: number;
  invalidValues: number;
  overflowColumns: number;
}

/**
 * `history` is the unzoomed series for the same tracks, in the same order. A zoomed window passes it so a track that
 * reported before the window counts as missing inside it, not as not started. Without it, `series` is the history.
 */
export function buildMetricPlot(series: MetricSeries[], config: StackedConfig | DirectionalConfig, directional = false, history = series): MetricPlotData {
  const selected = series.slice(0, config.maxSeries ?? 8);
  const maps = selected.map(observations);
  const timestamps = [...new Set(maps.flatMap(map => [...map.keys()]))].sort((a, b) => a - b);
  const bars = !directional && "display" in config && config.display === "bar";
  // A track's lifetime comes from its finite observations in the unzoomed history. It has not started before its first,
  // has ended after its last, and a missing value between them is a gap. A track that never reported never starts.
  const firstFinite = history.slice(0, config.maxSeries ?? 8).map(entry => entry.points.reduce((first, point) => validTimestamp(point.timestamp) && finite(point.value) && point.timestamp < first ? point.timestamp : first, Infinity));
  const lastFinite = history.slice(0, config.maxSeries ?? 8).map(entry => entry.points.reduce((last, point) => validTimestamp(point.timestamp) && finite(point.value) && point.timestamp > last ? point.timestamp : last, -Infinity));
  let invalidValues = 0, overflowColumns = 0;
  const cells: MetricCell[][] = selected.map(() => []);
  const columns: MetricColumn[] = [], totals: MetricTotal[] = [];
  const direction = config as DirectionalConfig;
  for (const timestamp of timestamps) {
    const values = maps.map(map => map.get(timestamp) ?? null);
    const complete = values.every(finite);
    let positive = 0, negative = 0;
    let overflow = false;
    values.forEach((raw, index) => {
      let value = raw, lower: number | null = null, upper: number | null = null;
      if (directional) {
        if (value !== null && value < 0) { value = null; invalidValues++; }
        if (value !== null) {
          lower = 0;
          upper = selected[index].labels[direction.directionLabel ?? "direction"] === (direction.outboundValue ?? "outbound") ? -value : value;
        }
      } else if (complete && value !== null) {
        lower = value >= 0 ? positive : negative;
        upper = lower + value;
        if (!finite(upper)) overflow = true;
        if (value >= 0) positive = upper; else negative = upper;
      }
      cells[index].push({ timestamp, value, lower, upper });
    });
    if (overflow) {
      // The whole stack at this instant is incomplete; retaining the first
      // layer would falsely present a partial total as the full observation.
      for (const track of cells) Object.assign(track[track.length - 1], { lower: null, upper: null, overflow: true });
    }
    const column: MetricColumn = { timestamp, total: null, missing: [], notStarted: [], ended: [], partial: [] };
    if (!directional) {
      // The reporting tracks stack on the complete stack's running sums, so an incomplete column's partial stack
      // is never drawn with a different baseline.
      let reportingPositive = 0, reportingNegative = 0, reporting = 0, stackOverflow = false;
      for (const [index, value] of values.entries()) {
        if (!finite(value)) {
          if (timestamp < firstFinite[index]) column.notStarted.push(index);
          else if (timestamp > lastFinite[index]) column.ended.push(index);
          else column.missing.push(index);
          continue;
        }
        const lower = value >= 0 ? reportingPositive : reportingNegative, upper = lower + value;
        if (!finite(upper)) stackOverflow = true;
        if (value >= 0) reportingPositive = upper; else reportingNegative = upper;
        reporting++;
        if (!complete) column.partial.push({ index, lower, upper });
      }
      // Area mode omits a column only for a complete overflow, as it did before partial stacks existed.
      if (stackOverflow && (complete || bars)) {
        overflowColumns++;
        column.overflow = true;
      }
      if (stackOverflow) column.partial = [];
      else if (column.missing.length === 0 && reporting > 0) column.total = reportingPositive + reportingNegative;
    }
    columns.push(column);
    totals.push({ timestamp, value: column.total });
  }
  const incompleteAt = (index: number) => index >= 0 && index < timestamps.length && cells.some(track => track[index].upper === null);
  // Bar mode keeps only the first and last column of a run of incomplete columns as must-keep: those are where the
  // stack changes to partial bars and caps. Area mode keeps every gap as before.
  const indices = sampleTimeIndices(timestamps.length, config.maxPoints ?? 120,
    bars ? index => incompleteAt(index) && (!incompleteAt(index - 1) || !incompleteAt(index + 1)) : incompleteAt,
    // A bar column's magnitude is its largest bound, partial bounds included, so a partial spike survives sampling.
    index => Math.max(0, ...cells.map(track => Math.abs(track[index].upper ?? 0)), ...(bars ? columns[index].partial.flatMap(part => [Math.abs(part.lower), Math.abs(part.upper)]) : [])));
  // Bar mode scales to the columns it draws, so the axis never reflects a value that no bar shows. Area and
  // directional modes keep every returned column, as before. Only bar mode draws partial bounds.
  const scaled = bars ? indices : timestamps.map((_, index) => index);
  let low = 0, high = 0;
  for (const index of scaled) {
    for (const track of cells) {
      const cell = track[index];
      if (cell.upper === null || cell.lower === null) continue;
      low = Math.min(low, cell.lower, cell.upper);
      high = Math.max(high, cell.lower, cell.upper);
    }
    if (bars) for (const part of columns[index].partial) {
      low = Math.min(low, part.lower, part.upper);
      high = Math.max(high, part.lower, part.upper);
    }
  }
  if (low === high) { low = Math.min(0, low); high = Math.max(1, high); }
  if (directional && direction.symmetricAxis) {
    const extent = Math.max(Math.abs(low), Math.abs(high));
    low = -extent; high = extent;
  }
  return {
    tracks: selected.map((entry, index) => ({ series: entry, name: seriesName(entry, index), index, cells: indices.map(i => cells[index][i]), statistics: metricStatistics(maps[index]), lastFinite: Number.isFinite(lastFinite[index]) ? lastFinite[index] : null })),
    timestamps: indices.map(i => timestamps[i]), columns: indices.map(i => columns[i]), totals, domain: [low, high], sampled: indices.length < timestamps.length,
    omittedSeries: series.length - selected.length, invalidValues, overflowColumns,
  };
}

/** `missing`: a bucket or the bucket below it has no finite observation. `invalid`: negative or decreasing cumulative counts. */
export type DistributionCellState = "observed" | "missing" | "invalid";
export interface DistributionCell {
  timestamp: number;
  value: number | null;
  state: DistributionCellState;
}
export interface DistributionRow {
  lower: number;
  upper: number;
  labels: Record<string, string>;
  cells: DistributionCell[];
}
/**
 * `ok`: a complete window with at least one observation. `empty`: complete, with zero observations.
 * `missing` and `invalid`: some bucket in the window is a gap, and the window has a +Inf bucket.
 * `unbounded`: no +Inf bucket, so every window has no total and no p95, gaps or not (see `gap`).
 */
export type WindowState = "ok" | "empty" | "missing" | "invalid" | "unbounded";
export interface WindowQuantile {
  timestamp: number;
  state: WindowState;
  /** A missing or invalid bucket at this time, over every bucket. Reported even when the state is unbounded. */
  gap: "missing" | "invalid" | null;
  /** Sum over every bucket, including buckets above maxBuckets and +Inf. Null unless the window is ok or empty. */
  total: number | null;
  /** The p95 bucket, for ok windows only. A rank in +Inf has estimate null and overflow true. */
  p95: QuantileEstimate | null;
  /** Sampled columns only: an unsampled window between this column and the previous one is not ok, so the p95 line breaks here. */
  breakBefore: boolean;
}
export interface MergedQuantile {
  /** The p95 of per-bucket counts summed over the complete windows. Null without a +Inf bucket or without observations. */
  estimate: QuantileEstimate | null;
  /** False without a +Inf bucket (or with fewer than two buckets). */
  bounded: boolean;
  windows: number;
  /** Ok and empty windows: the complete windows pooled into the estimate. */
  used: number;
  missing: number;
  invalid: number;
  empty: number;
}
export interface DistributionData {
  rows: DistributionRow[];
  timestamps: number[];
  /** Aligned with `timestamps`. */
  quantiles: WindowQuantile[];
  merged: MergedQuantile;
  /** The window to quote: the first overflow window, otherwise the highest finite p95. Unsampled. */
  highest: { timestamp: number; p95: QuantileEstimate } | null;
  /** Every upper bound in ascending order, including buckets above maxBuckets and +Inf. */
  bounds: number[];
  max: number;
  minPositive: number | null;
  invalidCells: number;
  omittedBuckets: number;
  sampled: boolean;
  groups: number;
}

/** Input is cumulative bucket observations (normally query-side rates), not raw counter deltas over time. */
export function buildDistribution(series: MetricSeries[], config: DistributionConfig): DistributionData {
  const bucketLabel = config.bucketLabel ?? "le";
  const groups = new Map<string, { labels: Record<string, string>; buckets: Map<number, Map<number, number | null>> }>();
  for (const entry of series) {
    if (Object.entries(config.group ?? {}).some(([key, value]) => entry.labels[key] !== value)) continue;
    const raw = entry.labels[bucketLabel];
    const bound = raw === "+Inf" || raw === "Inf" ? Infinity : raw?.trim() ? Number(raw) : NaN;
    if (Number.isNaN(bound) || bound === -Infinity) throw new MetricDataError(`Every histogram series needs a numeric ${bucketLabel} label or +Inf.`);
    const labels = Object.fromEntries(Object.entries(entry.labels).filter(([key]) => key !== bucketLabel && key !== "__name__").sort(([a], [b]) => a.localeCompare(b)));
    const id = JSON.stringify(labels);
    let group = groups.get(id);
    if (!group) { group = { labels, buckets: new Map() }; groups.set(id, group); }
    const incoming = observations(entry);
    const existing = group.buckets.get(bound);
    if (existing) {
      // Prometheus can retain old and new textual spellings of a boundary
      // (such as 1 and 1.0) across a label migration. Join only disjoint
      // observations; overlapping buckets remain ambiguous and must not be
      // silently summed or discarded.
      if ([...incoming.keys()].some(timestamp => existing.has(timestamp)))
        throw new MetricDataError("Duplicate histogram bucket with overlapping observations. Filter or correct conflicting boundary labels before charting.");
      for (const [timestamp, value] of incoming) existing.set(timestamp, value);
    } else group.buckets.set(bound, incoming);
  }
  const histograms = [...groups.values()];
  if (histograms.length > 1 && config.aggregation !== "sum") throw new MetricDataError("Multiple histogram groups. Choose exact group labels or explicitly enable sum.");
  const bounds = [...(histograms[0]?.buckets.keys() ?? [])].sort((a, b) => a - b);
  const signature = bounds.join(",");
  if (histograms.some(group => [...group.buckets.keys()].sort((a, b) => a - b).join(",") !== signature))
    throw new MetricDataError("Histogram groups have different bucket boundaries and cannot be summed.");
  const allTimes = [...new Set(histograms.flatMap(group => [...group.buckets.values()].flatMap(map => [...map.keys()])))].sort((a, b) => a - b);
  const commonLabels = Object.fromEntries(Object.entries(histograms[0]?.labels ?? {}).filter(([key, value]) => histograms.every(group => group.labels[key] === value)));
  // Every bucket over every returned window, before truncation and sampling. A missing group makes the
  // cell missing even when another group is invalid. Invalid counts are reported per bucket.
  const bucketCells = bounds.map((upper, index) => allTimes.map((timestamp): { value: number | null; state: DistributionCellState } => {
    let sum = 0, missing = false, invalid = false;
    for (const group of histograms) {
      const high = group.buckets.get(upper)!.get(timestamp);
      const low = index ? group.buckets.get(bounds[index - 1])!.get(timestamp) : 0;
      if (!finite(high) || !finite(low)) { missing = true; break; }
      // Compare floating-point noise relative to the actual bucket scale.
      // An absolute floor would turn materially decreasing tiny rates into
      // a fabricated observed zero.
      const tolerance = Math.max(Math.abs(high), Math.abs(low)) * 1e-9;
      if (high < 0 || low < 0 || high < low - tolerance) { invalid = true; continue; }
      sum += Math.max(0, high - low);
    }
    if (missing) return { value: null, state: "missing" };
    if (invalid) return { value: null, state: "invalid" };
    return Number.isFinite(sum) ? { value: sum, state: "observed" } : { value: null, state: "missing" };
  }));
  // A p95 needs the +Inf bucket: without it the total is unknown, so no quantile is reported.
  const hasOverflow = bounds.length > 1 && bounds[bounds.length - 1] === Infinity;
  const windows: WindowQuantile[] = allTimes.map((timestamp, column) => {
    const cells = bucketCells.map(row => row[column]);
    const counts = cells.map(cell => cell.value ?? 0);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const gap = cells.some(cell => cell.state === "missing") ? "missing" : cells.some(cell => cell.state === "invalid") ? "invalid" : null;
    const state: WindowState = !hasOverflow ? "unbounded" : gap ?? (total > 0 ? "ok" : "empty");
    return { timestamp, state, gap, total: state === "ok" || state === "empty" ? total : null, p95: state === "ok" ? bucketQuantile(bounds, counts, .95) : null, breakBefore: false };
  });
  const complete = windows.flatMap((window, column) => window.state === "ok" || window.state === "empty" ? [column] : []);
  // Per-window values are bucket rates over the same rate window at every step, so summing them across
  // steps pools observations proportionally. Only bucket counts are pooled; percentiles are never averaged.
  const pooled = bounds.map((_, index) => complete.reduce((sum, column) => sum + (bucketCells[index][column].value ?? 0), 0));
  const count = (state: WindowState) => windows.filter(window => window.state === state).length;
  const merged: MergedQuantile = {
    estimate: hasOverflow && complete.length ? bucketQuantile(bounds, pooled, .95) : null,
    bounded: hasOverflow, windows: allTimes.length, used: complete.length,
    missing: windows.filter(window => window.gap === "missing").length, invalid: windows.filter(window => window.gap === "invalid").length, empty: count("empty"),
  };
  // The highest finite p95 is the peak column. Overflow windows are also peaks: the sampler keeps them
  // because their p95 is above every finite bound, which the magnitude rule would not see.
  let peakColumn = -1;
  windows.forEach((window, column) => {
    const estimate = window.p95?.estimate;
    if (estimate !== null && estimate !== undefined && (peakColumn < 0 || estimate > windows[peakColumn].p95!.estimate!)) peakColumn = column;
  });
  const overflowColumn = windows.findIndex(window => window.p95?.overflow === true);
  const highestColumn = overflowColumn >= 0 ? overflowColumn : peakColumn;
  const highest = highestColumn >= 0 ? { timestamp: allTimes[highestColumn], p95: windows[highestColumn].p95! } : null;
  const shown = bounds.slice(0, config.maxBuckets ?? 24);
  // A window with a missing or invalid bucket is a source gap. Empty windows are observed zeros, and
  // unbounded windows are all alike without a +Inf bucket, so neither takes sampling priority.
  const indices = sampleTimeIndices(allTimes.length, config.maxColumns ?? 60, column => windows[column].gap !== null,
    column => Math.max(0, ...shown.map((_, index) => bucketCells[index][column].value ?? 0)),
    column => windows[column].p95?.overflow === true || column === peakColumn);
  const rows: DistributionRow[] = shown.map((upper, index) => ({
    lower: index ? bounds[index - 1] : -Infinity, upper,
    labels: { ...commonLabels, [bucketLabel]: Number.isFinite(upper) ? String(upper) : "+Inf" },
    cells: allTimes.map((timestamp, column) => ({ timestamp, ...bucketCells[index][column] })),
  }));
  const invalidCells = rows.reduce((sum, row) => sum + row.cells.filter(cell => cell.state === "invalid").length, 0);
  const max = rows.reduce((maximum, row) => row.cells.reduce((value, cell) => Math.max(value, cell.value ?? 0), maximum), 0);
  const minPositive = rows.reduce<number | null>((minimum, row) => row.cells.reduce<number | null>((value, cell) => cell.value !== null && cell.value > 0 && (value === null || cell.value < value) ? cell.value : value, minimum), null);
  // prefix[k] counts the non-ok windows before column k. A sampled column breaks the line when an
  // unsampled window between it and the previous sampled column is not ok.
  const prefix = [0];
  windows.forEach(window => prefix.push(prefix[prefix.length - 1] + (window.state === "ok" ? 0 : 1)));
  const quantiles = indices.map((column, position) => ({ ...windows[column], breakBefore: position > 0 && prefix[column] - prefix[indices[position - 1] + 1] > 0 }));
  return {
    rows: rows.map(row => ({ ...row, cells: indices.map(i => row.cells[i]) })), timestamps: indices.map(i => allTimes[i]), quantiles, merged, highest, bounds, max, minPositive,
    invalidCells, omittedBuckets: bounds.length - rows.length, sampled: indices.length < allTimes.length, groups: histograms.length,
  };
}

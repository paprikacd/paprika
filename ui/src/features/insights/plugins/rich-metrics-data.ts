import { z } from "zod";
import type { QueryResult } from "../schema";
import { seriesName } from "../chart-data";
import { validTimestamp } from "../widget-context";
import { seriesColorRulesSchema } from "../series-colors";

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

/** Keep recorded timestamps only. Missing columns take priority over peaks so sampling cannot bridge a known gap. */
export function sampleTimeIndices(length: number, limit: number, missing: (index: number) => boolean, magnitude: (index: number) => number) {
  if (length <= limit) return Array.from({ length }, (_, i) => i);
  const indices = [0];
  for (let bucket = 0; bucket < limit - 2; bucket++) {
    const start = 1 + Math.floor(bucket * (length - 2) / (limit - 2));
    const end = 1 + Math.floor((bucket + 1) * (length - 2) / (limit - 2));
    let selected = start;
    for (let index = start; index < end; index++) {
      if (missing(index)) { selected = index; break; }
      if (magnitude(index) > magnitude(selected)) selected = index;
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
export interface MetricPlotData {
  tracks: MetricTrack[];
  timestamps: number[];
  domain: [number, number];
  sampled: boolean;
  omittedSeries: number;
  invalidValues: number;
  overflowColumns: number;
}

export function buildMetricPlot(series: MetricSeries[], config: StackedConfig | DirectionalConfig, directional = false): MetricPlotData {
  const selected = series.slice(0, config.maxSeries ?? 8);
  const maps = selected.map(observations);
  const timestamps = [...new Set(maps.flatMap(map => [...map.keys()]))].sort((a, b) => a - b);
  let invalidValues = 0, overflowColumns = 0;
  const cells: MetricCell[][] = selected.map(() => []);
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
      overflowColumns++;
      // The whole stack at this instant is incomplete; retaining the first
      // layer would falsely present a partial total as the full observation.
      for (const track of cells) Object.assign(track[track.length - 1], { lower: null, upper: null, overflow: true });
    }
  }
  const indices = sampleTimeIndices(timestamps.length, config.maxPoints ?? 120,
    index => cells.some(track => track[index].upper === null),
    index => Math.max(0, ...cells.map(track => Math.abs(track[index].upper ?? 0))));
  let low = 0, high = 0;
  for (const track of cells) for (const cell of track) {
    if (cell.upper === null || cell.lower === null) continue;
    low = Math.min(low, cell.lower, cell.upper);
    high = Math.max(high, cell.lower, cell.upper);
  }
  if (low === high) { low = Math.min(0, low); high = Math.max(1, high); }
  if (directional && direction.symmetricAxis) {
    const extent = Math.max(Math.abs(low), Math.abs(high));
    low = -extent; high = extent;
  }
  return {
    tracks: selected.map((entry, index) => ({ series: entry, name: seriesName(entry, index), index, cells: indices.map(i => cells[index][i]), statistics: metricStatistics(maps[index]) })),
    timestamps: indices.map(i => timestamps[i]), domain: [low, high], sampled: indices.length < timestamps.length,
    omittedSeries: series.length - selected.length, invalidValues, overflowColumns,
  };
}

export interface DistributionRow {
  lower: number;
  upper: number;
  labels: Record<string, string>;
  cells: { timestamp: number; value: number | null }[];
}
export interface DistributionData {
  rows: DistributionRow[];
  timestamps: number[];
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
  let invalidCells = 0;
  const rows = bounds.slice(0, config.maxBuckets ?? 24).map((upper, index) => ({
    lower: index ? bounds[index - 1] : -Infinity, upper,
    labels: { ...commonLabels, [bucketLabel]: Number.isFinite(upper) ? String(upper) : "+Inf" },
    cells: allTimes.map(timestamp => {
      let sum = 0, valid = true;
      for (const group of histograms) {
        const high = group.buckets.get(upper)!.get(timestamp);
        const low = index ? group.buckets.get(bounds[index - 1])!.get(timestamp) : 0;
        if (!finite(high) || !finite(low)) { valid = false; break; }
        // Compare floating-point noise relative to the actual bucket scale.
        // An absolute floor would turn materially decreasing tiny rates into
        // a fabricated observed zero.
        const tolerance = Math.max(Math.abs(high), Math.abs(low)) * 1e-9;
        if (high < 0 || low < 0 || high < low - tolerance) { invalidCells++; valid = false; break; }
        sum += Math.max(0, high - low);
      }
      return { timestamp, value: valid && Number.isFinite(sum) ? sum : null };
    }),
  }));
  const indices = sampleTimeIndices(allTimes.length, config.maxColumns ?? 60,
    i => rows.some(row => row.cells[i].value === null),
    i => Math.max(0, ...rows.map(row => row.cells[i].value ?? 0)));
  const max = rows.reduce((maximum, row) => row.cells.reduce((value, cell) => Math.max(value, cell.value ?? 0), maximum), 0);
  const minPositive = rows.reduce<number | null>((minimum, row) => row.cells.reduce<number | null>((value, cell) => cell.value !== null && cell.value > 0 && (value === null || cell.value < value) ? cell.value : value, minimum), null);
  return {
    rows: rows.map(row => ({ ...row, cells: indices.map(i => row.cells[i]) })), timestamps: indices.map(i => allTimes[i]), max, minPositive,
    invalidCells, omittedBuckets: bounds.length - rows.length, sampled: indices.length < allTimes.length, groups: histograms.length,
  };
}

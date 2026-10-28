import { z } from "zod";
import type { QueryResult } from "../schema";
import { seriesName } from "../chart-data";
import { validTimestamp } from "../widget-context";

export type MetricSeries = NonNullable<QueryResult["series"]>[number];
const label = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100);
const plotBounds = {
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
  maxBuckets: z.number().int().min(1).max(48).optional(),
  maxColumns: z.number().int().min(8).max(120).optional(),
});
export const stackedConfigSchema = z.strictObject({ display: z.enum(["area", "bar"]).optional(), ...plotBounds });
export const directionalConfigSchema = z.strictObject({
  directionLabel: label.optional(),
  outboundValue: z.string().min(1).max(100).optional(),
  ...plotBounds,
});
export type DistributionConfig = z.infer<typeof distributionConfigSchema>;
export type StackedConfig = z.infer<typeof stackedConfigSchema>;
export type DirectionalConfig = z.infer<typeof directionalConfigSchema>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Duplicate timestamps are ambiguous; silently choosing or summing one would invent an aggregation. */
function observations(series: MetricSeries) {
  const points = new Map<number, number | null>();
  for (const point of series.points) {
    if (!validTimestamp(point.timestamp)) continue;
    if (points.has(point.timestamp)) throw new Error("Duplicate observation timestamps. Aggregate the query before charting.");
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
  let mean: number | null = null, max: number | null = null, finiteSamples = 0;
  for (const [timestamp, value] of points) {
    if (currentTimestamp === null || timestamp > currentTimestamp) { currentTimestamp = timestamp; current = value; }
    if (value === null) continue;
    finiteSamples++;
    // Weighted terms avoid overflowing the sum for valid, very large observations.
    mean = mean === null ? value : mean * ((finiteSamples - 1) / finiteSamples) + value / finiteSamples;
    max = max === null ? value : Math.max(max, value);
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
}

export function buildMetricPlot(series: MetricSeries[], config: StackedConfig | DirectionalConfig, directional = false): MetricPlotData {
  const selected = series.slice(0, config.maxSeries ?? 8);
  const maps = selected.map(observations);
  const timestamps = [...new Set(maps.flatMap(map => [...map.keys()]))].sort((a, b) => a - b);
  let invalidValues = 0;
  const cells: MetricCell[][] = selected.map(() => []);
  const direction = config as DirectionalConfig;
  for (const timestamp of timestamps) {
    const values = maps.map(map => map.get(timestamp) ?? null);
    const complete = values.every(finite);
    let positive = 0, negative = 0;
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
        if (value >= 0) positive = upper; else negative = upper;
      }
      cells[index].push({ timestamp, value, lower, upper });
    });
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
  return {
    tracks: selected.map((entry, index) => ({ series: entry, name: seriesName(entry, index), index, cells: indices.map(i => cells[index][i]), statistics: metricStatistics(maps[index]) })),
    timestamps: indices.map(i => timestamps[i]), domain: [low, high], sampled: indices.length < timestamps.length,
    omittedSeries: series.length - selected.length, invalidValues,
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
    if (Number.isNaN(bound) || bound === -Infinity) throw new Error(`Every histogram series needs a numeric ${bucketLabel} label or +Inf.`);
    const labels = Object.fromEntries(Object.entries(entry.labels).filter(([key]) => key !== bucketLabel && key !== "__name__").sort(([a], [b]) => a.localeCompare(b)));
    const id = JSON.stringify(labels);
    let group = groups.get(id);
    if (!group) { group = { labels, buckets: new Map() }; groups.set(id, group); }
    if (group.buckets.has(bound)) throw new Error("Duplicate histogram bucket. Aggregate the query by histogram labels first.");
    group.buckets.set(bound, observations(entry));
  }
  const histograms = [...groups.values()];
  if (histograms.length > 1 && config.aggregation !== "sum") throw new Error("Multiple histogram groups. Choose exact group labels or explicitly enable sum.");
  const bounds = [...(histograms[0]?.buckets.keys() ?? [])].sort((a, b) => a - b);
  const signature = bounds.join(",");
  if (histograms.some(group => [...group.buckets.keys()].sort((a, b) => a - b).join(",") !== signature))
    throw new Error("Histogram groups have different bucket boundaries and cannot be summed.");
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
        const tolerance = Math.max(1, Math.abs(high), Math.abs(low)) * 1e-9;
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
  return {
    rows: rows.map(row => ({ ...row, cells: indices.map(i => row.cells[i]) })), timestamps: indices.map(i => allTimes[i]), max,
    invalidCells, omittedBuckets: bounds.length - rows.length, sampled: indices.length < allTimes.length, groups: histograms.length,
  };
}

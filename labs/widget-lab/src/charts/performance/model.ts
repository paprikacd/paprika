import { z } from 'zod';
import type { RecordFrame } from '../../vendor/paprika/ui/src/features/insights/schema';
import { parseRecordFrame } from '../../vendor/paprika/ui/src/features/insights/record-data';
import { buildTraceSpans, type TraceSpan } from '../incident/incident-model';
import { validateProfile, type Profile, type ProfileFrame } from '../profiling/profile-model';

const field = (name: string) => z.string().trim().min(1).max(80).default(name);
const selection = z.string().max(160).default('');
export const performanceDensityConfig = z.strictObject({ latencyField: field('latency'), timeField: field('timestamp'), bins: z.number().int().min(12).max(36).default(24), timeBuckets: z.number().int().min(8).max(36).default(24), showQuantiles: z.boolean().default(true), build: z.enum(['before', 'after']).default('after') });
export const performanceTraceConfig = z.strictObject({ selectedSpan: selection, showService: z.boolean().default(true), rowHeight: z.number().int().min(24).max(40).default(27) });
export const differentialProfileConfig = z.strictObject({ selectedId: selection, widthBy: z.enum(['before', 'after']).default('after'), rowHeight: z.number().int().min(22).max(36).default(25), showLabels: z.boolean().default(true) });
export const pairedEvidenceConfig = z.strictObject({ showIntervals: z.boolean().default(true), showRelativeChange: z.boolean().default(true) });

export type Build = 'before' | 'after';
export type PerformanceObservation = { id: string; pair: string; route: string; version: Build; timestamp: number; latency: number | null; cpu: number | null; allocations: number | null; bytes: number | null; error: boolean };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, label: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} requires a nonempty string.`); return value; };
function col(frame: RecordFrame, key: string, type: 'string' | 'number' | 'boolean', unit?: string) {
  const index = frame.columns.findIndex(column => column.key === key);
  if (index < 0) throw new Error(`Missing source field “${key}”. Choose an existing compatible field.`);
  const column = frame.columns[index];
  if (column.type !== type) throw new Error(`Field “${key}” must have ${type} cells.`);
  if (unit && column.unit && column.unit !== unit) throw new Error(`Field “${key}” requires ${unit}. Convert the source before binding it.`);
  return index;
}
const nonnegative = (value: unknown, label: string): number | null => { if (value === null) return null; if (!finite(value) || value < 0) throw new Error(`${label} must be nonnegative or explicitly null.`); return value; };

/** Each row is one observed request/build. Matched pairs are keys, never row positions. */
export function performanceObservations(input: RecordFrame, config: z.input<typeof performanceDensityConfig> = {}): PerformanceObservation[] {
  const frame = parseRecordFrame(input), c = performanceDensityConfig.parse(config);
  const columns = { pair: col(frame, 'pair', 'string'), route: col(frame, 'route', 'string'), version: col(frame, 'version', 'string'), timestamp: col(frame, c.timeField, 'number', 'ms'), latency: col(frame, c.latencyField, 'number', 'ms'), cpu: col(frame, 'cpu', 'number', 'ms'), allocations: col(frame, 'allocations', 'number', 'count'), bytes: col(frame, 'bytes', 'number', 'bytes'), error: col(frame, 'error', 'boolean') };
  const seen = new Set<string>(), pairTimes = new Map<string, number>(), routes = new Set<string>();
  return frame.rows.map(row => {
    const pair = text(row[columns.pair], 'Request pair'), route = text(row[columns.route], 'Route'), version = row[columns.version], timestamp = row[columns.timestamp];
    if (version !== 'before' && version !== 'after') throw new Error('Build must be before or after.');
    const id = `${version}:${pair}`;
    if (seen.has(id)) throw new Error('Request/build pairs must be unique.'); seen.add(id);
    if (!finite(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) throw new Error('Timestamps require valid epoch milliseconds.');
    if (pairTimes.has(pair) && pairTimes.get(pair) !== timestamp) throw new Error('Matched requests must use the same fixture time.'); pairTimes.set(pair, timestamp);
    routes.add(route); if (routes.size > 1) throw new Error('Select one route before comparing its workload.');
    if (typeof row[columns.error] !== 'boolean') throw new Error('Error status must be a measured boolean.');
    return { id, pair, route, version, timestamp, latency: nonnegative(row[columns.latency], 'Latency'), cpu: nonnegative(row[columns.cpu], 'CPU'), allocations: nonnegative(row[columns.allocations], 'Allocations'), bytes: nonnegative(row[columns.bytes], 'Bytes'), error: row[columns.error] as boolean };
  });
}

/** Empirical R-7 quantile; interpolation does not invent additional requests. */
export function empiricalQuantile(values: readonly number[], fraction: number) {
  if (fraction < 0 || fraction > 1 || !Number.isFinite(fraction)) throw new Error('A quantile fraction must lie in [0,1].');
  if (!values.length) return null;
  if (values.some(value => !Number.isFinite(value))) throw new Error('Quantile observations must be finite.');
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** An R-7 tail quantile needs about 1/(1−q) observations before it is more than an interpolation of the top two. */
export const minimumQuantileSamples = (fraction: number) => Math.ceil(1 / (1 - fraction) - 1e-9);
/** Below that minimum the reported tail is the interval maximum, which the renderer labels as such. */
export function reportedQuantile(values: readonly number[], fraction: number): { value: number | null; basis: 'empirical' | 'maximum'; samples: number } {
  const samples = values.length;
  if (samples && samples < minimumQuantileSamples(fraction)) return { value: values.reduce((top, value) => Math.max(top, value), -Infinity), basis: 'maximum', samples };
  return { value: empiricalQuantile(values, fraction), basis: 'empirical', samples };
}

export function latencyHistogram(values: readonly number[], bins: number, maximum: number) {
  if (!Number.isInteger(bins) || bins < 2 || !Number.isFinite(maximum) || maximum <= 1 || values.some(value => !Number.isFinite(value) || value < 0 || value > maximum)) throw new Error('Histogram input requires finite nonnegative values within its declared maximum.');
  const edges = Array.from({ length: bins + 1 }, (_, index) => index === bins ? maximum : index ? Math.exp(index / bins * Math.log(maximum)) : 0);
  const rows = Array.from({ length: bins }, (_, index) => ({ index, lower: edges[index], upper: edges[index + 1], count: 0 }));
  for (const value of values) rows[Math.min(bins - 1, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(maximum) * bins)))].count++;
  return rows;
}

export function latencyDensity(rows: PerformanceObservation[], config: z.input<typeof performanceDensityConfig> = {}) {
  const c = performanceDensityConfig.parse(config), times = rows.map(row => row.timestamp), start = Math.min(...times), end = Math.max(...times);
  const maximum = Math.max(1000, 10 ** Math.ceil(Math.log10(Math.max(1, ...rows.map(row => row.latency ?? 0)))));
  const extent = rows.length ? { start, end: Math.max(start + 1, end + 1) } : null;
  const span = extent ? (extent.end - extent.start) / c.timeBuckets : 1;
  const selected = rows.filter(row => row.version === c.build);
  const buckets = Array.from({ length: extent ? c.timeBuckets : 0 }, (_, index) => {
    const begin = start + index * span, finish = begin + span;
    const observations = selected.filter(row => row.timestamp >= begin && row.timestamp < finish);
    const values = observations.flatMap(row => row.latency === null ? [] : [row.latency]);
    const p50 = reportedQuantile(values, .5), p95 = reportedQuantile(values, .95), p99 = reportedQuantile(values, .99);
    return { id: `time-${index}`, index, start: begin, end: finish, count: values.length, missing: observations.length - values.length, p50: p50.value, p95: p95.value, p99: p99.value, quantileBasis: { p50: p50.basis, p95: p95.basis, p99: p99.basis }, bins: latencyHistogram(values, c.bins, maximum) };
  });
  const cells = buckets.flatMap(bucket => bucket.bins.map(bin => ({ ...bin, id: `${bucket.index}:${bin.index}`, start: bucket.start, end: bucket.end, bucket: bucket.index, total: bucket.count, missing: bucket.missing })));
  return { maximum, extent, buckets, cells, before: latencyHistogram(rows.filter(row => row.version === 'before').flatMap(row => row.latency === null ? [] : [row.latency]), c.bins, maximum), after: latencyHistogram(rows.filter(row => row.version === 'after').flatMap(row => row.latency === null ? [] : [row.latency]), c.bins, maximum) };
}

/** Display text for an interval quantile: maxima carry their sample count and whole milliseconds; empirical tails keep one decimal. */
export function describeQuantile(value: number | null, basis: 'empirical' | 'maximum', samples: number) {
  if (value === null) return 'Unknown';
  if (basis === 'maximum') return `max of ${samples} samples · ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} ms`;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} ms`;
}
/** Arrow keys move one time bucket left/right or one latency bin up/down. Grid edges stop movement; nothing wraps into a neighbouring bucket. `buckets` lists the visible bucket indices in ascending order. */
export function stepDensityCell(buckets: readonly number[], bins: number, current: { bucket: number; index: number } | null, key: string): { bucket: number; index: number } | null {
  if (!buckets.length || !Number.isInteger(bins) || bins < 1) return null;
  const first = buckets[0], last = buckets[buckets.length - 1], base = current ?? { bucket: first, index: 0 };
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  if (key === 'ArrowRight') return { bucket: clamp(base.bucket + 1, first, last), index: base.index };
  if (key === 'ArrowLeft') return { bucket: clamp(base.bucket - 1, first, last), index: base.index };
  if (key === 'ArrowUp') return { bucket: base.bucket, index: clamp(base.index + 1, 0, bins - 1) };
  if (key === 'ArrowDown') return { bucket: base.bucket, index: clamp(base.index - 1, 0, bins - 1) };
  return null;
}

export type PerformanceSpan = TraceSpan & { phase: boolean; functionName: string | null };
/** Reuse the trace owner's parent/overlap validation; explicitly supplied phases are separate. */
export function performanceTrace(input: RecordFrame) {
  const frame = parseRecordFrame(input);
  for (const key of ['spanId', 'parentId', 'service', 'operation', 'traceId', 'status', 'functionName']) col(frame, key, 'string');
  col(frame, 'startMs', 'number', 'ms'); col(frame, 'durationMs', 'number', 'ms');
  const phase = col(frame, 'phase', 'boolean'), name = col(frame, 'functionName', 'string'), identity = col(frame, 'spanId', 'string');
  const extras = new Map(frame.rows.map(row => { if (typeof row[phase] !== 'boolean') throw new Error('Phase membership must be explicit.'); return [String(row[identity]), { phase: row[phase] as boolean, functionName: row[name] === null ? null : text(row[name], 'Function') }]; }));
  const tree = buildTraceSpans(frame);
  if (tree.roots.length > 1 || tree.roots[0]?.start !== undefined && tree.roots[0].start !== 0) throw new Error('A request trace must have one root at offset zero.');
  const spans: PerformanceSpan[] = tree.spans.map(span => ({ ...span, ...extras.get(span.id)! }));
  const phases = spans.filter(span => span.phase).sort((a, b) => a.start - b.start);
  for (let index = 1; index < phases.length; index++) if (phases[index].start < phases[index - 1].end - 1e-8) throw new Error('Declared request phases must not overlap; parallel span durations cannot be added.');
  const accounted = phases.reduce((total, span) => total + span.duration, 0);
  if (accounted > tree.duration + 1e-8) throw new Error('Declared phases exceed request elapsed time.');
  return { ...tree, spans, phases, accounted, unaccounted: Math.max(0, tree.duration - accounted) };
}

export type DifferentialFrame = { id: string; parentId: string | null; label: string; depth: number; before: ProfileFrame; after: ProfileFrame; beforeRequests: number; afterRequests: number; deltaShare: number | null; deltaPerRequest: number };
export function differentialProfile(input: RecordFrame) {
  const frame = parseRecordFrame(input);
  const keys = ['id', 'parent', 'label']; keys.forEach(key => col(frame, key, 'string'));
  const numeric = ['depth', 'beforeStart', 'beforeTotal', 'beforeSelf', 'afterStart', 'afterTotal', 'afterSelf', 'beforeRequests', 'afterRequests'];
  numeric.forEach(key => col(frame, key, 'number', key.includes('Start') || key.includes('Total') || key.includes('Self') ? 'ms' : key.includes('Requests') ? 'count' : undefined));
  const index = Object.fromEntries(frame.columns.map((column, i) => [column.key, i]));
  if (!frame.rows.length) return { frames: [] as DifferentialFrame[], before: null, after: null, beforeRequests: 0, afterRequests: 0 };
  const beforeRequests = frame.rows[0][index.beforeRequests], afterRequests = frame.rows[0][index.afterRequests];
  if (!Number.isSafeInteger(beforeRequests) || !Number.isSafeInteger(afterRequests) || Number(beforeRequests) <= 0 || Number(afterRequests) <= 0) throw new Error('Profile request denominators must be positive integer counts.');
  const make = (build: Build): Profile => {
    const frames = frame.rows.map(row => {
      if (row[index.beforeRequests] !== beforeRequests || row[index.afterRequests] !== afterRequests) throw new Error('Profile denominators must agree across frames.');
      return { id: text(row[index.id], 'Frame ID'), parentId: row[index.parent] === null ? null : text(row[index.parent], 'Parent ID'), label: text(row[index.label], 'Function'), depth: Number(row[index.depth]), start: Number(row[index[`${build}Start`]]), total: Number(row[index[`${build}Total`]]), self: Number(row[index[`${build}Self`]]) };
    });
    if (frame.rows.some(row => numeric.some(key => row[index[key]] === null))) throw new Error('Profile costs and denominators cannot be unknown; provide a known matched stack population.');
    return validateProfile({ name: `${build} CPU profile`, source: 'Normalized paired CPU costs', unit: 'milliseconds', sampleRate: 1000, frames, total: frames.find(item => item.parentId === null)?.total ?? 0 });
  };
  const before = make('before'), after = make('after');
  const frames = before.frames.map((base, i) => {
    const candidate = after.frames[i];
    return { id: base.id, parentId: base.parentId, label: base.label, depth: base.depth, before: base, after: candidate, beforeRequests: Number(beforeRequests), afterRequests: Number(afterRequests), deltaShare: after.total > 0 && before.total > 0 ? candidate.total / after.total * 100 - base.total / before.total * 100 : null, deltaPerRequest: candidate.total / Number(afterRequests) - base.total / Number(beforeRequests) };
  });
  return { frames, before, after, beforeRequests: Number(beforeRequests), afterRequests: Number(afterRequests) };
}

export const PERFORMANCE_METRICS = [
  { id: 'allocations', label: 'Allocations / request', unit: 'objects', divisor: 1 },
  { id: 'bytes', label: 'Bytes / request', unit: 'KiB', divisor: 1024 },
  { id: 'cpu', label: 'CPU / request', unit: 'ms', divisor: 1 },
] as const;
export function meanInterval(values: number[]) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null;
  const halfWidth = deviation === null ? null : 1.96 * deviation / Math.sqrt(values.length);
  return { mean, count: values.length, lower: halfWidth === null ? null : mean - halfWidth, upper: halfWidth === null ? null : mean + halfWidth };
}
export function pairedPerformance(rows: PerformanceObservation[]) {
  const pairs = new Map<string, Partial<Record<Build, PerformanceObservation>>>();
  rows.forEach(row => pairs.set(row.pair, { ...pairs.get(row.pair), [row.version]: row }));
  return PERFORMANCE_METRICS.map(metric => {
    const complete = [...pairs.values()].filter(pair => pair.before?.[metric.id] != null && pair.after?.[metric.id] != null);
    const before = complete.map(pair => pair.before![metric.id]! / metric.divisor), after = complete.map(pair => pair.after![metric.id]! / metric.divisor);
    const a = meanInterval(before), b = meanInterval(after);
    return { ...metric, before: a, after: b, delta: meanInterval(after.map((value, i) => value - before[i])), count: complete.length, missing: pairs.size - complete.length, totalPairs: pairs.size, relativeChange: a && b && a.mean !== 0 ? (b.mean / a.mean - 1) * 100 : null };
  });
}

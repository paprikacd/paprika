import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';

export const alignedTelemetryConfig = z.strictObject({
  showFill: z.boolean().default(true),
  showEvents: z.boolean().default(true),
  lineWidth: z.number().min(.5).max(4).default(1.4),
  laneHeight: z.number().int().min(64).max(180).default(82),
  tracks: z.array(z.strictObject({ name: z.string().min(1), label: z.string().min(1), unit: z.string().max(30), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), maximum: z.number().positive().optional(), decimals: z.number().int().min(0).max(6).default(1) })).min(1).max(6).refine(tracks => new Set(tracks.map(track => track.name)).size === tracks.length, 'Telemetry track names must be unique.'),
  events: z.array(z.strictObject({ id: z.string().min(1), label: z.string(), start: z.number().finite(), end: z.number().finite().optional(), kind: z.enum(['deployment', 'incident']) }).refine(event => event.end === undefined || event.end >= event.start, 'An event end must not precede its start.')).max(32).refine(events => new Set(events.map(event => event.id)).size === events.length, 'Event IDs must be unique.').default([]),
});

export const traceWaterfallConfig = z.strictObject({
  id: z.string().default('spanId'), parent: z.string().default('parentId'), service: z.string().default('service'),
  operation: z.string().default('operation'), start: z.string().default('startMs'), duration: z.string().default('durationMs'),
  status: z.string().default('status'), trace: z.string().default('traceId'),
  rowHeight: z.number().int().min(23).max(44).default(27), showService: z.boolean().default(true),
});
export const dependencyConfig = z.strictObject({
  source: z.string().default('source'), target: z.string().default('target'), latency: z.string().default('latencyMs'),
  requests: z.string().default('requests'), errors: z.string().default('errors'),
  showLabels: z.boolean().default(true), showLatency: z.boolean().default(true),
});

function column(frame: RecordFrame, key: string, type?: RecordFrame['columns'][number]['type']) {
  const index = frame.columns.findIndex(item => item.key === key);
  if (index < 0) throw new Error(`Missing required column “${key}”.`);
  if (type && frame.columns[index].type !== type) throw new Error(`Column “${key}” must be ${type}.`);
  return index;
}

export interface TraceSpan { id: string; parentId: string | null; service: string; operation: string; start: number; duration: number; end: number; status: string; traceId: string; depth: number; children: string[] }

/** Parent containment and temporal overlap are distinct from elapsed trace duration. */
export function buildTraceSpans(frame: RecordFrame, config = traceWaterfallConfig.parse({})) {
  const columns = { id: column(frame, config.id), parent: column(frame, config.parent), service: column(frame, config.service), operation: column(frame, config.operation), start: column(frame, config.start, 'number'), duration: column(frame, config.duration, 'number'), status: column(frame, config.status), trace: column(frame, config.trace) };
  if (frame.rows.length > 250) throw new Error('A trace view accepts at most 250 spans. Filter the source trace before rendering.');
  const byId = new Map<string, TraceSpan>();
  for (const row of frame.rows) {
    const id = row[columns.id], start = row[columns.start], duration = row[columns.duration];
    if (typeof id !== 'string' || !id || byId.has(id)) throw new Error('Trace span IDs must be nonempty and unique.');
    if (typeof start !== 'number' || typeof duration !== 'number' || !Number.isFinite(start) || !Number.isFinite(duration) || !Number.isFinite(start + duration) || start < 0 || duration < 0) throw new Error('Trace offsets, durations and end offsets must be finite, nonnegative milliseconds.');
    const parentId = typeof row[columns.parent] === 'string' && row[columns.parent] ? String(row[columns.parent]) : null;
    byId.set(id, { id, parentId, service: String(row[columns.service] ?? 'Unknown'), operation: String(row[columns.operation] ?? id), start, duration, end: start + duration, status: String(row[columns.status] ?? 'UNKNOWN'), traceId: String(row[columns.trace] ?? ''), depth: 0, children: [] });
  }
  const traceIds = new Set([...byId.values()].map(span => span.traceId));
  if (traceIds.size > 1) throw new Error('Select one trace before drawing its span waterfall.');
  for (const span of byId.values()) if (span.parentId) {
    const parent = byId.get(span.parentId);
    if (!parent) throw new Error(`Missing parent span for ${span.id}; incomplete traces need explicit parent records.`);
    if (span.start < parent.start || span.end > parent.end + 1e-8) throw new Error(`Span ${span.id} lies outside its parent interval.`);
    parent.children.push(span.id);
  }
  const roots = [...byId.values()].filter(span => !span.parentId).sort((a,b) => a.start - b.start || a.id.localeCompare(b.id));
  const result: TraceSpan[] = [], visited = new Set<string>();
  const visit = (span: TraceSpan, depth: number) => {
    if (visited.has(span.id)) throw new Error('Trace parents contain a cycle.');
    visited.add(span.id); span.depth = depth; result.push(span);
    span.children.sort((a,b) => byId.get(a)!.start - byId.get(b)!.start || a.localeCompare(b)).forEach(id => visit(byId.get(id)!, depth + 1));
  };
  roots.forEach(root => visit(root, 0));
  if (visited.size !== byId.size) throw new Error('Trace parents contain a cycle.');
  return { spans: result, byId, duration: Math.max(0, ...result.map(span => span.end)), roots, traceId: result[0]?.traceId ?? '' };
}

export function visibleTraceSpans(spans: readonly TraceSpan[], collapsed: ReadonlySet<string>, search = '') {
  const matching = search.trim().toLowerCase();
  const byId = new Map(spans.map(span => [span.id, span]));
  return spans.filter(span => {
    if (matching) return `${span.operation} ${span.service} ${span.id} ${span.status}`.toLowerCase().includes(matching);
    let parent = span.parentId;
    while (parent) { if (collapsed.has(parent)) return false; parent = byId.get(parent)?.parentId ?? null; }
    return true;
  });
}

export interface DependencyEdge { id: string; source: string; target: string; latency: number | null; requests: number; errors: number; errorRate: number | null }
export function buildDependencyGraph(frame: RecordFrame, config = dependencyConfig.parse({})) {
  const c = { source: column(frame, config.source), target: column(frame, config.target), latency: column(frame, config.latency, 'number'), requests: column(frame, config.requests, 'number'), errors: column(frame, config.errors, 'number') };
  if (frame.rows.length > 64) throw new Error('Dependency view supports 64 edges; narrow the source scope.');
  const ids = new Set<string>();
  const edges: DependencyEdge[] = frame.rows.map(row => {
    const source = String(row[c.source] ?? ''), target = String(row[c.target] ?? ''), requests = row[c.requests], errors = row[c.errors], latency = row[c.latency];
    const id = `${source}\u0000${target}`;
    if (!source || !target || source === target || ids.has(id)) throw new Error('Dependency edges require distinct names and unique source/target pairs.');
    ids.add(id);
    if (typeof requests !== 'number' || typeof errors !== 'number' || !Number.isFinite(requests) || !Number.isFinite(errors) || requests < 0 || errors < 0 || errors > requests) throw new Error('Dependency errors must be within the observed request population.');
    if (latency !== null && (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0)) throw new Error('Dependency latency must be nonnegative or null.');
    return { id, source, target, latency, requests, errors, errorRate: requests ? errors / requests * 100 : null };
  });
  const names = [...new Set(edges.flatMap(edge => [edge.source, edge.target]))].sort();
  if (names.length > 32) throw new Error('Dependency view supports 32 services; narrow the source scope.');
  const roots = names.filter(name => !edges.some(edge => edge.target === name));
  const levels = new Map<string, number>(roots.map(name => [name, 0]));
  for (let pass = 0; pass < names.length; pass++) for (const edge of edges) if (levels.has(edge.source) && !levels.has(edge.target)) levels.set(edge.target, levels.get(edge.source)! + 1);
  const nodes = names.map(name => {
    const incoming = edges.filter(edge => edge.target === name), outgoing = edges.filter(edge => edge.source === name);
    const population = incoming.length ? incoming : outgoing;
    const requests = population.reduce((sum,edge) => sum + edge.requests, 0), errors = population.reduce((sum,edge) => sum + edge.errors, 0);
    return { name, level: levels.get(name) ?? 0, requests, errors, errorRate: requests ? errors / requests * 100 : null, incoming, outgoing };
  });
  return { nodes, edges };
}

/** Exact same-timestamp alignment; an absent counterpart is not the previous sample. */
export function telemetryAt(series: readonly { name: string; points: readonly { timestamp: number; value: number | null }[] }[], timestamp: number) {
  return series.map(entry => ({ name: entry.name, value: entry.points.find(point => point.timestamp === timestamp)?.value ?? null }));
}

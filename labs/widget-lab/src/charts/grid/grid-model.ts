import { z } from 'zod';
import type { RecordFrame } from '@insights/schema';

export const gridNetworkConfig = z.strictObject({ showLabels: z.boolean().default(true), showFlows: z.boolean().default(true), maxNodes: z.number().int().min(1).max(100).default(40) });
export const forecastBandConfig = z.strictObject({ show68: z.boolean().default(true), show95: z.boolean().default(true), showGrid: z.boolean().default(true), showCapacity: z.boolean().default(true) });
export interface GridNode { id: string; label: string; longitude: number; latitude: number; value: number | null; voltage: number | null; reserve: number | null; status: string; history: { timestamp: number; value: number | null }[] }
export interface GridLink { id: string; source: string; target: string; value: number; capacity: number; status: string }
export interface ForecastPoint { timestamp: number; observed: number | null; median: number | null; low68: number | null; high68: number | null; low95: number | null; high95: number | null; capacity?: number | null }
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optional = (value: unknown) => numeric(value) ? value : null;

export function networkRecords(frame: RecordFrame, maxNodes = 40) {
  const idx = (name: string) => { const i = frame.columns.findIndex(column => column.key === name); if (i < 0) throw new Error(`Network map requires “${name}”.`); return i; };
  const keys = ['kind','id','label','longitude','latitude','value','voltage','reserve','status','source','target','capacity','timestamp'];
  const cols = Object.fromEntries(keys.map(key => [key, idx(key)]));
  const nodes: GridNode[] = [], links: GridLink[] = []; let omitted = 0;
  const seen = new Set<string>();
  for (const row of frame.rows.filter(row => row[cols.kind] === 'node')) {
    const id = row[cols.id], label = row[cols.label], lon = row[cols.longitude], lat = row[cols.latitude];
    if (typeof id !== 'string' || !id || typeof label !== 'string' || !numeric(lon) || !numeric(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) { omitted++; continue; }
    if (seen.has(id)) throw new Error('Network node IDs must be unique.'); seen.add(id);
    if (nodes.length >= maxNodes) { omitted++; continue; }
    nodes.push({ id, label, longitude: lon, latitude: lat, value: optional(row[cols.value]), voltage: optional(row[cols.voltage]), reserve: optional(row[cols.reserve]), status: String(row[cols.status] ?? 'Unknown'), history: [] });
  }
  for (const row of frame.rows.filter(row => row[cols.kind] === 'link')) {
    const id = row[cols.id], source = row[cols.source], target = row[cols.target], value = row[cols.value], capacity = row[cols.capacity];
    if (typeof id !== 'string' || typeof source !== 'string' || typeof target !== 'string' || !nodes.some(node => node.id === source) || !nodes.some(node => node.id === target) || !numeric(value) || value < 0 || !numeric(capacity) || capacity <= 0) { omitted++; continue; }
    if (links.some(link => link.id === id)) throw new Error('Network link IDs must be unique.');
    links.push({ id, source, target, value, capacity, status: String(row[cols.status] ?? 'Unknown') });
  }
  for (const row of frame.rows.filter(row => row[cols.kind] === 'observation')) {
    const node = nodes.find(node => node.id === row[cols.id]); const timestamp = row[cols.timestamp];
    if (!node || !numeric(timestamp)) { omitted++; continue; }
    node.history.push({ timestamp, value: optional(row[cols.value]) });
  }
  for (const node of nodes) node.history.sort((a,b) => a.timestamp - b.timestamp);
  return { nodes, links, omitted };
}

export function forecastRecords(frame: RecordFrame) {
  const keys = ['timestamp','observed','median','low68','high68','low95','high95'] as const;
  const cols = keys.map(key => { const i = frame.columns.findIndex(column => column.key === key); if (i < 0) throw new Error(`Forecast bands require “${key}”.`); if (!['number','timestamp'].includes(frame.columns[i].type)) throw new Error(`Forecast “${key}” must be numeric.`); return i; });
  const points: ForecastPoint[] = []; let omitted = 0;
  const capacityIndex = frame.columns.findIndex(c => c.key === 'capacity');
  if (capacityIndex >= 0 && frame.columns[capacityIndex].type !== 'number') throw new Error('Available capacity must be a numeric field.');
  const times = new Set<number>();
  for (const row of frame.rows) {
    const values = cols.map(i => optional(row[i])); const timestamp = values[0];
    if (timestamp === null) { omitted++; continue; }
    if (times.has(timestamp)) throw new Error('Forecast timestamps must be unique.'); times.add(timestamp);
    const [,observed,median,low68,high68,low95,high95] = values;
    const bands = [median,low68,high68,low95,high95];
    if (bands.some(v => v !== null) && !bands.every(v => v !== null)) throw new Error('A forecast needs all five median/bound observations, or all must be unknown.');
    if (median !== null && !(low95! <= low68! && low68! <= median && median <= high68! && high68! <= high95!)) throw new Error('Forecast intervals must be nested around the median.');
    const capacity = capacityIndex < 0 ? undefined : row[capacityIndex];
    if (capacity !== undefined && capacity !== null && (!numeric(capacity) || capacity < 0)) throw new Error('Available capacity must be finite and nonnegative, or null.');
    points.push({ timestamp, observed, median, low68, high68, low95, high95, ...(capacityIndex < 0 ? {} : { capacity: capacity as number | null }) });
  }
  points.sort((a,b) => a.timestamp-b.timestamp);
  return { points, omitted };
}

export function gridFlowColor(value: number, capacity: number) { return value / capacity >= 1 ? 'var(--gamma-danger)' : value / capacity >= .8 ? 'var(--gamma-warning)' : 'var(--gamma-chart-1)'; }

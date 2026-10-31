import { z } from 'zod';
import type { RecordFrame } from '../../vendor/paprika/ui/src/features/insights/schema';

const selected = { selectedPass: z.string().max(80).optional(), selectedTimestamp: z.number().finite().optional(), showPassPicker: z.boolean().default(true) };
export const groundTrackConfig = z.strictObject({ ...selected, showLabels: z.boolean().default(true), showEclipse: z.boolean().default(true), showGraticule: z.boolean().default(true) });
export const skyplotConfig = z.strictObject({ ...selected, showMask: z.boolean().default(true), showTimeLabels: z.boolean().default(true) });
export const contactTimelineConfig = z.strictObject({ ...selected, showSignals: z.boolean().default(true), showUncertainty: z.boolean().default(true) });
export const linkBudgetConfig = z.strictObject({ selectedPass: z.string().max(80).optional(), showValues: z.boolean().default(true) });

function records(frame: RecordFrame | undefined, keys: string[]) {
  if (!frame) return [];
  if (frame.rows.length > 1000) throw new Error('Orbital charts accept at most 1,000 records.');
  const available = new Map(frame.columns.map((c, i) => [c.key, i]));
  if (available.size !== frame.columns.length) throw new Error('Orbital columns require unique keys.');
  for (const key of keys) if (!available.has(key)) throw new Error(`Missing orbital field “${key}”.`);
  return frame.rows.map(row => Object.fromEntries(frame.columns.map((c, i) => [c.key, row[i]])));
}
function finite(v: unknown, label: string) { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} must be finite.`); return v; }
function text(v: unknown, label: string) { if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} must be nonempty text.`); return v; }
function bounded(v: unknown, label: string, min: number, max: number) { const n = finite(v, label); if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`); return n; }
function unique<T extends { id: string }>(items: T[]) { const ids = new Set<string>(); for (const item of items) { if (ids.has(item.id)) throw new Error(`Duplicate orbital identity “${item.id}”.`); ids.add(item.id); } return items; }

export type GroundPoint = { id: string; passId: string; satellite: string; station: string; timestamp: number; longitude: number; latitude: number; altitude: number; phase: 'past' | 'predicted'; eclipse: boolean; stationLon: number; stationLat: number; acquisition: number; loss: number };
export function groundPoints(frame: RecordFrame | undefined): GroundPoint[] {
  const data = unique(records(frame, ['id', 'passId', 'satellite', 'station', 'timestamp', 'longitude', 'latitude', 'altitude', 'phase', 'eclipse', 'stationLon', 'stationLat', 'acquisition', 'loss']).map<GroundPoint>(r => {
    const acquisition = finite(r.acquisition, 'Acquisition'), loss = finite(r.loss, 'Loss');
    if (loss <= acquisition) throw new Error('Contact loss must follow acquisition.');
    if (r.phase !== 'past' && r.phase !== 'predicted') throw new Error('Ground-track phase must be past or predicted.');
    if (typeof r.eclipse !== 'boolean') throw new Error('Eclipse must be an explicit boolean.');
    return { id: text(r.id, 'ID'), passId: text(r.passId, 'Pass'), satellite: text(r.satellite, 'Satellite'), station: text(r.station, 'Station'), timestamp: finite(r.timestamp, 'Timestamp'), longitude: bounded(r.longitude, 'Longitude', -180, 180), latitude: bounded(r.latitude, 'Latitude', -90, 90), altitude: bounded(r.altitude, 'Altitude', 0, 100000), phase: r.phase, eclipse: r.eclipse, stationLon: bounded(r.stationLon, 'Station longitude', -180, 180), stationLat: bounded(r.stationLat, 'Station latitude', -90, 90), acquisition, loss };
  }));
  for (const group of groupByPass(data)) {
    const times = group.points.map(p => p.timestamp);
    if (new Set(times).size !== times.length) throw new Error('A pass cannot have duplicate track timestamps.');
    const first = group.points[0];
    if (group.points.some(p => p.satellite !== first.satellite || p.station !== first.station || p.acquisition !== first.acquisition || p.loss !== first.loss || p.stationLon !== first.stationLon || p.stationLat !== first.stationLat)) throw new Error('Track records must agree on their pass identity and bounds.');
  }
  return data;
}

export type SkyPoint = { id: string; passId: string; satellite: string; station: string; timestamp: number; azimuth: number; elevation: number; margin: number | null; throughput: number | null; uncertainty: number };
export function skyPoints(frame: RecordFrame | undefined): SkyPoint[] {
  const data = unique(records(frame, ['id', 'passId', 'satellite', 'station', 'timestamp', 'azimuth', 'elevation', 'margin', 'throughput', 'uncertainty']).map(r => ({
    id: text(r.id, 'ID'), passId: text(r.passId, 'Pass'), satellite: text(r.satellite, 'Satellite'), station: text(r.station, 'Station'), timestamp: finite(r.timestamp, 'Timestamp'), azimuth: bounded(r.azimuth, 'Azimuth', 0, 360), elevation: bounded(r.elevation, 'Elevation', 0, 90), margin: r.margin === null ? null : finite(r.margin, 'Margin'), throughput: r.throughput === null ? null : bounded(r.throughput, 'Throughput', 0, 100000), uncertainty: bounded(r.uncertainty, 'Uncertainty', 0, 100),
  })));
  for (const group of groupByPass(data)) if (new Set(group.points.map(p => p.timestamp)).size !== group.points.length) throw new Error('A pass cannot have duplicate sky timestamps.');
  return data;
}

export type OrbitalPass = { id: string; satellite: string; station: string; start: number; end: number; peak: number; minMargin: number | null; volumeMB: number | null; coverage: number; samples: SkyPoint[] };
/** Each pass is derived from its actual timestamped predictions; no bytes are inferred across gaps. */
export function summarizePasses(points: SkyPoint[]): OrbitalPass[] {
  return groupByPass(points).map(({ id, points: samples }) => {
    const first = samples[0], last = samples.at(-1)!;
    if (samples.length < 2 || last.timestamp <= first.timestamp) throw new Error('A contact needs at least two ordered observations.');
    if (samples.some(p => p.satellite !== first.satellite || p.station !== first.station)) throw new Error('Sky records must agree on satellite and station.');
    let mb = 0, covered = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], duration = b.timestamp - a.timestamp;
      if (a.throughput !== null && b.throughput !== null) { mb += (a.throughput + b.throughput) / 2 * duration / 8000; covered += duration; }
    }
    const margins = samples.map(p => p.margin).filter((v): v is number => v !== null);
    return { id, satellite: first.satellite, station: first.station, start: first.timestamp, end: last.timestamp, peak: Math.max(...samples.map(p => p.elevation)), minMargin: margins.length ? Math.min(...margins) : null, volumeMB: covered === last.timestamp - first.timestamp ? mb : null, coverage: covered / (last.timestamp - first.timestamp), samples };
  }).sort((a, b) => a.start - b.start);
}

export type BudgetTerm = { id: string; passId: string; label: string; order: number; value: number };
export function budgetTerms(frame: RecordFrame | undefined): BudgetTerm[] {
  const data = unique(records(frame, ['id', 'passId', 'label', 'order', 'value']).map(r => ({ id: text(r.id, 'ID'), passId: text(r.passId, 'Pass'), label: text(r.label, 'Label'), order: bounded(r.order, 'Order', 0, 20), value: finite(r.value, 'Relative dB contribution') })));
  for (const group of groupByPass(data)) { const order = group.points.map(p => p.order); if (order.some(n => !Number.isInteger(n)) || new Set(order).size !== order.length) throw new Error('Budget order must be unique integers per pass.'); }
  return data;
}
export function budgetSteps(terms: BudgetTerm[]) { let sum = 0; return [...terms].sort((a, b) => a.order - b.order).map(p => { const start = sum; sum += p.value; return { ...p, start, end: sum }; }); }
export function budgetTotal(terms: BudgetTerm[]) { return terms.reduce((sum, p) => sum + p.value, 0); }

export function groupByPass<T extends { passId: string }>(items: T[]): { id: string; points: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const p of items) groups.set(p.passId, [...(groups.get(p.passId) ?? []), p]);
  return [...groups].map(([id, points]) => ({ id, points: [...points].sort((a, b) => ('timestamp' in a && 'timestamp' in b ? Number(a.timestamp) - Number(b.timestamp) : 0)) }));
}

export type LonLat = { longitude: number; latitude: number };
/** Insert both boundary intersections; never draw an antimeridian chord across the map. */
export function splitDateline(points: LonLat[]): LonLat[][] {
  if (!points.length) return [];
  const segments: LonLat[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], delta = b.longitude - a.longitude;
    if (Math.abs(delta) <= 180) { segments.at(-1)!.push(b); continue; }
    const unwrapped = b.longitude + (delta > 180 ? -360 : 360), boundary = unwrapped > a.longitude ? 180 : -180;
    const f = (boundary - a.longitude) / (unwrapped - a.longitude), latitude = a.latitude + (b.latitude - a.latitude) * f;
    segments.at(-1)!.push({ longitude: boundary, latitude });
    segments.push([{ longitude: -boundary, latitude }, b]);
  }
  return segments;
}
export function wrapLongitude(lon: number) { return ((lon + 180) % 360 + 360) % 360 - 180; }
export function skyPosition(azimuth: number, elevation: number, radius: number) {
  if (![azimuth, elevation, radius].every(Number.isFinite) || elevation < 0 || elevation > 90 || radius <= 0) throw new Error('Invalid skyplot coordinate.');
  const angle = azimuth * Math.PI / 180, r = radius * (90 - elevation) / 90;
  return { x: Math.sin(angle) * r, y: -Math.cos(angle) * r };
}
export function isObstructed(azimuth: number, elevation: number) { const angle = ((azimuth % 360) + 360) % 360; return angle >= 120 && angle <= 165 && elevation < 18; }
export function nearestAt<T extends { timestamp: number }>(points: T[], timestamp: number): T | undefined { return points.reduce<T | undefined>((closest, p) => !closest || Math.abs(p.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp) ? p : closest, undefined); }
export const orbitalUtc = (timestamp: number, seconds = false) => new Date(timestamp).toISOString().slice(11, seconds ? 19 : 16);
export function orbitalDuration(ms: number) { const seconds = Math.round(ms / 1000); return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`; }

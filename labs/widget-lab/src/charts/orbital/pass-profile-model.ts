import { z } from 'zod';
import type { RecordFrame } from '@insights/schema';

const field = (name: string) => z.string().min(1).max(80).default(name);
export const passProfileConfig = z.strictObject({
  selectedPass: z.string().max(80).optional(),
  selectedTimestamp: z.number().finite().optional(),
  showPassPicker: z.boolean().default(true),
  idField: field('id'), passField: field('passId'), satelliteField: field('satellite'), stationField: field('station'),
  timestampField: field('timestamp'), elevationField: field('elevation'), marginField: field('margin'), throughputField: field('throughput'),
  minimumElevation: z.number().finite().min(0).max(90).default(10),
  minimumMargin: z.number().finite().min(-50).max(100).default(3),
  maxGapSeconds: z.number().finite().min(1).max(3600).default(60),
  showThresholds: z.boolean().default(true),
  showEligibleWindows: z.boolean().default(true),
  showSampleMarkers: z.boolean().default(false),
});
export type PassProfileConfig = z.infer<typeof passProfileConfig>;
export type PassProfilePoint = {
  id: string; passId: string; satellite: string; station: string; timestamp: number;
  elevation: number; margin: number | null; throughput: number | null;
};
export type PassProfile = { id: string; satellite: string; station: string; start: number; end: number; samples: PassProfilePoint[] };

export function passProfilePoints(frame: RecordFrame | undefined, config: unknown = {}): PassProfilePoint[] {
  const cfg = passProfileConfig.parse(config);
  if (!frame) return [];
  if (frame.rows.length > 1000) throw new Error('Contact profiles accept at most 1,000 observations.');
  const columns = new Map(frame.columns.map((column, index) => [column.key, { ...column, index }]));
  if (columns.size !== frame.columns.length) throw new Error('Contact profile columns require unique keys.');
  const roles = [
    ['idField', 'string', undefined], ['passField', 'string', undefined], ['satelliteField', 'string', undefined], ['stationField', 'string', undefined],
    ['timestampField', 'number', ['ms']], ['elevationField', 'number', ['°']], ['marginField', 'number', ['dB']], ['throughputField', 'number', ['Mbps']],
  ] as const;
  for (const [role, type, units] of roles) {
    const column = columns.get(cfg[role]);
    if (!column) throw new Error(`${role}: Missing orbital field “${cfg[role]}”. Choose a field in the loaded result.`);
    if (column.type !== type) throw new Error(`${role}: “${column.key}” must be a ${type} field.`);
    if (units && !units.some(unit => unit === column.unit)) throw new Error(`${role}: “${column.key}” must declare ${units.join(' or ')} units; no implicit conversion is applied.`);
  }
  const ids = new Set<string>();
  return frame.rows.map((row, i) => {
    const cell = (key: keyof Pick<PassProfileConfig, 'idField' | 'passField' | 'satelliteField' | 'stationField' | 'timestampField' | 'elevationField' | 'marginField' | 'throughputField'>) => row[columns.get(cfg[key])!.index];
    const text = (value: unknown, role: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${role}: row ${i + 1} needs nonempty text.`); return value; };
    const number = (value: unknown, role: string) => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${role}: row ${i + 1} needs a finite number.`); return value; };
    const id = text(cell('idField'), 'idField');
    if (ids.has(id)) throw new Error(`idField: duplicate observation “${id}”.`);
    ids.add(id);
    const timestamp = number(cell('timestampField'), 'timestampField');
    if (!Number.isFinite(new Date(timestamp).getTime())) throw new Error(`timestampField: row ${i + 1} is outside the valid UTC timestamp range.`);
    const elevation = number(cell('elevationField'), 'elevationField');
    if (elevation < 0 || elevation > 90) throw new Error(`elevationField: row ${i + 1} must lie between 0° and 90°.`);
    const margin = cell('marginField') === null ? null : number(cell('marginField'), 'marginField');
    const throughput = cell('throughputField') === null ? null : number(cell('throughputField'), 'throughputField');
    if (throughput !== null && throughput < 0) throw new Error(`throughputField: row ${i + 1} cannot be negative.`);
    return { id, passId: text(cell('passField'), 'passField'), satellite: text(cell('satelliteField'), 'satelliteField'), station: text(cell('stationField'), 'stationField'), timestamp, elevation, margin, throughput };
  });
}

export function profilePasses(points: PassProfilePoint[]): PassProfile[] {
  const grouped = new Map<string, PassProfilePoint[]>();
  for (const point of points) {
    const group = grouped.get(point.passId) ?? [];
    group.push(point); grouped.set(point.passId, group);
  }
  return [...grouped].map(([id, group]) => {
    const samples = [...group].sort((a, b) => a.timestamp - b.timestamp), first = samples[0], last = samples.at(-1)!;
    if (samples.length < 2) throw new Error(`Pass “${id}” needs at least two timed observations.`);
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].satellite !== first.satellite || samples[i].station !== first.station) throw new Error(`Pass “${id}” has inconsistent satellite or station identity.`);
      if (i && samples[i].timestamp <= samples[i - 1].timestamp) throw new Error(`Pass “${id}” has duplicate timestamps.`);
    }
    return { id, satellite: first.satellite, station: first.station, start: first.timestamp, end: last.timestamp, samples };
  }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export type ContactWindow = { start: number; end: number; volumeMB: number | null };
export type ProfileQualification = {
  windows: ContactWindow[]; unknown: { start: number; end: number }[];
  qualifiedMs: number; unknownMs: number; coveredMs: number; knownVolumeMB: number;
  totalQualifiedMs: number | null; totalVolumeMB: number | null; coverage: number;
};

function above(a: number, b: number, threshold: number): [number, number] | null {
  if (a >= threshold && b >= threshold) return [0, 1];
  if (a < threshold && b < threshold) return null;
  const crossing = (threshold - a) / (b - a);
  return a < threshold ? [crossing, 1] : [0, crossing];
}

/** Linear interpolation is limited to known adjacent samples within the declared gap bound. */
export function qualifyProfile(pass: PassProfile, config: unknown = {}): ProfileQualification {
  const cfg = passProfileConfig.parse(config), windows: ContactWindow[] = [], unknown: { start: number; end: number }[] = [];
  let qualifiedMs = 0, unknownMs = 0, unknownEligibilityMs = 0, knownVolumeMB = 0, volumeUnknown = false;
  for (let i = 1; i < pass.samples.length; i++) {
    const a = pass.samples[i - 1], b = pass.samples[i], elapsed = b.timestamp - a.timestamp;
    if (elapsed <= 0) throw new Error('Contact sample timestamps must increase.');
    const longGap = elapsed > cfg.maxGapSeconds * 1000;
    const marginMissing = a.margin === null || b.margin === null, rateMissing = a.throughput === null || b.throughput === null;
    if (longGap || marginMissing || rateMissing) { unknown.push({ start: a.timestamp, end: b.timestamp }); unknownMs += elapsed; }
    // No interpolation across an acquisition gap. Missing transfer rate alone does
    // not erase otherwise known elevation/margin eligibility.
    if (longGap) { unknownEligibilityMs += elapsed; volumeUnknown = true; continue; }
    const elevation = above(a.elevation, b.elevation, cfg.minimumElevation);
    if (!elevation) continue;
    if (marginMissing) {
      unknownEligibilityMs += elapsed * (elevation[1] - elevation[0]); volumeUnknown = true; continue;
    }
    const margin = above(a.margin!, b.margin!, cfg.minimumMargin);
    if (!margin) continue;
    const from = Math.max(elevation[0], margin[0]), to = Math.min(elevation[1], margin[1]);
    if (to <= from) continue;
    const start = a.timestamp + elapsed * from, end = a.timestamp + elapsed * to;
    const rateStart = rateMissing ? null : a.throughput! + (b.throughput! - a.throughput!) * from, rateEnd = rateMissing ? null : a.throughput! + (b.throughput! - a.throughput!) * to;
    const volumeMB = rateStart === null || rateEnd === null ? null : (rateStart + rateEnd) / 2 * (end - start) / 8000;
    qualifiedMs += end - start;
    if (volumeMB === null) volumeUnknown = true; else knownVolumeMB += volumeMB;
    const last = windows.at(-1);
    if (last && Math.abs(last.end - start) < .001) { last.end = end; last.volumeMB = last.volumeMB === null || volumeMB === null ? null : last.volumeMB + volumeMB; }
    else windows.push({ start, end, volumeMB });
  }
  const duration = pass.end - pass.start;
  return { windows, unknown, qualifiedMs, unknownMs, coveredMs: duration - unknownMs, knownVolumeMB, totalQualifiedMs: unknownEligibilityMs ? null : qualifiedMs, totalVolumeMB: volumeUnknown ? null : knownVolumeMB, coverage: duration ? (duration - unknownMs) / duration : 0 };
}

export function profileSignalPath(samples: PassProfilePoint[], field: 'elevation' | 'margin' | 'throughput', maxGapMs: number, x: (value: number) => number, y: (value: number) => number): string {
  let previous: PassProfilePoint | undefined;
  return samples.map(sample => {
    const value = sample[field];
    if (value === null) { previous = undefined; return ''; }
    const connected = previous && sample.timestamp - previous.timestamp <= maxGapMs;
    const command = `${connected ? 'L' : 'M'}${x(sample.timestamp)},${y(value)}`;
    previous = sample; return command;
  }).filter(Boolean).join(' ');
}

import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';
import { recordObjects } from '../analytics/data';

export const DIE_BINS = ['pass', 'leakage', 'timing', 'open', 'untested', 'excluded'] as const;
export type DieBin = typeof DIE_BINS[number];
export const BIN_LABEL: Record<DieBin, string> = { pass: 'Pass', leakage: 'Leakage', timing: 'Timing', open: 'Open', untested: 'Untested', excluded: 'Edge excluded' };
export const FAILURE_BINS = ['leakage', 'timing', 'open'] as const;
export const waferMapConfig = z.strictObject({
  colorMode: z.enum(['bin', 'leakage']).default('bin'),
  showCoordinates: z.boolean().default(true),
  showGrid: z.boolean().default(true),
  cellGap: z.number().min(0).max(.35).default(.12),
  selectedDieId: z.string().max(120).default(''),
  filter: z.enum(['all', 'failed', ...DIE_BINS]).default('all'),
});
export const waferSignatureConfig = z.strictObject({
  metric: z.enum(['rate', 'count']).default('rate'),
  angularBins: z.union([z.literal(8), z.literal(12), z.literal(16), z.literal(20), z.literal(24)]).default(12),
  defect: z.enum(['all', ...FAILURE_BINS]).default('all'),
  showValues: z.boolean().default(true),
});
export const waferYieldConfig = z.strictObject({ showValues: z.boolean().default(true) });
export const waferChamberConfig = z.strictObject({
  scale: z.enum(['log', 'linear']).default('log'),
  showOutliers: z.boolean().default(true),
  specification: z.number().positive().max(10000).default(10),
  selectedChamber: z.string().max(80).default(''),
});
export const waferLineageConfig = z.strictObject({ selectedDieId: z.string().max(120).default(''), showMeasurements: z.boolean().default(true) });
export const waferTransectConfig = z.strictObject({
  xField: z.string().min(1).max(120).default('xMm'),
  yField: z.string().min(1).max(120).default('yMm'),
  valueField: z.string().min(1).max(120).default('leakageNA'),
  axis: z.enum(['row', 'column']).default('row'),
  followSelection: z.boolean().default(true),
  index: z.number().int().min(-10000).max(10000).default(0),
  scale: z.enum(['linear', 'log']).default('log'),
  showConnections: z.boolean().default(true),
  showGrid: z.boolean().default(true),
  showReference: z.boolean().default(true),
  referenceValue: z.number().positive().max(10000).default(10),
  selectedDieId: z.string().max(120).default(''),
});

export interface WaferDie {
  id: string;
  wafer: string;
  lot: string;
  column: number;
  row: number;
  xMm: number;
  yMm: number;
  pitchMm: number;
  dieSizeMm: number;
  diameterMm: number;
  bin: DieBin;
  leakageNA: number | null;
  chamber: string;
  probeAt: number | null;
  processStart: number;
  lithographyAt: number;
  etchAt: number;
  cleanAt: number;
  depositionNm: number;
  lithographyDose: number;
  etchSeconds: number;
  cleanPpm: number;
}

const required = ['id', 'wafer', 'lot', 'column', 'row', 'xMm', 'yMm', 'pitchMm', 'dieSizeMm', 'diameterMm', 'bin', 'leakageNA', 'chamber', 'probeAt', 'processStart', 'lithographyAt', 'etchAt', 'cleanAt', 'depositionNm', 'lithographyDose', 'etchSeconds', 'cleanPpm'];
const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must have an identity.`);
  return value;
};
const nonnegative = (value: unknown, label: string) => {
  const n = finite(value, label);
  if (n < 0) throw new Error(`${label} cannot be negative.`);
  return n;
};
const whole = (value: unknown, label: string) => {
  const n = finite(value, label);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer.`);
  return n;
};
const timestamp = (value: unknown, label: string) => {
  const n = nonnegative(value, label);
  if (!Number.isSafeInteger(n) || !Number.isFinite(new Date(n).getTime())) throw new Error(`${label} must be a representable epoch-millisecond timestamp.`);
  return n;
};

/** Physical coordinates are measured millimetres; row/column are discrete die identities. */
export function waferRows(frame: RecordFrame | undefined): WaferDie[] {
  if (!frame) return [];
  const strings = ['id', 'wafer', 'lot', 'bin', 'chamber'];
  for (const key of required) {
    const column = frame.columns.find(c => c.key === key);
    const expected = strings.includes(key) ? 'string' : 'number';
    if (column && column.type !== expected) throw new Error(`${key} must have type ${expected}.`);
  }
  for (const key of ['xMm', 'yMm', 'pitchMm', 'dieSizeMm', 'diameterMm']) {
    const column = frame.columns.find(c => c.key === key);
    if (column?.unit && column.unit !== 'mm') throw new Error(`${key} must use millimetres (mm).`);
  }
  const units: Record<string, string> = { leakageNA: 'nA', probeAt: 'ms', processStart: 'ms', lithographyAt: 'ms', etchAt: 'ms', cleanAt: 'ms', depositionNm: 'nm', lithographyDose: 'mJ/cm²', etchSeconds: 's', cleanPpm: 'ppm' };
  for (const [key, unit] of Object.entries(units)) {
    const column = frame.columns.find(c => c.key === key);
    if (column?.unit && column.unit !== unit) throw new Error(`${key} must use ${unit}; convert source observations before charting.`);
  }
  const seen = new Set<string>(), coordinates = new Set<string>();
  const data = recordObjects(frame, required, 1000).map(r => {
    const id = text(r.id, 'Die'), wafer = text(r.wafer, 'Wafer'), lot = text(r.lot, 'Lot');
    const column = whole(r.column, 'Die column'), row = whole(r.row, 'Die row');
    const xMm = finite(r.xMm, 'X coordinate'), yMm = finite(r.yMm, 'Y coordinate');
    const pitchMm = finite(r.pitchMm, 'Die pitch'), dieSizeMm = finite(r.dieSizeMm, 'Die size'), diameterMm = finite(r.diameterMm, 'Wafer diameter');
    if (pitchMm <= 0 || dieSizeMm <= 0 || dieSizeMm > pitchMm || diameterMm <= 0) throw new Error('Wafer geometry needs positive, ordered physical dimensions.');
    if (Math.abs(xMm - column * pitchMm) > 1e-7 || Math.abs(yMm - row * pitchMm) > 1e-7) throw new Error('Die row/column and physical millimetre coordinates disagree.');
    if (Math.hypot(xMm, yMm) > diameterMm / 2 + 1e-7) throw new Error('A die centre lies outside the wafer boundary.');
    const bin = r.bin as DieBin;
    if (!DIE_BINS.includes(bin)) throw new Error('Unknown wafer test bin.');
    const leakageNA = r.leakageNA === null ? null : nonnegative(r.leakageNA, 'Leakage');
    const probeAt = r.probeAt === null ? null : timestamp(r.probeAt, 'Probe timestamp');
    const processStart = timestamp(r.processStart, 'Process start');
    const lithographyAt = timestamp(r.lithographyAt, 'Lithography timestamp'), etchAt = timestamp(r.etchAt, 'Etch timestamp'), cleanAt = timestamp(r.cleanAt, 'Clean timestamp');
    if (!(processStart <= lithographyAt && lithographyAt <= etchAt && etchAt <= cleanAt && (probeAt === null || cleanAt <= probeAt))) throw new Error('Process-stage timestamps must follow the recorded sequence.');
    if ((bin === 'untested' || bin === 'excluded') && (leakageNA !== null || probeAt !== null)) throw new Error('Untested and excluded dies cannot carry electrical-test observations.');
    if (!['untested', 'excluded'].includes(bin) && probeAt === null) throw new Error('A tested die must have a probe timestamp.');
    if (['pass', 'leakage', 'timing'].includes(bin) && leakageNA === null) throw new Error('This electrical bin requires a measured leakage value.');
    if (probeAt !== null && probeAt < processStart) throw new Error('Probe timestamps cannot precede process history.');
    if (bin !== 'excluded' && Math.hypot(Math.abs(xMm) + dieSizeMm / 2, Math.abs(yMm) + dieSizeMm / 2) > diameterMm / 2 + 1e-7) throw new Error('A tested/eligible die extends outside the physical wafer; classify it as edge excluded.');
    const coordinate = `${wafer}:${column}:${row}`;
    if (seen.has(id) || coordinates.has(coordinate)) throw new Error('Duplicate die identity or wafer coordinate.');
    seen.add(id); coordinates.add(coordinate);
    return { id, wafer, lot, column, row, xMm, yMm, pitchMm, dieSizeMm, diameterMm, bin, leakageNA, chamber: text(r.chamber, 'Chamber'), probeAt, processStart, lithographyAt, etchAt, cleanAt,
      depositionNm: nonnegative(r.depositionNm, 'Deposition thickness'), lithographyDose: nonnegative(r.lithographyDose, 'Lithography dose'), etchSeconds: nonnegative(r.etchSeconds, 'Etch duration'), cleanPpm: nonnegative(r.cleanPpm, 'Clean residue') };
  });
  if (new Set(data.map(d => d.wafer)).size > 1) throw new Error('A die-map result must describe one wafer; split the result by wafer.');
  if (new Set(data.map(d => `${d.lot}:${d.pitchMm}:${d.dieSizeMm}:${d.diameterMm}:${d.chamber}`)).size > 1) throw new Error('Wafer geometry, lot and wafer-level etch chamber must be consistent.');
  return data;
}

export const isFailure = (die: WaferDie) => FAILURE_BINS.includes(die.bin as typeof FAILURE_BINS[number]);
export function summarizeWafer(dies: readonly WaferDie[]) {
  const bins = Object.fromEntries(DIE_BINS.map(bin => [bin, dies.filter(d => d.bin === bin).length])) as Record<DieBin, number>;
  const failed = bins.leakage + bins.timing + bins.open, tested = bins.pass + failed;
  return { positions: dies.length, eligible: dies.length - bins.excluded, tested, passing: bins.pass, failed, untested: bins.untested, excluded: bins.excluded, yield: tested ? bins.pass / tested * 100 : null, bins };
}
export function filterDies(dies: readonly WaferDie[], filter: z.infer<typeof waferMapConfig>['filter']) {
  return dies.filter(die => filter === 'all' || filter === 'failed' && isFailure(die) || die.bin === filter);
}
/** Logical row/column navigation preserves the physical +Y-up convention and skips filtered dies. */
export function waferKeyboardTarget(dies: readonly WaferDie[], current: WaferDie, key: string) {
  const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  const dy = key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0;
  if (!dx && !dy) return null;
  return dies.filter(d => dx ? d.row === current.row && Math.sign(d.column - current.column) === dx : d.column === current.column && Math.sign(d.row - current.row) === dy)
    .sort((a, b) => Math.abs(a.column - current.column) + Math.abs(a.row - current.row) - Math.abs(b.column - current.column) - Math.abs(b.row - current.row))[0] ?? null;
}
export function waferFocusId(dies: readonly WaferDie[], focus: string | null, selected: string | null) {
  return dies.find(d => d.id === focus)?.id ?? dies.find(d => d.id === selected)?.id ?? dies[0]?.id ?? null;
}

/** Field aliases preserve the maintained physical wafer invariants and never mutate the source frame. */
export function waferTransectRows(frame: RecordFrame | undefined, config: z.infer<typeof waferTransectConfig>) {
  if (!frame) return [];
  const bindings = [
    { target: 'xMm', source: config.xField, option: 'xField' },
    { target: 'yMm', source: config.yField, option: 'yField' },
    { target: 'leakageNA', source: config.valueField, option: 'valueField' },
  ];
  if (new Set(bindings.map(binding => binding.source)).size !== bindings.length) throw new Error('xField / yField / valueField: Use distinct source fields for horizontal position, vertical position and leakage.');
  const mapped = bindings.map(binding => {
    const index = frame.columns.findIndex(column => column.key === binding.source);
    if (index < 0) throw new Error(`${binding.option}: Missing chart column “${binding.source}”. Choose a field in the loaded wafer result.`);
    if (frame.columns[index].type !== 'number') throw new Error(`${binding.option}: ${binding.source} must have type number.`);
    return { ...binding, index };
  });
  const kept = frame.columns.flatMap((column, index) => bindings.some(binding => binding.target === column.key) ? [] : [index]);
  return waferRows({
    ...frame,
    columns: [...kept.map(index => frame.columns[index]), ...mapped.map(binding => ({ ...frame.columns[binding.index], key: binding.target }))],
    rows: frame.rows.map(row => [...kept.map(index => row[index]), ...mapped.map(binding => row[binding.index])]),
  });
}

/** A physical section contains supplied die positions only. Selection changes its row/column, never its source population. */
export function waferTransect(dies: readonly WaferDie[], config: z.infer<typeof waferTransectConfig>) {
  const selected = config.followSelection ? dies.find(d => d.id === config.selectedDieId) : undefined;
  const index = selected?.[config.axis] ?? config.index;
  const points = dies.filter(d => d[config.axis] === index).sort((a, b) => config.axis === 'row' ? a.column - b.column : a.row - b.row);
  if (dies.length && !points.length) throw new Error(`index: No supplied die positions in ${config.axis} ${index}. Choose an available ${config.axis} or follow a selected die.`);
  if (config.scale === 'log' && points.some(d => d.leakageNA !== null && d.leakageNA <= 0)) throw new Error('scale: Logarithmic leakage requires positive measurements in this section. Choose linear to retain measured zero.');
  const observed = points.filter(d => d.leakageNA !== null), untested = points.filter(d => d.bin === 'untested').length;
  const excluded = points.filter(d => d.bin === 'excluded').length;
  return {
    axis: config.axis, index, points, observed: observed.length, eligible: points.length - excluded,
    untested, excluded, unavailable: points.filter(d => d.leakageNA === null && !['untested', 'excluded'].includes(d.bin)).length,
    fixedMm: points[0] ? (config.axis === 'row' ? points[0].yMm : points[0].xMm) : null,
    radiusMm: (dies[0]?.diameterMm ?? 300) / 2,
    median: quantile(observed.map(d => d.leakageNA!), .5),
  };
}

/** A connection is permitted only between adjacent physical grid slots with two measurements. */
export function waferTransectSegments(points: readonly WaferDie[], axis: 'row' | 'column') {
  const ordered = [...points].sort((a, b) => axis === 'row' ? a.column - b.column : a.row - b.row);
  const coordinate = (die: WaferDie) => axis === 'row' ? die.column : die.row;
  const segments: WaferDie[][] = [];
  let current: WaferDie[] = [];
  for (const point of ordered) {
    if (point.leakageNA === null) { if (current.length) segments.push(current); current = []; continue; }
    if (current.length && coordinate(point) !== coordinate(current.at(-1)!) + 1) { segments.push(current); current = []; }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
export function waferLosses(dies: readonly WaferDie[]) {
  const summary = summarizeWafer(dies);
  let level = summary.tested;
  const losses = FAILURE_BINS.map(bin => {
    const before = level; level -= summary.bins[bin];
    return { id: bin, label: BIN_LABEL[bin], value: -summary.bins[bin], start: before, end: level, total: false };
  });
  return [{ id: 'tested', label: 'Tested', value: summary.tested, start: 0, end: summary.tested, total: true }, ...losses,
    { id: 'passing', label: 'Passing', value: summary.passing, start: 0, end: summary.passing, total: true }];
}
export function dieAngle(die: Pick<WaferDie, 'xMm' | 'yMm'>) {
  return (Math.atan2(die.xMm, die.yMm) * 180 / Math.PI + 360) % 360;
}
export interface SignatureBin { id: string; lower: number; upper: number; tested: number; failures: number; untested: number; rate: number | null }
export function waferSignature(dies: readonly WaferDie[], angularBins = 12, defect: 'all' | typeof FAILURE_BINS[number] = 'all') {
  if (![8, 12, 16, 20, 24].includes(angularBins)) throw new Error('Choose 8, 12, 16, 20 or 24 angular bins.');
  const radius = (dies[0]?.diameterMm ?? 300) / 2;
  const make = (count: number, extent: number, prefix: string): SignatureBin[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, lower: i * extent / count, upper: (i + 1) * extent / count, tested: 0, failures: 0, untested: 0, rate: null }));
  const angular = make(angularBins, 360, 'angle'), radial = make(6, radius, 'radius');
  for (const die of dies) {
    if (die.bin === 'excluded') continue;
    const a = angular[Math.min(angular.length - 1, Math.floor(dieAngle(die) / 360 * angular.length))];
    const r = radial[Math.min(radial.length - 1, Math.floor(Math.hypot(die.xMm, die.yMm) / radius * radial.length))];
    for (const bin of [a, r]) {
      if (die.bin === 'untested') bin.untested++;
      else { bin.tested++; if (isFailure(die) && (defect === 'all' || die.bin === defect)) bin.failures++; }
    }
  }
  for (const bin of [...angular, ...radial]) bin.rate = bin.tested ? bin.failures / bin.tested * 100 : null;
  return { angular, radial, radius };
}

export function quantile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), position = Math.max(0, Math.min(1, p)) * (sorted.length - 1);
  const lo = Math.floor(position), hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}
export interface ChamberBox { id: string; count: number; missing: number; min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null; lowWhisker: number | null; highWhisker: number | null; outlierCount: number; outliers: number[] }
export function chamberBoxes(dies: readonly WaferDie[]): ChamberBox[] {
  return [...new Set(dies.map(d => d.chamber))].sort().map(id => {
    const population = dies.filter(d => d.chamber === id && d.bin !== 'excluded'), values = population.flatMap(d => d.leakageNA === null ? [] : [d.leakageNA]).sort((a, b) => a - b);
    const q1 = quantile(values, .25), median = quantile(values, .5), q3 = quantile(values, .75);
    if (q1 === null || median === null || q3 === null) return { id, count: 0, missing: population.length, min: null, q1: null, median: null, q3: null, max: null, lowWhisker: null, highWhisker: null, outlierCount: 0, outliers: [] };
    const iqr = q3 - q1, included = values.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr), outliers = values.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
    return { id, count: values.length, missing: population.length - values.length, min: values[0], q1, median, q3, max: values.at(-1)!, lowWhisker: included[0], highWhisker: included.at(-1)!, outlierCount: outliers.length, outliers: outliers.slice(-20) };
  });
}
export function chamberRows(frame: RecordFrame | undefined, scale: 'log' | 'linear' = 'log'): ChamberBox[] {
  if (!frame) return [];
  const keys = ['id', 'count', 'missing', 'min', 'q1', 'median', 'q3', 'max', 'lowWhisker', 'highWhisker', 'outlierCount'];
  for (const column of frame.columns) {
    if (!keys.includes(column.key) && !/^outlier([1-9]|1[0-9]|20)$/.test(column.key)) continue;
    const expected = column.key === 'id' ? 'string' : 'number';
    if (column.type !== expected) throw new Error(`${column.key} must have type ${expected}.`);
    if (!['id', 'count', 'missing', 'outlierCount'].includes(column.key) && column.unit && column.unit !== 'nA') throw new Error('Chamber distributions require nA measurements.');
  }
  const seen = new Set<string>();
  return recordObjects(frame, keys, 1000).map(row => {
    const id = text(row.id, 'Chamber');
    if (seen.has(id)) throw new Error('Duplicate chamber summary.'); seen.add(id);
    const count = whole(row.count, 'Observed count'), missing = whole(row.missing, 'Missing count'), outlierCount = whole(row.outlierCount, 'Outlier count');
    if (count < 0 || missing < 0 || outlierCount < 0 || outlierCount > count) throw new Error('Chamber counts must be nonnegative and consistent.');
    const values = ['min', 'q1', 'median', 'q3', 'max', 'lowWhisker', 'highWhisker'].map(key => row[key] === null ? null : nonnegative(row[key], key));
    const [min, q1, median, q3, max, lowWhisker, highWhisker] = values;
    const outliers = Array.from({ length: 20 }, (_, i) => row[`outlier${i + 1}`]).flatMap(v => v === undefined || v === null ? [] : [nonnegative(v, 'Outlier')]);
    if (count === 0) {
      if (values.some(v => v !== null) || outliers.length || outlierCount) throw new Error('An empty chamber has no numerical distribution.');
    } else {
      if (values.some(v => v === null)) throw new Error('A populated chamber needs all distribution values.');
      if (!(min! <= lowWhisker! && lowWhisker! <= q1! && q1! <= median! && median! <= q3! && q3! <= highWhisker! && highWhisker! <= max!)) throw new Error('Chamber quartiles and whiskers must be ordered.');
      if (scale === 'log' && min! <= 0) throw new Error('Log leakage needs strictly positive observations; use linear scale for a measured zero.');
      if (outliers.length > outlierCount || outliers.some(v => v < min! || v > max! || v >= lowWhisker! && v <= highWhisker!)) throw new Error('Outlier marks must agree with their population and whiskers.');
    }
    return { id, count, missing, min, q1, median, q3, max, lowWhisker, highWhisker, outlierCount, outliers };
  });
}

export function processSteps(die: WaferDie) {
  const start = die.processStart;
  return [
    { id: 'deposition', label: 'Deposition', tool: 'P-101', time: start, value: die.depositionNm, unit: 'nm' },
    { id: 'lithography', label: 'Lithography', tool: 'L-201', time: die.lithographyAt, value: die.lithographyDose, unit: 'mJ/cm²' },
    { id: 'etch', label: 'Etch', tool: `E-305 · ${die.chamber}`, time: die.etchAt, value: die.etchSeconds, unit: 's' },
    { id: 'clean', label: 'Clean', tool: 'CL-410', time: die.cleanAt, value: die.cleanPpm, unit: 'ppm' },
    { id: 'test', label: 'Electrical test', tool: 'T-501', time: die.probeAt, value: die.leakageNA, unit: 'nA' },
  ];
}

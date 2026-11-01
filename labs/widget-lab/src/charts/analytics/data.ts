import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';

const field = z.string().min(1).max(80);
export const cohortConfig = z.strictObject({ cohort: field.default('cohort'), week: field.default('week'), size: field.default('size'), retained: field.default('retained'), observed: field.default('observed'), showValues: z.boolean().default(true), selectedCohort: z.string().max(80).default('') });
export const countConfig = z.strictObject({ label: field.default('label'), count: field.default('count'), showValues: z.boolean().default(true) });
export const flowConfig = z.strictObject({ source: field.default('source'), stage: field.default('stage'), outcome: field.default('outcome'), count: field.default('count'), sourceTitle: field.default('Start'), stageTitle: field.default('First action'), outcomeTitle: field.default('Outcome') });
export const controlConfig = z.strictObject({ sample: field.default('sample'), mean: field.default('mean'), range: field.default('range'), center: z.number().finite().default(25), lower: z.number().finite().default(24.976), upper: z.number().finite().default(25.024), rangeUpper: z.number().positive().default(.032), showRange: z.boolean().default(true) }).refine(c => c.lower < c.center && c.center < c.upper, { message: 'Control limits must bracket the centre.' });
export const distributionConfig = z.strictObject({ group: field.default('group'), value: field.default('value'), mode: z.enum(['histogram', 'violin', 'ridge']).default('histogram'), bins: z.number().int().min(8).max(60).default(24), lowerSpec: z.number().finite().optional(), upperSpec: z.number().finite().optional(), selectedGroup: z.string().max(80).default('') }).refine(c => c.lowerSpec === undefined || c.upperSpec === undefined || c.lowerSpec < c.upperSpec, { message: 'Specification limits must be ordered.' });
export const intervalConfig = z.strictObject({ label: field.default('label'), group: field.default('group'), estimate: field.default('estimate'), lower: field.default('lower'), upper: field.default('upper'), innerLower: field.default('innerLower'), innerUpper: field.default('innerUpper'), samples: field.default('samples'), showValues: z.boolean().default(true), selectedLabel: z.string().max(120).default('') });

export function recordObjects(frame: RecordFrame, required: string[], max = 20000) {
  if (frame.rows.length > max) throw new Error('Too many observations; aggregate explicitly before rendering.');
  const keys = frame.columns.map(c => c.key);
  if (new Set(keys).size !== keys.length) throw new Error('Column identities must be unique.');
  required.forEach(key => { if (!keys.includes(key)) throw new Error('Missing chart column: ' + key); });
  return frame.rows.map(row => Object.fromEntries(keys.map((key, i) => [key, row[i]])) as Record<string, string | number | boolean | null>);
}
const number = (v: unknown, nullable = false): number | null => { if (nullable && v === null) return null; if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Expected finite numerical observations.'); return v; };
const identity = (v: unknown) => { if (typeof v !== 'string' || !v.trim()) throw new Error('Expected a nonempty record identity.'); return v; };
const integer = (v: unknown) => { const n = number(v)!; if (!Number.isInteger(n) || n < 0) throw new Error('Counts and ages must be nonnegative integers.'); return n; };
export interface CohortCell { id: string; cohort: string; week: number; size: number; retained: number | null; observed: boolean; percent: number | null }
export function cohortCells(frame: RecordFrame, c = cohortConfig.parse({})) {
  const seen = new Set<string>();
  const cells = recordObjects(frame, [c.cohort, c.week, c.size, c.retained, c.observed], 1500).map(r => {
    const cohort = identity(r[c.cohort]), week = integer(r[c.week]), size = integer(r[c.size]), observed = r[c.observed], retained = number(r[c.retained], true);
    if (typeof observed !== 'boolean' || week > 52 || size === 0 || retained !== null && (!Number.isInteger(retained) || retained < 0 || retained > size) || !observed && retained !== null) throw new Error('Invalid cohort population, retained count, or future observation.');
    const id = cohort + ':' + week; if (seen.has(id)) throw new Error('Duplicate cohort age.'); seen.add(id);
    return { id, cohort, week, size, retained, observed, percent: retained === null ? null : retained / size * 100 };
  });
  const cohorts = [...new Set(cells.map(c => c.cohort))], weeks = [...new Set(cells.map(c => c.week))].sort((a, b) => a - b);
  if (cohorts.length > 30) throw new Error('Cohort matrices support up to 30 cohorts.');
  cohorts.forEach(cohort => { if (new Set(cells.filter(c => c.cohort === cohort).map(c => c.size)).size !== 1) throw new Error('A cohort must retain one denominator across ages.'); });
  return { cells, cohorts, weeks };
}
export interface CountRow { label: string; count: number; share: number; cumulative: number }
export function countRows(frame: RecordFrame, c = countConfig.parse({}), mode: 'funnel' | 'pareto' = 'funnel') {
  const rows = recordObjects(frame, [c.label, c.count], 30).map(r => ({ label: identity(r[c.label]), count: integer(r[c.count]) }));
  if (new Set(rows.map(r => r.label)).size !== rows.length) throw new Error('Stage labels must be unique.');
  if (mode === 'pareto') rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (mode === 'funnel' && rows.some((row, i) => i > 0 && row.count > rows[i - 1].count)) throw new Error('A fixed-cohort funnel cannot grow between stages.');
  const total = mode === 'pareto' ? rows.reduce((n, r) => n + r.count, 0) : rows[0]?.count ?? 0; let sum = 0;
  return { total, rows: rows.map(r => { sum += r.count; return { ...r, share: total ? r.count / total * 100 : 0, cumulative: total ? sum / total * 100 : 0 }; }) };
}
export function stageFlow(frame: RecordFrame, c = flowConfig.parse({})) {
  const rows = recordObjects(frame, [c.source, c.stage, c.outcome, c.count], 100).map(r => ({ source: identity(r[c.source]), stage: identity(r[c.stage]), outcome: identity(r[c.outcome]), count: integer(r[c.count]) }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const columns = (['source', 'stage', 'outcome'] as const).map(key => [...new Set(rows.map(r => r[key]))].map(label => ({ label, count: rows.filter(r => r[key] === label).reduce((sum, r) => sum + r.count, 0) })));
  if (columns.some(column => column.length > 8)) throw new Error('Stage flows support at most eight nodes per stage.');
  const links = ([['source', 'stage'], ['stage', 'outcome']] as const).flatMap(([from, to], stage) => columns[stage].flatMap(a => columns[stage + 1].map(b => ({ id: stage + ':' + a.label + ':' + b.label, stage, from: a.label, to: b.label, count: rows.filter(r => r[from] === a.label && r[to] === b.label).reduce((sum, r) => sum + r.count, 0) }))).filter(link => link.count > 0));
  return { rows, columns, links, total };
}
export function controlSamples(frame: RecordFrame, c = controlConfig.parse({})) {
  const rows = recordObjects(frame, [c.sample, c.mean, c.range], 2000).map(r => ({ sample: integer(r[c.sample]), mean: number(r[c.mean], true), range: number(r[c.range], true) })).sort((a, b) => a.sample - b.sample);
  if (new Set(rows.map(r => r.sample)).size !== rows.length || rows.some(r => r.range !== null && r.range < 0)) throw new Error('Samples require unique sequence numbers and nonnegative ranges.');
  return rows.map(row => ({ ...row, breach: row.mean === null ? null : row.mean < c.lower || row.mean > c.upper }));
}
export function quantile(sorted: readonly number[], p: number) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
export interface SampleGroup { label: string; values: number[]; missing: number; mean: number | null; q1: number | null; median: number | null; q3: number | null; low: number | null; high: number | null; sd: number | null }
export function sampleGroups(frame: RecordFrame, c = distributionConfig.parse({})): SampleGroup[] {
  const groups = new Map<string, { values: number[]; missing: number }>();
  recordObjects(frame, [c.group, c.value]).forEach(row => { const group = identity(row[c.group]), value = number(row[c.value], true); const entry = groups.get(group) ?? { values: [], missing: 0 }; if (value === null) entry.missing++; else entry.values.push(value); groups.set(group, entry); });
  if (groups.size > 12) throw new Error('Distribution views support at most twelve groups.');
  return [...groups].map(([label, { values, missing }]) => { values.sort((a, b) => a - b); const mean = values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null, sd = mean === null || values.length < 2 ? null : Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1)); return { label, values, missing, mean, sd, q1: quantile(values, .25), median: quantile(values, .5), q3: quantile(values, .75), low: values[0] ?? null, high: values.at(-1) ?? null }; });
}
export function histogram(values: readonly number[], lo: number, hi: number, bins: number) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || !Number.isInteger(bins) || bins < 1) throw new Error('Invalid histogram domain.');
  const width = (hi - lo) / bins, counts = Array.from({ length: bins }, () => 0); let omitted = 0;
  values.forEach(v => { if (!Number.isFinite(v) || v < lo || v > hi) omitted++; else counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++; });
  return { bins: counts.map((count, i) => ({ lower: lo + i * width, upper: lo + (i + 1) * width, count })), omitted };
}
/** Gaussian KDE over supplied samples; bandwidth is explicit and deterministic. */
export function density(group: SampleGroup, lo: number, hi: number, points = 64) {
  const h = Math.max((hi - lo) / 120, 1.06 * (group.sd ?? 0) * Math.max(1, group.values.length) ** -.2);
  return Array.from({ length: points }, (_, i) => { const x = lo + (hi - lo) * i / (points - 1); return { x, density: !group.values.length ? 0 : group.values.reduce((sum, value) => sum + Math.exp(-.5 * ((x - value) / h) ** 2), 0) / (group.values.length * h * Math.sqrt(2 * Math.PI)) }; });
}
export function intervalRows(frame: RecordFrame, c = intervalConfig.parse({})) {
  const seen = new Set<string>();
  return recordObjects(frame, [c.label, c.group, c.estimate, c.lower, c.upper, c.innerLower, c.innerUpper, c.samples], 50).map(r => {
    const label = identity(r[c.label]), group = identity(r[c.group]), estimate = number(r[c.estimate], true), lower = number(r[c.lower], true), upper = number(r[c.upper], true), innerLower = number(r[c.innerLower], true), innerUpper = number(r[c.innerUpper], true), samples = integer(r[c.samples]);
    if (seen.has(label)) throw new Error('Estimate labels must be unique.'); seen.add(label);
    const bounds = [lower, innerLower, estimate, innerUpper, upper];
    if (bounds.some(v => v === null) && !bounds.every(v => v === null)) throw new Error('An unknown interval requires every bound and estimate to be null.');
    if (estimate !== null && (samples === 0 || bounds.some((v, i) => i > 0 && v! < bounds[i - 1]!))) throw new Error('Interval bounds must be nested around the estimate with a nonempty sample population.');
    return { label, group, estimate, lower, upper, innerLower, innerUpper, samples };
  });
}

import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';

const field = z.string().min(1).max(80);
export const waterfallConfig = z.strictObject({ label: field.default('label'), value: field.default('value'), showLabels: z.boolean().default(true), showTotal: z.boolean().default(true) });
export const correlationConfig = z.strictObject({ row: field.default('row'), column: field.default('column'), value: field.default('value'), samples: field.optional(), showValues: z.boolean().default(true) });
export const liquidityConfig = z.strictObject({ bucket: field.default('bucket'), category: field.default('category'), value: field.default('value'), restrictedCategory: field.default('Restricted'), showValues: z.boolean().default(true) });

function column(frame: RecordFrame, key: string, type?: string) {
  const index = frame.columns.findIndex(item => item.key === key);
  if (index < 0) throw new Error(`Missing chart column “${key}”.`);
  if (type && frame.columns[index].type !== type) throw new Error(`Column “${key}” must be ${type}.`);
  return index;
}
function identity(value: unknown) { if (typeof value !== 'string' || !value.trim()) throw new Error('Chart identities must be nonempty strings.'); return value; }
function number(value: unknown) { if (value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Chart values must be finite numbers or null.'); return value; }

export interface WaterfallStep { id: string; label: string; value: number | null; start: number | null; end: number | null; total: boolean }
export function waterfallSteps(frame: RecordFrame, config: z.infer<typeof waterfallConfig>) {
  const li = column(frame, config.label), vi = column(frame, config.value, 'number'), seen = new Set<string>();
  if (frame.rows.length > 30) throw new Error('A contribution waterfall supports at most 30 rows; aggregate the source explicitly.');
  let running: number | null = 0;
  const steps: WaterfallStep[] = frame.rows.map(row => {
    const label = identity(row[li]); if (seen.has(label)) throw new Error('Contribution identities must be unique.'); seen.add(label);
    const value = number(row[vi]), start: number | null = running;
    const end: number | null = running === null || value === null ? null : running + value; running = end;
    return { id: `contribution:${label}`, label, value, start, end, total: false };
  });
  if (steps.length && config.showTotal) steps.push({ id: '__total__', label: 'Total', value: running, start: 0, end: running, total: true });
  return { steps, total: running, incomplete: running === null };
}

export interface CorrelationCell { id: string; row: string; column: string; value: number | null; samples: number | null }
export function correlationCells(frame: RecordFrame, config: z.infer<typeof correlationConfig>) {
  const ri = column(frame, config.row), ci = column(frame, config.column), vi = column(frame, config.value, 'number'), si = config.samples ? column(frame, config.samples, 'number') : -1;
  const map = new Map<string, CorrelationCell>(), names = new Set<string>();
  for (const row of frame.rows) {
    const a = identity(row[ri]), b = identity(row[ci]), value = number(row[vi]);
    if (value !== null && (value < -1 || value > 1)) throw new Error('Correlation values must lie between −1 and 1.');
    if (a === b && value !== null && Math.abs(value - 1) > 1e-8) throw new Error('An observed correlation diagonal must equal 1.');
    const id = JSON.stringify([a, b]); if (map.has(id)) throw new Error('Correlation pairs must be unique.');
    const samples = si >= 0 ? number(row[si]) : null;
    if (samples !== null && (!Number.isInteger(samples) || samples < 0)) throw new Error('Paired sample counts must be nonnegative integers.');
    map.set(id, { id, row: a, column: b, value, samples }); names.add(a); names.add(b);
  }
  if (names.size > 20) throw new Error('A correlation matrix supports at most 20 assets.');
  const labels = [...names];
  const cells = labels.flatMap(a => labels.map(b => map.get(JSON.stringify([a, b])) ?? { id: JSON.stringify([a, b]), row: a, column: b, value: null, samples: null }));
  for (const cell of cells) {
    const counterpart = cells.find(other => other.row === cell.column && other.column === cell.row)!;
    if ((cell.value === null) !== (counterpart.value === null) || cell.value !== null && counterpart.value !== null && Math.abs(cell.value - counterpart.value) > 1e-8) throw new Error('A correlation matrix must be symmetric, including unknown pairs.');
  }
  return { labels, cells };
}

export interface LiquiditySegment { id: string; bucket: string; category: string; value: number | null; start: number | null; end: number | null }
export function liquiditySegments(frame: RecordFrame, config: z.infer<typeof liquidityConfig>) {
  const bi = column(frame, config.bucket), ci = column(frame, config.category), vi = column(frame, config.value, 'number'), seen = new Set<string>();
  const parsed = frame.rows.map(row => { const bucket = identity(row[bi]), category = identity(row[ci]), value = number(row[vi]), id = JSON.stringify([bucket, category]); if (seen.has(id)) throw new Error('Liquidity bucket/category pairs must be unique.'); seen.add(id); if (value !== null && value < 0) throw new Error('Liquidity magnitude must be nonnegative.'); return { id, bucket, category, value }; });
  const buckets = [...new Set(parsed.map(row => row.bucket))], categories = [...new Set(parsed.map(row => row.category))].sort();
  if (buckets.length > 20 || categories.length > 10) throw new Error('Liquidity charts support 20 buckets and 10 categories.');
  const groups = buckets.map(bucket => {
    let running: number | null = 0;
    const segments: LiquiditySegment[] = categories.map(category => { const source = parsed.find(row => row.bucket === bucket && row.category === category), value = source?.value ?? null, start: number | null = running; const end: number | null = running === null || value === null ? null : running + value; running = end; return { id: JSON.stringify([bucket, category]), bucket, category, value, start, end }; });
    return { bucket, total: running, segments };
  });
  return { groups, categories, total: groups.some(group => group.total === null) ? null : groups.reduce((sum, group) => sum + group.total!, 0) };
}

export function correlationColor(value: number | null) {
  if (value === null) return '#354a56';
  const neutral = [16, 43, 56], endpoint = value < 0 ? [171, 78, 97] : [0, 178, 218], amount = Math.abs(value);
  return `rgb(${neutral.map((c, i) => Math.round(c + (endpoint[i] - c) * amount)).join(',')})`;
}

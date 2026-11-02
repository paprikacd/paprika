import { z } from 'zod';
import type { RecordFrame } from '@insights/schema';

const field = z.string().min(1).max(80);
export const rackMatrixConfig = z.strictObject({ id: field.default('id'), rack: field.default('rack'), slot: field.default('slot'), value: field.default('utilization'), showLabels: z.boolean().default(true), showDetails: z.boolean().default(true), initialSelection: z.string().max(80).default('') });
export const requestFlowConfig = z.strictObject({ source: field.default('region'), stage: field.default('model'), target: field.default('outcome'), value: field.default('requests'), showValues: z.boolean().default(true) });
export const logScatterConfig = z.strictObject({ id: field.default('id'), x: field.default('throughput'), y: field.default('ttft'), group: field.default('model'), timestamp: field.default('timestamp'), pointRadius: z.number().min(1).max(8).default(2.4), showLegend: z.boolean().default(true) });

export function columnIndex(frame: RecordFrame, key: string, numeric = false) {
  const index = frame.columns.findIndex(column => column.key === key);
  if (index < 0) throw new Error(`Missing column “${key}”.`);
  if (numeric && frame.columns[index].type !== 'number') throw new Error(`Column “${key}” must be numeric.`);
  return index;
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export type RackCell = { id: string; rack: string; slot: string; value: number | null; metadata: Record<string, string | number | boolean | null>; history: Array<number | null> };
export function buildRackMatrix(frame: RecordFrame, config: z.infer<typeof rackMatrixConfig>) {
  const id = columnIndex(frame, config.id), rack = columnIndex(frame, config.rack), slot = columnIndex(frame, config.slot), value = columnIndex(frame, config.value, true);
  const history = frame.columns.map((c, index) => ({ key: c.key, index })).filter(c => /^history_\d+$/.test(c.key)).sort((a, b) => a.key.localeCompare(b.key));
  const seen = new Set<string>(), positions = new Set<string>(), cells: RackCell[] = [];
  let omitted = 0;
  for (const row of frame.rows.slice(0, 1024)) {
    if (row[id] == null || row[rack] == null || row[slot] == null || !String(row[id])) { omitted++; continue; }
    const identity = String(row[id]), position = JSON.stringify([row[rack], row[slot]]);
    if (seen.has(identity) || positions.has(position)) throw new Error('Rack cells require unique device IDs and rack/slot positions.');
    if (row[value] !== null && (!finite(row[value]) || row[value] < 0 || row[value] > 100)) { omitted++; continue; }
    seen.add(identity); positions.add(position);
    cells.push({ id: identity, rack: String(row[rack]), slot: String(row[slot]), value: row[value] as number | null, metadata: Object.fromEntries(frame.columns.filter(c => !/^history_\d+$/.test(c.key)).map(c => [c.key, row[columnIndex(frame, c.key)]])), history: history.map(c => finite(row[c.index]) ? row[c.index] as number : null) });
  }
  return { cells, racks: [...new Set(cells.map(c => c.rack))].sort(), slots: [...new Set(cells.map(c => c.slot))].sort(), omitted: omitted + Math.max(0, frame.rows.length - 1024) };
}
export const inferenceColors = ['var(--gamma-chart-1)', 'var(--gamma-chart-2)', 'var(--gamma-chart-5)', 'var(--gamma-chart-3)', 'var(--gamma-chart-4)', 'var(--gamma-chart-6)'];
export function semanticColor(name: string) {
  const names = ['llama-3-70b', 'mixtral-8x22b', 'phi-3-mini', 'gemma-7b', 'qwen-72b', 'claude-3-haiku'];
  const known = names.indexOf(name); if (known >= 0) return inferenceColors[known];
  let hash = 0; for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return inferenceColors[hash % inferenceColors.length];
}
/** Utilisation below 75 percent is an intensity on the density ramp (zero is the empty fill); 75 to 90 is warning and above 90 is danger. */
export function utilizationColor(value: number | null) { return value === null ? 'var(--gamma-chart-empty)' : value > 90 ? 'var(--gamma-danger)' : value > 75 ? 'var(--gamma-warning)' : value <= 0 ? 'var(--gamma-chart-empty)' : `var(--gamma-density-${Math.min(23, Math.round(value / 75 * 23))})`; }
export type FlowEdge = { id: string; source: string; target: string; value: number; stage: 0 | 1; group: string };
export function buildRequestFlow(frame: RecordFrame, config: z.infer<typeof requestFlowConfig>) {
  const a = columnIndex(frame, config.source), b = columnIndex(frame, config.stage), c = columnIndex(frame, config.target), v = columnIndex(frame, config.value, true);
  const groups: Array<Map<string, number>> = [new Map(), new Map(), new Map()], links = new Map<string, FlowEdge>(); let total = 0, omitted = 0;
  for (const row of frame.rows.slice(0, 2000)) {
    if ([row[a], row[b], row[c]].some(x => x == null || String(x).trim() === '') || !finite(row[v]) || row[v] < 0) { omitted++; continue; }
    const values = [String(row[a]), String(row[b]), String(row[c])], value = row[v] as number; total += value;
    values.forEach((name, i) => groups[i].set(name, (groups[i].get(name) ?? 0) + value));
    for (const stage of [0, 1] as const) {
      const id = JSON.stringify([stage, values[stage], values[stage + 1]]);
      const existing = links.get(id);
      if (existing) existing.value += value;
      else links.set(id, { id, source: values[stage], target: values[stage + 1], value, stage, group: values[1] });
    }
  }
  if (groups.some(group => group.size > 24)) throw new Error('Request flow supports at most 24 entities in each stage.');
  return { total, groups: groups.map(group => [...group.entries()].map(([name, value]) => ({ name, value }))), links: [...links.values()], omitted: omitted + Math.max(0, frame.rows.length - 2000) };
}
export type ScatterPoint = { id: string; x: number; y: number; group: string; timestamp: number | null };
export function buildLogScatter(frame: RecordFrame, config: z.infer<typeof logScatterConfig>) {
  const id = columnIndex(frame, config.id), x = columnIndex(frame, config.x, true), y = columnIndex(frame, config.y, true), group = columnIndex(frame, config.group), time = columnIndex(frame, config.timestamp);
  const seen = new Set<string>(), points: ScatterPoint[] = []; let omitted = 0;
  for (const row of frame.rows.slice(0, 2000)) {
    if (row[id] == null || row[group] == null || !finite(row[x]) || !finite(row[y]) || row[x] <= 0 || row[y] <= 0) { omitted++; continue; }
    if (seen.has(String(row[id]))) throw new Error('Scatter observations require unique IDs.');
    seen.add(String(row[id]));
    const timestamp = finite(row[time]) && Number.isFinite(new Date(row[time] as number).getTime()) ? row[time] as number : typeof row[time] === 'string' && Number.isFinite(Date.parse(row[time])) ? Date.parse(row[time]) : null;
    points.push({ id: String(row[id]), x: row[x] as number, y: row[y] as number, group: String(row[group]), timestamp });
  }
  const extent = (values: number[]): [number, number] => [10 ** Math.floor(Math.log10(Math.min(...values))), 10 ** Math.ceil(Math.log10(Math.max(...values)))];
  const xDomain = points.length ? extent(points.map(p => p.x)) : [1, 10] as [number, number], yDomain = points.length ? extent(points.map(p => p.y)) : [1, 10] as [number, number];
  if (xDomain[0] === xDomain[1]) xDomain[1] *= 10; if (yDomain[0] === yDomain[1]) yDomain[1] *= 10;
  return { points, xDomain, yDomain, groups: [...new Set(points.map(p => p.group))], omitted: omitted + Math.max(0, frame.rows.length - 2000) };
}

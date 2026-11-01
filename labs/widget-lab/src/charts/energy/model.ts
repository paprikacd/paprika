import { z } from 'zod';
import type { RecordFrame } from '../../vendor/paprika/ui/src/features/insights/schema';

const field = (name: string) => z.string().trim().min(1).max(80).default(name);
export const powerFlowConfig = z.strictObject({ valueField: field('power'), labelField: field('label'), showValues: z.boolean().default(true), selectedAsset: z.string().max(80).default('battery') });
export const contingencyConfig = z.strictObject({ showValues: z.boolean().default(true), warning: z.number().min(1).max(150).default(80), selectedAsset: z.string().max(80).default('battery'), selectedScenario: z.string().max(80).default('Base') });
export const flexibilityConfig = z.strictObject({ showEnergy: z.boolean().default(true), selectedTime: z.number().finite().optional() });
export const meritConfig = z.strictObject({ showLabels: z.boolean().default(true), selectedAsset: z.string().max(80).default('battery') });

export type PowerNode = { id: string; label: string; side: 'source' | 'load'; power: number; available: number; price: number; energy: number | null; capacity: number | null };
export type FlexPoint = { id: string; timestamp: number; power: number | null; energy: number | null; capacity: number; predicted: boolean };
export type ContingencyCell = { id: string; asset: string; label: string; scenario: string; loading: number | null };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
function columns(frame: RecordFrame, names: string[]) {
  const map: Record<string, number> = {};
  for (const name of names) {
    const index = frame.columns.findIndex(c => c.key === name);
    if (index < 0) throw new Error(`Missing required field “${name}”. Choose an existing source column.`);
    map[name] = index;
  }
  return map;
}
function numeric(frame: RecordFrame, key: string, index: number) {
  if (frame.columns[index].type !== 'number') throw new Error(`Field “${key}” must be numeric.`);
}
function typed(frame: RecordFrame, index: number, type: 'string' | 'boolean') {
  if (frame.columns[index].type !== type) throw new Error(`Field “${frame.columns[index].key}” must declare ${type} values.`);
}
function unit(frame: RecordFrame, index: number, expected: string) {
  if (frame.columns[index].unit !== expected) throw new Error(`Field “${frame.columns[index].key}” must declare ${expected} units. Convert the source before plotting.`);
}

export function powerNodes(frame: RecordFrame, config: z.input<typeof powerFlowConfig> = {}) {
  const c = powerFlowConfig.parse(config), keys = ['id', c.labelField, 'side', c.valueField, 'available', 'price', 'energy', 'capacity'];
  const idx = columns(frame, keys);
  for (const key of [c.valueField, 'available', 'price', 'energy', 'capacity']) numeric(frame, key, idx[key]);
  for (const key of ['id', c.labelField, 'side']) typed(frame, idx[key], 'string');
  for (const [key, expected] of [[c.valueField, 'MW'], ['available', 'MW'], ['price', '$/MWh'], ['energy', 'MWh'], ['capacity', 'MWh']]) unit(frame, idx[key], expected);
  const seen = new Set<string>();
  const nodes: PowerNode[] = frame.rows.map(row => {
    const id = row[idx.id], label = row[idx[c.labelField]], side = row[idx.side], power = row[idx[c.valueField]], available = row[idx.available], price = row[idx.price];
    const energy = row[idx.energy], capacity = row[idx.capacity];
    if (typeof id !== 'string' || !id || seen.has(id)) throw new Error('Power flow requires unique nonempty asset IDs.');
    seen.add(id);
    if (typeof label !== 'string' || !label || side !== 'source' && side !== 'load') throw new Error('Power flow needs a label and source/load side for every row.');
    if (!finite(power) || power < 0 || !finite(available) || available < 0 || !finite(price)) throw new Error('Power, available capacity and marginal price must be finite; power and capacity cannot be negative.');
    if (side === 'source' && power > available + 1e-7) throw new Error(`Dispatch exceeds the available capacity of ${label}.`);
    if (energy !== null && (!finite(energy) || energy < 0) || capacity !== null && (!finite(capacity) || capacity <= 0)) throw new Error('Storage energy requires nonnegative MWh and positive capacity MWh.');
    if (energy !== null && capacity !== null && Number(energy) > Number(capacity)) throw new Error('Stored energy exceeds storage capacity.');
    if ((energy === null) !== (capacity === null)) throw new Error('Stored energy and storage capacity must be supplied together, or both remain null.');
    return { id, label, side, power, available, price, energy: energy as number | null, capacity: capacity as number | null };
  });
  const sources = nodes.filter(n => n.side === 'source'), loads = nodes.filter(n => n.side === 'load');
  const input = sources.reduce((a, n) => a + n.power, 0), output = loads.reduce((a, n) => a + n.power, 0);
  if (Math.abs(input - output) > Math.max(1, input) * 1e-8) throw new Error('Power-flow inputs and outputs must reconcile, including losses.');
  return { nodes, sources, loads, total: input, available: sources.reduce((a, n) => a + n.available, 0), reserve: sources.reduce((a, n) => a + n.available - n.power, 0) };
}

export function contingencyCells(frame: RecordFrame): ContingencyCell[] {
  const idx = columns(frame, ['asset', 'label', 'scenario', 'loading']); numeric(frame, 'loading', idx.loading);
  for (const key of ['asset', 'label', 'scenario']) typed(frame, idx[key], 'string');
  unit(frame, idx.loading, '%');
  const seen = new Set<string>();
  return frame.rows.map(row => {
    const asset = row[idx.asset], label = row[idx.label], scenario = row[idx.scenario], loading = row[idx.loading];
    if (typeof asset !== 'string' || typeof label !== 'string' || typeof scenario !== 'string') throw new Error('Contingency rows require asset, label and scenario strings.');
    const id = `${asset}:${scenario}`;
    if (seen.has(id)) throw new Error('Each asset/scenario pair must be unique.'); seen.add(id);
    if (loading !== null && (!finite(loading) || loading < 0)) throw new Error('Loading is a nonnegative percentage, or null when not simulated.');
    return { id, asset, label, scenario, loading: loading as number | null };
  });
}

export function flexibilityPoints(frame: RecordFrame): FlexPoint[] {
  const idx = columns(frame, ['timestamp', 'power', 'energy', 'capacity', 'predicted']);
  for (const key of ['timestamp', 'power', 'energy', 'capacity']) numeric(frame, key, idx[key]);
  typed(frame, idx.predicted, 'boolean');
  for (const [key, expected] of [['timestamp', 'ms'], ['power', 'MW'], ['energy', 'MWh'], ['capacity', 'MWh']]) unit(frame, idx[key], expected);
  const seen = new Set<number>();
  const result = frame.rows.map(row => {
    const timestamp = row[idx.timestamp], power = row[idx.power], energy = row[idx.energy], capacity = row[idx.capacity], predicted = row[idx.predicted];
    if (!finite(timestamp) || timestamp < 0 || timestamp > 8640000000000000 || seen.has(timestamp)) throw new Error('Dispatch timestamps must be valid, unique epoch milliseconds.'); seen.add(timestamp);
    if (!finite(capacity) || capacity <= 0 || typeof predicted !== 'boolean') throw new Error('Storage capacity and predicted/observed status are required.');
    if (power !== null && !finite(power) || energy !== null && (!finite(energy) || energy < 0 || energy > capacity)) throw new Error('Dispatch power must be finite; stored energy must remain within capacity.');
    return { id: String(timestamp), timestamp, power: power as number | null, energy: energy as number | null, capacity, predicted };
  });
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

export function meritOrder(nodes: PowerNode[]) {
  let cumulative = 0;
  return nodes.filter(n => n.side === 'source').sort((a, b) => a.price - b.price || a.id.localeCompare(b.id)).map(node => {
    const start = cumulative; cumulative += node.available;
    return { ...node, start, end: cumulative };
  });
}

export function flowSegments(nodes: PowerNode[], height: number, gap: number, total: number) {
  const useful = Math.max(1, height - Math.max(0, nodes.length - 1) * gap);
  const scale = total > 0 ? useful / total : 0;
  let y = 0, bus = 0;
  return nodes.map(node => { const segment = { ...node, y, bus, height: node.power * scale }; y += segment.height + gap; bus += segment.height; return segment; });
}

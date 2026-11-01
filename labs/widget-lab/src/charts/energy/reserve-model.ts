import { z } from 'zod';
import type { RecordFrame } from '../../vendor/paprika/ui/src/features/insights/schema';
import { parseRecordFrame } from '../../vendor/paprika/ui/src/features/insights/record-data';

const field = (name: string) => z.string().trim().min(1).max(80).default(name);
const optionalField = (name: string) => z.string().trim().max(80).default(name);
export const reserveEnvelopeConfig = z.strictObject({
  timeField: field('timestamp'), capacityField: field('capacity'), observedField: field('observed'), medianField: field('median'),
  low95Field: field('low95'), high95Field: field('high95'),
  low68Field: optionalField('low68'), high68Field: optionalField('high68'),
  threshold: z.number().finite().min(-1_000_000).max(1_000_000).default(0),
  show68: z.boolean().default(true), show95: z.boolean().default(true), showControls: z.boolean().default(true),
  selectedTime: z.number().finite().min(0).max(8_640_000_000_000_000).optional(),
});

export interface ReservePoint {
  id: string; timestamp: number; capacity: number | null;
  observedDemand: number | null; medianDemand: number | null;
  observedReserve: number | null; medianReserve: number | null;
  low68: number | null; high68: number | null; low95: number | null; high95: number | null;
}

/** Capacity is treated as a supplied value, not an uncertain estimate.
 * Subtraction reverses interval endpoints: [capacity - demandHigh, capacity - demandLow].
 */
export function reserveEnvelopePoints(frame: RecordFrame, input: z.input<typeof reserveEnvelopeConfig> = {}): ReservePoint[] {
  const c = reserveEnvelopeConfig.parse(input);
  parseRecordFrame(frame);
  if (!!c.low68Field !== !!c.high68Field) throw new Error('Bind both 68% interval fields, or leave both unbound.');
  const keyIndex = (key: string, expectedUnit: string) => {
    const index = frame.columns.findIndex(column => column.key === key);
    if (index < 0) throw new Error(`Missing reserve field “${key}”. Choose an existing source column.`);
    const column = frame.columns[index];
    if (column.type !== 'number') throw new Error(`Reserve field “${key}” must declare number values.`);
    if (column.unit !== expectedUnit) throw new Error(`Reserve field “${key}” must declare ${expectedUnit} units. Convert the source explicitly.`);
    return index;
  };
  const index = {
    time: keyIndex(c.timeField, 'ms'), capacity: keyIndex(c.capacityField, 'MW'),
    observed: keyIndex(c.observedField, 'MW'), median: keyIndex(c.medianField, 'MW'),
    low95: keyIndex(c.low95Field, 'MW'), high95: keyIndex(c.high95Field, 'MW'),
    low68: c.low68Field ? keyIndex(c.low68Field, 'MW') : null, high68: c.high68Field ? keyIndex(c.high68Field, 'MW') : null,
  };
  const seen = new Set<number>();
  const points = frame.rows.map(row => {
    const timestamp = row[index.time];
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000 || seen.has(timestamp)) throw new Error('Reserve timestamps must be valid, unique epoch milliseconds.');
    seen.add(timestamp);
    const power = (column: number | null) => {
      if (column === null) return null;
      const value = row[column];
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Reserve source “${frame.columns[column].key}” requires nonnegative MW or null.`);
      return value;
    };
    const capacity = power(index.capacity), observedDemand = power(index.observed), medianDemand = power(index.median);
    const low95 = power(index.low95), high95 = power(index.high95), low68 = power(index.low68), high68 = power(index.high68);
    for (const [name, lower, upper] of [['95%', low95, high95], ['68%', low68, high68]] as const) {
      if ((lower === null) !== (upper === null)) throw new Error(`The ${name} demand interval requires both bounds, or two nulls.`);
      if (lower !== null && (medianDemand === null || lower > medianDemand || medianDemand > upper!)) throw new Error(`The ${name} demand interval must contain its supplied median.`);
    }
    if (low68 !== null && low95 !== null && (low95 > low68 || high68! > high95!)) throw new Error('The 68% demand interval must stay inside the 95% interval.');
    const subtract = (demand: number | null) => capacity === null || demand === null ? null : capacity - demand;
    return { id: String(timestamp), timestamp, capacity, observedDemand, medianDemand, observedReserve: subtract(observedDemand), medianReserve: subtract(medianDemand), low68: subtract(high68), high68: subtract(low68), low95: subtract(high95), high95: subtract(low95) };
  });
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

export function reserveExtent(points: readonly ReservePoint[], threshold = 0): [number, number] {
  if (!Number.isFinite(threshold)) throw new Error('Reserve threshold must be finite.');
  const values = [0, threshold, ...points.flatMap(point => [point.observedReserve, point.medianReserve, point.low68, point.high68, point.low95, point.high95].filter((value): value is number => value !== null))];
  const minimum = Math.min(...values), maximum = Math.max(...values), padding = Math.max(1, (maximum - minimum) * .08);
  return [minimum - padding, maximum + padding];
}

import type { QueryResult, RecordFrame, Widget } from '../renderer-extensions/schema';
import type { WidgetConfigField, WidgetDefinition } from '../renderer-extensions/widget-registry';

export type DiscoveredField = RecordFrame['columns'][number] & {
  observations: number;
  missing: number;
  distinct: number;
  samples: (string | number | boolean)[];
  minimum: number | null;
  maximum: number | null;
};
export interface BindingDiagnostic { key: string; message: string; candidates: string[] }

/** Metadata is authoritative for type/unit; values only describe this loaded result. */
export function discoverRecordFields(result: QueryResult): DiscoveredField[] {
  const frame = result.records;
  if (!frame) return [];
  return frame.columns.map((column, index) => {
    const values = frame.rows.map(row => row[index]).filter((value): value is string | number | boolean => value !== null && value !== undefined);
    const unique = [...new Set(values)];
    const numeric = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return { ...column, observations: values.length, missing: frame.rows.length - values.length, distinct: unique.length, samples: unique.slice(0, 3), minimum: numeric.length ? Math.min(...numeric) : null, maximum: numeric.length ? Math.max(...numeric) : null };
  });
}

export function bindingMismatch(field: WidgetConfigField, column: RecordFrame['columns'][number]): string | null {
  const binding = field.binding;
  if (!binding) return null;
  if (!binding.types.includes(column.type)) return `requires ${binding.types.join(' or ')} values; “${column.key}” declares ${column.type}`;
  const units = binding.acceptedUnits ?? (binding.unit ? [binding.unit] : []);
  if (units.length && !units.includes(column.unit ?? '')) return `requires ${units.join(' or ')} units; “${column.key}” declares ${column.unit || 'no unit'}`;
  return null;
}

/** A pure preflight used by guided editing, JSON and the same Apply validation. */
export function validateFieldBindings(definition: WidgetDefinition, config: Widget['config'], result: QueryResult): BindingDiagnostic[] {
  const columns = result.records?.columns ?? [];
  return (definition.configFields ?? []).filter(field => field.binding).flatMap(field => {
    const key = config?.[field.key];
    const candidates = columns.filter(column => !bindingMismatch(field, column)).map(column => column.key);
    if ((key === undefined || key === '') && field.binding?.optional) return [];
    if (typeof key !== 'string' || !key.trim()) return [{ key: field.key, message: `${field.label}: choose a source field.`, candidates }];
    const column = columns.find(column => column.key === key);
    if (!column) return [{ key: field.key, message: `${field.label}: “${key}” is not in the loaded source. Choose an existing source column.`, candidates }];
    const mismatch = bindingMismatch(field, column);
    return mismatch ? [{ key: field.key, message: `${field.label} ${mismatch}.`, candidates }] : [];
  });
}

export function formatFieldSample(value: string | number | boolean): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value.length > 64 ? `${value.slice(0, 61)}…` : value || 'Empty string';
}

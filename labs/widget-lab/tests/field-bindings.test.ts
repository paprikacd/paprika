import { describe, expect, it } from 'vitest';
import { discoverRecordFields, bindingMismatch, validateFieldBindings } from '../src/editor/field-bindings';
import { createEditorDraft, editorVisualizations, reviseEditorDraft, validateEditorWidget } from '../src/editor/editor-model';
import { registerEnergyCharts } from '../src/charts/energy/register';
import { buildGridBalance } from '../src/lenses/energy/fixtures';
import { getWidgetDefinition, getWidgetPlugins, registerWidgetPlugin, type WidgetConfigField, type WidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import type { QueryResult, Widget } from '../src/vendor/paprika/ui/src/features/insights/schema';

const role: WidgetConfigField = { key: 'valueField', label: 'Delivered power', kind: 'text', binding: { types: ['number'], unit: 'MW', role: 'Measured power.' } };
const definition: WidgetDefinition = { id: 'binding-test', type: 'plugin', label: 'Binding test', description: 'Independent binding example', dataKind: 'records', render: () => null, configFields: [role] };
const result: QueryResult = { records: { columns: [
  { key: 'watts', type: 'number', unit: 'W' }, { key: 'delivered', type: 'number', unit: 'MW' },
  { key: 'flag', type: 'boolean' }, { key: 'asset', type: 'string' },
], rows: [[10, 0, false, 'A'], [20, 12.3456789, true, 'B'], [null, null, false, 'A']] } };

describe('source discovery and field role contracts', () => {
  it('preserves source metadata and exact zero, false, precision and null coverage without inference', () => {
    const before = JSON.stringify(result), fields = discoverRecordFields(result);
    expect(fields[1]).toMatchObject({ key: 'delivered', type: 'number', unit: 'MW', missing: 1, observations: 2, distinct: 2, samples: [0, 12.3456789], minimum: 0, maximum: 12.3456789 });
    expect(fields[2].samples).toEqual([false, true]);
    expect(fields[3]).toMatchObject({ distinct: 2, minimum: null, maximum: null });
    expect(JSON.stringify(result)).toBe(before);
  });
  it('retains declared fields for empty data, with no invented samples or ranges', () => {
    const empty = discoverRecordFields({ records: { ...result.records!, rows: [] } });
    expect(empty).toHaveLength(4);
    expect(empty.every(field => field.missing === 0 && field.observations === 0 && field.samples.length === 0 && field.minimum === null)).toBe(true);
    expect(discoverRecordFields({ series: [] })).toEqual([]);
  });
  it('returns a field-associated diagnostic and only repair candidates with the right type and unit', () => {
    const issues = validateFieldBindings(definition, { valueField: 'old_name' }, result);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'valueField', candidates: ['delivered'] });
    expect(issues[0].message).toContain('old_name');
    expect(validateFieldBindings(definition, { valueField: 'delivered' }, result)).toEqual([]);
  });
  it('rejects equal primitive types with incompatible dimensions and never relabels values', () => {
    expect(bindingMismatch(role, result.records!.columns[0])).toContain('requires MW units');
    expect(bindingMismatch(role, result.records!.columns[2])).toContain('requires number');
    expect(validateFieldBindings(definition, { valueField: 'watts' }, result)[0].candidates).toEqual(['delivered']);
    expect(result.records!.rows[0][0]).toBe(10);
  });
  it('accepts only explicitly declared unit aliases', () => {
    const months: WidgetConfigField = { ...role, binding: { types: ['number'], unit: 'months', acceptedUnits: ['month', 'months'] } };
    expect(bindingMismatch(months, { key: 'followup', type: 'number', unit: 'month' })).toBeNull();
    expect(bindingMismatch(months, { key: 'followup', type: 'number', unit: 'days' })).not.toBeNull();
    expect(bindingMismatch(months, { key: 'followup', type: 'number' })).not.toBeNull();
  });
  it('allows an omitted optional binding but validates it when supplied', () => {
    const optional = { ...definition, configFields: [{ ...role, binding: { ...role.binding!, optional: true } }] };
    expect(validateFieldBindings(optional, {}, result)).toEqual([]);
    expect(validateFieldBindings(optional, { valueField: '' }, result)).toEqual([]);
    expect(validateFieldBindings(optional, { valueField: 'unknown' }, result)).toHaveLength(1);
    expect(validateFieldBindings(definition, {}, result)).toHaveLength(1);
  });
  it('does not use field-name guesses to turn ordinary text settings into bindings', () => {
    const ordinary = { ...definition, configFields: [{ key: 'titleField', label: 'Field of study', kind: 'text' as const }] };
    expect(validateFieldBindings(ordinary, { titleField: 'physics' }, result)).toEqual([]);
  });
  it('validates metadata even without a family adapter, retaining the invalid draft and valid preview', () => {
    const { type: _type, ...plugin } = definition;
    const unregister = registerWidgetPlugin({ ...plugin, id: 'binding-edit-check' });
    const widget: Widget = { id: 'independent', type: 'plugin', pluginId: 'binding-edit-check', dataKind: 'records', title: 'Delivery', providerId: 'fixture', query: 'independent', unit: 'MW', config: { valueField: 'delivered' }, layout: { x: 0, y: 0, w: 6, h: 4 } };
    try {
      const initial = createEditorDraft(widget, result);
      const invalid = reviseEditorDraft(initial, { ...widget, config: { valueField: 'watts' } }, 'records', result);
      expect(invalid.preview).toBe(initial.preview);
      expect(invalid.draft.config?.valueField).toBe('watts');
      expect(invalid.errors[0]).toContain('MW units');
      expect(validateEditorWidget(invalid.draft, 'records', result).widget).toBeNull();
      expect(reviseEditorDraft(invalid, widget, 'records', result).errors).toEqual([]);
    } finally { unregister(); }
  });
  it('offers a semantically validated record alternative and excludes an unrelated family', () => {
    registerEnergyCharts();
    const { flow } = buildGridBalance();
    const choices = editorVisualizations(flow.widget, flow.result, getWidgetPlugins());
    expect(choices.some(choice => choice.id === 'dispatch-merit')).toBe(true);
    expect(choices.some(choice => choice.id === 'contingency-matrix')).toBe(false);
    const merit = getWidgetDefinition('plugin', 'dispatch-merit')!;
    expect(merit.validateInput).toBeDefined();
  });
});

import { describe, expect, it } from 'vitest';
import { checkedInput } from '../src/renderer-extensions/input-issues';
import { validateEditorWidget } from '../src/editor/editor-model';
import { getWidgetDefinition, widgetInputIssues } from '@insights/widget-registry';
import { widgetKind, type QueryResult, type Widget } from '@insights/schema';
import { z } from 'zod';
import { registerEnergyCharts } from '../src/charts/energy/register';

describe('validateInput issues', () => {
  it('turns a passing check into no issues and a thrown check into one bounded message', () => {
    expect(checkedInput(() => 1)).toEqual([]);
    expect(checkedInput(() => { throw new Error('Missing reserve field: capacity'); })).toEqual([{ message: 'Missing reserve field: capacity' }]);
    const long = checkedInput(() => { throw new Error('x'.repeat(500)); });
    expect(long[0].message).toHaveLength(240);
  });

  it('names the configuration field a schema failure concerns', () => {
    const schema = z.strictObject({ threshold: z.number().min(0) });
    const [issue] = checkedInput(() => schema.parse({ threshold: -1 }));
    expect(issue.field).toBe('threshold');
    expect(issue.message).not.toMatch(/^\[/);
  });

  it('reports the registry\'s own validateInput message, not a generic one', () => {
    registerEnergyCharts();
    const definition = getWidgetDefinition('plugin', 'reserve-envelope')!;
    const widget: Widget = { id: 'reserve', title: 'Reserve', type: 'plugin', pluginId: 'reserve-envelope', dataKind: 'records',
      providerId: 'fixture', query: 'fixture', unit: 'MW', layout: { x: 0, y: 0, w: 6, h: 4 } };
    const result: QueryResult = {};
    expect(widgetKind(widget)).toBe('records');
    const issues = widgetInputIssues(definition, result, {});
    expect(issues.map(issue => issue.message)).toEqual(['Reserve envelopes require forecast and capacity records.']);
    // The editor runs the field bindings first, so an absent result is reported as unmapped fields before this check runs.
    const validation = validateEditorWidget(widget, 'records', result);
    expect(validation.widget).toBeNull();
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});

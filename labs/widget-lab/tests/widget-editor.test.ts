import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEditorDraft, editorDataTable, editorVisualizations, reviseEditorDraft, travelEditorDraft, validateEditorWidget, visualizationCandidate } from '../src/editor/editor-model';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { getWidgetDefinition, getWidgetPlugins, registerWidgetPlugin, widgetDefinitions } from '@insights/widget-registry';
import type { QueryResult } from '@insights/schema';
import '../src/lenses/FinanceLens';
import { financePanels } from '../src/lenses/finance-data';

registerLabCharts();

describe('chart editor draft and source boundaries', () => {
  it('keeps the last valid preview when a contradictory domain is typed, then recovers without losing the draft', () => {
    const { widget } = makeCatalogFixture('timeseries');
    const initial = createEditorDraft(widget);
    const invalid = reviseEditorDraft(initial, { ...initial.draft, title: 'Investigation', options: { ...initial.draft.options, min: 10, max: 2 } }, 'metrics');
    expect(invalid.errors.join(' ')).toContain('Maximum must be greater');
    expect(invalid.draft.title).toBe('Investigation');
    expect(invalid.preview).toBe(initial.preview);
    expect(validateEditorWidget(invalid.draft, 'metrics').widget).toBeNull();
    const recovered = reviseEditorDraft(invalid, { ...invalid.draft, options: { ...invalid.draft.options, max: 12 } }, 'metrics');
    expect(recovered.errors).toEqual([]);
    expect(recovered.preview.title).toBe('Investigation');
    expect(recovered.preview.options?.max).toBe(12);
    expect(widget.title).toBe('Availability burn rate');
  });

  it('undoes and redoes valid and invalid edits without mutating the original applied widget', () => {
    const { widget } = makeCatalogFixture('timeseries');
    const snapshot = JSON.stringify(widget);
    const original = createEditorDraft(widget);
    const renamed = reviseEditorDraft(original, { ...original.draft, title: 'Selected service' }, 'metrics');
    const invalid = reviseEditorDraft(renamed, { ...renamed.draft, title: '' }, 'metrics');
    const undone = travelEditorDraft(invalid, 'undo', 'metrics');
    expect(undone.draft.title).toBe('Selected service');
    expect(undone.errors).toEqual([]);
    const redone = travelEditorDraft(undone, 'redo', 'metrics');
    expect(redone.draft.title).toBe('');
    expect(redone.errors.length).toBeGreaterThan(0);
    expect(redone.preview.title).toBe('Selected service');
    expect(JSON.stringify(widget)).toBe(snapshot);
  });

  it('validates registered plugin configuration as well as the common widget schema', () => {
    const { widget } = makeCatalogFixture('record-table');
    expect(validateEditorWidget(widget, 'records').widget).not.toBeNull();
    expect(validateEditorWidget({ ...widget, config: { ...widget.config, pageSize: -2 } }, 'records').widget).toBeNull();
    expect(validateEditorWidget({ ...widget, config: { ...widget.config, unsupportedControl: true } }, 'records').widget).toBeNull();
    expect(validateEditorWidget(widget, 'metrics').errors.join(' ')).toContain('data kind');
    expect(validateEditorWidget({ ...widget, pluginId: 'not-installed' }, 'records').errors.join(' ')).toContain('registered');
  });

  it('shows concise plugin field errors while blocking Apply and preserving the valid preview', () => {
    const { widget } = makeCatalogFixture('record-table'), initial = createEditorDraft(widget);
    const invalid = reviseEditorDraft(initial, { ...widget, config: { ...widget.config, showSearch: 'yes', pageSize: 0, columns: ['valid', ''] } }, 'records');
    expect(invalid.errors).toContain('showSearch: expected boolean, received string');
    expect(invalid.errors.some(error => error.startsWith('pageSize:'))).toBe(true);
    expect(invalid.errors.some(error => error.startsWith('columns[1]:'))).toBe(true);
    expect(invalid.errors).toHaveLength(3);
    expect(invalid.errors.join(' ')).not.toContain('"code"');
    expect(invalid.preview).toBe(initial.preview);
    expect(invalid.draft.config?.showSearch).toBe('yes');
    expect(validateEditorWidget(invalid.draft, 'records').widget).toBeNull();
    expect(reviseEditorDraft(invalid, widget, 'records').errors).toEqual([]);
  });

  it('retains nested alternative paths and preserves ordinary parser errors', () => {
    const schema = z.object({ choice: z.union([z.object({ count: z.number() }), z.object({ label: z.string() })]) });
    const unregister = registerWidgetPlugin({ id: 'editor-error-format-test', label: 'Error format fixture', description: 'Validation boundary fixture', dataKind: 'records', render: () => null, parseConfig: config => { if (config?.generic === true) throw new Error('The required service column is unavailable.'); return schema.parse(config); } });
    try {
      const { widget } = makeCatalogFixture('record-table');
      const candidate = { ...widget, pluginId: 'editor-error-format-test', config: { choice: { count: 'many', label: false } } };
      expect(validateEditorWidget(candidate, 'records').errors).toEqual([
        'choice: choose one valid option.',
        'choice.count (option 1): expected number, received string',
        'choice.label (option 2): expected string, received boolean',
      ]);
      expect(validateEditorWidget({ ...candidate, config: { generic: true } }, 'records').errors).toEqual(['The required service column is unavailable.']);
    } finally { unregister(); }
  });

  it('switches renderer identity without leaking plugin-only config or altering query context', () => {
    const { widget } = makeCatalogFixture('directional-traffic');
    const before = structuredClone(widget);
    const next = visualizationCandidate(widget, getWidgetDefinition('timeseries')!);
    expect(next.type).toBe('timeseries');
    expect(next.config).toBeUndefined();
    expect(next.pluginId).toBeUndefined();
    expect(next.dataKind).toBeUndefined();
    expect(next.id).toBe(widget.id);
    expect(next.providerId).toBe(widget.providerId);
    expect(next.query).toBe(widget.query);
    expect(next.layout).toEqual(widget.layout);
    expect(validateEditorWidget(next, 'metrics').widget).not.toBeNull();
    expect(widget).toEqual(before);
  });

  it('offers only compatible configured visualizations while preserving the current custom renderer', () => {
    const definitions = [...widgetDefinitions, ...getWidgetPlugins()];
    const metric = makeCatalogFixture('timeseries');
    const choices = editorVisualizations(metric.widget, metric.result, definitions);
    expect(choices.some(choice => choice.id === 'timeseries')).toBe(true);
    expect(choices.every(choice => choice.dataKind === 'metrics')).toBe(true);
    expect(choices.some(choice => choice.id === 'distribution-heatmap')).toBe(false);
    const map = makeCatalogFixture('connection-map');
    const recordChoices = editorVisualizations(map.widget, map.result, definitions);
    expect(recordChoices.some(choice => choice.id === 'connection-map')).toBe(true);
    expect(recordChoices.some(choice => choice.id === 'record-table')).toBe(true);
    expect(recordChoices.every(choice => choice.dataKind === 'records')).toBe(true);
  });

  it('retains exact zero, null, fractional precision and UTC timestamps in bounded data preview', () => {
    const result: QueryResult = { series: [{ name: 'Metric', labels: { service: 'api' }, points: [{ timestamp: 1, value: 0 }, { timestamp: 2, value: null }, { timestamp: 3, value: 1.23456789 }] }] };
    const snapshot = JSON.stringify(result);
    const preview = editorDataTable(result, 2);
    expect(preview.total).toBe(3);
    expect(preview.capped).toBe(true);
    expect(preview.rows).toEqual([['Metric', '1970-01-01T00:00:00.001Z', 0, 'service=api'], ['Metric', '1970-01-01T00:00:00.002Z', null, 'service=api']]);
    expect(editorDataTable(result).rows[2][2]).toBe(1.23456789);
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('does not offer default allocation mappings to unrelated records, while keeping authored treemaps and table conversion', () => {
    const definitions = [...widgetDefinitions, ...getWidgetPlugins()];
    const geography = makeCatalogFixture('connection-map');
    const allocationDefinition = getWidgetDefinition('plugin', 'allocation-treemap')!;
    // Its config schema is valid in isolation, but the geographic result has no symbol/value/sector columns.
    expect(validateEditorWidget(visualizationCandidate(geography.widget, allocationDefinition), 'records').widget).not.toBeNull();
    expect(editorVisualizations(geography.widget, geography.result, definitions).some(choice => choice.id === 'allocation-treemap')).toBe(false);
    const { allocation } = financePanels();
    const choices = editorVisualizations(allocation.widget, allocation.result, definitions);
    expect(choices.some(choice => choice.id === 'allocation-treemap')).toBe(true);
    expect(choices.some(choice => choice.id === 'record-table')).toBe(true);
    const table = visualizationCandidate(allocation.widget, getWidgetDefinition('plugin', 'record-table')!);
    expect(validateEditorWidget(table, 'records').widget).not.toBeNull();
    expect(editorDataTable(allocation.result).columns).toContain('Market value (USD)');
    expect(allocation.result.records?.rows.length).toBeGreaterThan(0);
  });
});

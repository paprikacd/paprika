import { describe, expect, it } from 'vitest';
import { mergeDomainWidget } from '../src/components/lab/domain-widget';
import { buildGridBalance } from '../src/lenses/energy/fixtures';
import { registerEnergyCharts } from '../src/charts/energy/register';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { validateEditorWidget, visualizationCandidate } from '../src/editor/editor-model';

registerEnergyCharts(); registerLabCharts();
describe('domain panel applied visualization ownership', () => {
  it('applies a table conversion without leaking source-chart config or selection', () => {
    const { flow } = buildGridBalance();
    const table = visualizationCandidate(flow.widget, getWidgetDefinition('plugin', 'record-table')!);
    const merged = mergeDomainWidget(flow.widget, table, { selectedAsset: 'wind' });
    expect(merged.pluginId).toBe('record-table');
    expect(merged.config?.selectedAsset).toBeUndefined();
    expect(merged.config?.valueField).toBeUndefined();
    expect(validateEditorWidget(merged, 'records', flow.result).errors).toEqual([]);
  });
  it('retains presentation overrides while new source scope and lens selection remain current', () => {
    const { flow } = buildGridBalance();
    const override = { ...flow.widget, title: 'Available resources', queryRef: { id: 'old-query' }, config: { ...flow.widget.config, showValues: false, selectedAsset: 'wind' } };
    const source = { ...flow.widget, providerId: 'new-provider', query: 'fixture.low-wind', queryRef: { id: 'current-query' }, layout: { ...flow.widget.layout, w: 4 } };
    const merged = mergeDomainWidget(source, override, { selectedAsset: 'gas' });
    expect(merged).toMatchObject({ title: 'Available resources', providerId: 'new-provider', query: 'fixture.low-wind', queryRef: { id: 'current-query' } });
    expect(merged.layout).toBe(source.layout);
    expect(merged.config).toMatchObject({ showValues: false, selectedAsset: 'gas' });
    expect(source.config?.showValues).toBe(true);
  });
  it('removes plugin identity and configuration for a built-in visualization', () => {
    const { flow } = buildGridBalance();
    const next = { ...flow.widget, type: 'table' as const, pluginId: undefined, dataKind: undefined, config: undefined };
    const merged = mergeDomainWidget(flow.widget, next, { selectedAsset: 'gas' });
    expect('pluginId' in merged).toBe(false);
    expect('dataKind' in merged).toBe(false);
    expect('config' in merged).toBe(false);
    expect(merged.id).toBe(flow.widget.id);
  });
  it('restores edited renderer settings across a table round trip while retaining later panel edits', () => {
    const { flow } = buildGridBalance();
    const edited = { ...flow.widget, config: { ...flow.widget.config, valueField: 'renamed_power', showValues: false }, options: { ...flow.widget.options, showTooltip: false } };
    const table = visualizationCandidate(edited, getWidgetDefinition('plugin', 'record-table')!);
    const changedTitle = { ...table, title: 'Current source investigation', query: 'new.source.scope' };
    const restored = visualizationCandidate(changedTitle, getWidgetDefinition(flow.widget)!, edited);
    expect(restored.config).toEqual(edited.config);
    expect(restored.options?.showTooltip).toBe(false);
    expect(restored.title).toBe('Current source investigation');
    expect(restored.query).toBe('new.source.scope');
    expect(flow.widget.config?.valueField).toBe('power');
  });
});

import { describe, expect, it, vi } from 'vitest';

describe('direct lens authoring entry', () => {
  it('offers Records table without first visiting the catalogue or another lens', async () => {
    // No top-level app/fixture imports: otherwise an unrelated registration can
    // conceal the cold-entry failure this test is intended to catch.
    vi.resetModules();
    const registry = await import('../src/renderer-extensions/widget-registry');
    expect(registry.getWidgetPlugins()).toHaveLength(0);

    await import('../src/lenses/LensStudio');
    expect(registry.getWidgetDefinition('plugin', 'record-table')).toBeDefined();
    expect(registry.getWidgetDefinition('plugin', 'power-flow')).toBeUndefined();

    const { registerOrbitalCharts } = await import('../src/charts/orbital/register');
    registerOrbitalCharts();
    const { orbitalFixtures } = await import('../src/lenses/orbital/fixtures');
    const { editorVisualizations, visualizationCandidate, validateEditorWidget } = await import('../src/editor/editor-model');
    const { widget, result } = orbitalFixtures().profile;
    const edited = { ...widget, config: { ...widget.config, minimumMargin: 7.5, minimumElevation: 15 } };
    const choices = editorVisualizations(edited, result, [...registry.widgetDefinitions, ...registry.getWidgetPlugins()]);
    expect(choices.map(choice => choice.id)).toContain('record-table');

    const table = visualizationCandidate(edited, choices.find(choice => choice.id === 'record-table')!);
    expect(validateEditorWidget(table, 'records', result).errors).toEqual([]);
    const restored = visualizationCandidate(table, registry.getWidgetDefinition(edited)!, edited);
    expect(restored.config).toEqual(edited.config);
    expect(restored.providerId).toBe(widget.providerId);
    expect(restored.query).toBe(widget.query);
    expect(validateEditorWidget(restored, 'records', result).errors).toEqual([]);
  });
});

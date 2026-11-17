import { describe, expect, it, vi } from 'vitest';

describe('lab renderer registration', () => {
  it('registers the zoomable connection map before production defaults, into the one registry the lab reads', async () => {
    // Fresh module graph: other suites in this worker may already have registered plugins.
    vi.resetModules();
    const registry = await import('@insights/widget-registry');
    expect(registry.getWidgetDefinition('plugin', 'connection-map')).toBeUndefined();

    const { registerLabCharts } = await import('../src/charts/register-lab-charts');
    const { ZoomableConnectionMap } = await import('../src/renderer-extensions/connection-map');
    const { DistributionHeatmap } = await import('@insights/plugins/rich-metrics');
    const { operationalRecordPluginEntries } = await import('@insights/plugins/operational-records');
    const { ThresholdGauge } = await import('@insights/plugins/threshold-gauge');
    registerLabCharts();

    // The lab's map takes the connection-map id; production's entry keeps its fields, defaults and style controls.
    const connectionMap = registry.getWidgetDefinition('plugin', 'connection-map');
    const productionEntry = operationalRecordPluginEntries().find(entry => entry.id === 'connection-map')!;
    expect(connectionMap?.render).toBe(ZoomableConnectionMap);
    expect(productionEntry.render).not.toBe(ZoomableConnectionMap);
    expect(connectionMap?.configFields).toEqual(productionEntry.configFields);
    expect(connectionMap?.defaultConfig).toEqual(productionEntry.defaultConfig);
    // Production's guarded defaults fill the rest of the same registry, with production's renderers.
    expect(registry.getWidgetDefinition('plugin', 'distribution-heatmap')?.render).toBe(DistributionHeatmap);
    expect(registry.getWidgetDefinition('plugin', 'threshold-gauge')?.render).toBe(ThresholdGauge);
    expect(registry.getWidgetDefinition('plugin', 'record-table')).toBeDefined();
    expect(registry.getWidgetPlugins().filter(plugin => plugin.id === 'connection-map')).toHaveLength(1);
  });
});

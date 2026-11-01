import { describe, expect, it, vi } from 'vitest';

describe('lab renderer registration', () => {
  it('registers lab renderers before production defaults, into the one registry the lab reads', async () => {
    // Fresh module graph: other suites in this worker may already have registered plugins.
    vi.resetModules();
    const registry = await import('../src/renderer-extensions/widget-registry');
    expect(registry.getWidgetDefinition('plugin', 'connection-map')).toBeUndefined();

    const { registerLabCharts } = await import('../src/charts/register-lab-charts');
    const { ZoomableConnectionMap } = await import('../src/catalog/ConnectionMap');
    const { DistributionHeatmap } = await import('../src/renderer-extensions/plugins/rich-metrics');
    const { ThresholdGauge } = await import('@insights/plugins/threshold-gauge');
    registerLabCharts();

    // Order: production's guarded defaults skip ids the lab already holds, so these must be the lab's.
    expect(registry.getWidgetDefinition('plugin', 'connection-map')?.render).toBe(ZoomableConnectionMap);
    expect(registry.getWidgetDefinition('plugin', 'distribution-heatmap')?.render).toBe(DistributionHeatmap);
    // One registry: production plugin modules resolve ./widget-registry to the holding copy.
    expect(registry.getWidgetDefinition('plugin', 'threshold-gauge')?.render).toBe(ThresholdGauge);
    expect(registry.getWidgetDefinition('plugin', 'record-table')).toBeDefined();
  });
});

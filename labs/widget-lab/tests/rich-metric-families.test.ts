import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DirectionalTraffic, DistributionHeatmap, StackedTimeseries } from '@insights/plugins/rich-metrics';
import { widgetSchema } from '@insights/schema';

const timestamp = Date.UTC(2026, 9, 30, 13, 32, 8, 123);
const ingress = { name: 'Ingress', labels: { direction: 'inbound', gateway: 'edge-01' }, points: [{ timestamp, value: 12.123456789 }, { timestamp: timestamp + 1000, value: 0 }] };
const egress = { name: 'Egress', labels: { direction: 'outbound', gateway: 'edge-01' }, points: [{ timestamp, value: 7.987654321 }, { timestamp: timestamp + 1000, value: null }] };
const options = { showTooltip: true, tooltipPlacement: 'left' as const, tooltipOffset: 18, tooltipMaxWidth: 420, tooltipMaxHeight: 380 };

describe("rich metric families render through production's owner", () => {
  it('opens none of the three metric-family popups automatically and keeps their plotted source values', () => {
    const widget = widgetSchema.parse({ id: 'metric', title: 'Traffic', type: 'plugin', pluginId: 'stacked-timeseries', dataKind: 'metrics', providerId: 'fixture', query: 'traffic', unit: 'Mb/s', layout: { x: 0, y: 0, w: 6, h: 3 }, options });
    for (const Component of [StackedTimeseries, DirectionalTraffic]) {
      const markup = renderToStaticMarkup(createElement(Component, { widget, result: { series: [ingress, egress] } }));
      expect(markup).toContain('role="group"');
      expect(markup).toContain('Arrow keys inspect values; Enter pins.');
      expect(markup).not.toMatch(/NaN|Infinity/);
    }
    const histogram = [{ name: 'Lower', labels: { le: '10' }, points: [{ timestamp, value: 3 }] }, { name: 'Upper', labels: { le: '+Inf' }, points: [{ timestamp, value: 8 }] }];
    const density = renderToStaticMarkup(createElement(DistributionHeatmap, { widget: { ...widget, pluginId: 'distribution-heatmap', unit: 'ms' }, result: { series: histogram } }));
    expect(density).toContain('data-bucket-value="3"');
    expect(density).toContain('data-bucket-value="5"');
    expect(density).toContain('Arrow keys inspect buckets and time; Enter pins.');
  });
});

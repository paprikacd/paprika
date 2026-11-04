import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabWidgetLoadingProvider } from '../src/renderer-extensions/lab-widget-loading';
import { WidgetVisualization, type WidgetVisualizationProps } from '@insights/charts';
import { registerWidgetPlugin, type WidgetRendererProps } from '@insights/widget-registry';
import type { QueryResult, Widget } from '@insights/schema';

const renderer = vi.fn(({ result }: WidgetRendererProps) => createElement('output',
  { 'aria-label': 'Observed latency' }, result.series?.[0]?.points[0]?.value));
const unregister = registerWidgetPlugin({ id: 'loading-contract', label: 'Loading contract',
  description: 'Test the host lifecycle', dataKind: 'metrics', render: renderer });
const widget: Widget = { id: 'latency', title: 'Peer latency', type: 'plugin', pluginId: 'loading-contract',
  providerId: 'fixture', query: 'fixture', dataKind: 'metrics', unit: 'ms', layout: { x: 0, y: 0, w: 6, h: 4 } };
const result: QueryResult = { series: [{ name: 'eu-2', labels: {}, points: [{ timestamp: 1000, value: 84 }] }] };
const render = (props: Partial<WidgetVisualizationProps>) => renderToStaticMarkup(createElement(
  LabWidgetLoadingProvider, null, createElement(WidgetVisualization, { widget, ...props }),
));

afterAll(unregister);
beforeEach(() => { renderer.mockClear(); });

describe('host-owned loading presentation', () => {
  it('does not instantiate an interactive renderer before a result exists', () => {
    const html = render({ loading: true });
    expect(renderer).not.toHaveBeenCalled();
    expect(html).toContain('Loading Peer latency');
    expect(html).not.toContain('Observed latency');
    expect(html).not.toContain('No data');
  });

  it('keeps the exact retained result while separately announcing a refresh', () => {
    const html = render({ result, loading: true });
    expect(renderer).toHaveBeenCalledOnce();
    expect(renderer.mock.calls[0][0].result).toBe(result);
    expect(html).toContain('aria-label="Observed latency">84</output>');
    expect(html).toContain('Refreshing Peer latency');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('chart-loading-visual');
  });

  it("keeps an empty result's meaning while a refresh is pending", () => {
    // Production shows an empty result as its state, so the refresh notice belongs to populated results only.
    const html = render({ widget: { ...widget, type: 'timeseries', pluginId: undefined }, result: { series: [] }, loading: true });
    expect(html).toContain('No data');
    expect(renderer).not.toHaveBeenCalled();
  });

  it('keeps errors authoritative and removes pending presentation when the result settles', () => {
    const failed = render({ result, loading: true, error: 'Synthetic source unavailable' });
    expect(failed).toContain('Query failed');
    expect(failed).toContain('Synthetic source unavailable');
    expect(failed).not.toContain('Refreshing Peer latency');
    const ready = render({ result, loading: false });
    expect(ready).toContain('aria-label="Observed latency">84</output>');
    expect(ready).not.toContain('Refreshing Peer latency');
  });
});

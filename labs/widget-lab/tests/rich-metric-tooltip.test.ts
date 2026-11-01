import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectionalTraffic, DistributionHeatmap, RichMetricInspector, StackedTimeseries } from '../src/vendor/paprika/ui/src/features/insights/plugins/rich-metrics';
import type { ObservationTooltipProps } from '../src/vendor/paprika/ui/src/features/insights/observation-tooltip';
import { widgetSchema } from '../src/vendor/paprika/ui/src/features/insights/schema';

// The portal has no DOM during SSR. Expose the actual owner's contract while
// retaining the rich inspector's real source histories and exact-value content.
const captured = vi.hoisted(() => ({ owners: [] as ObservationTooltipProps[] }));
vi.mock('../src/vendor/paprika/ui/src/features/insights/observation-tooltip', async () => {
  const { createElement } = await import('react');
  return { ObservationTooltip: (props: ObservationTooltipProps & { children: ReactNode }) => {
    captured.owners.push(props);
    return createElement('div', { 'data-canonical-observation': props.pinned ? 'pinned' : 'transient' }, props.children);
  } };
});

const timestamp = Date.UTC(2026, 9, 30, 13, 32, 8, 123);
const ingress = { name: 'Ingress', labels: { direction: 'inbound', gateway: 'edge-01' }, points: [{ timestamp, value: 12.123456789 }, { timestamp: timestamp + 1000, value: 0 }] };
const egress = { name: 'Egress', labels: { direction: 'outbound', gateway: 'edge-01' }, points: [{ timestamp, value: 7.987654321 }, { timestamp: timestamp + 1000, value: null }] };
const options = { showTooltip: true, inspectorDensity: 'compact' as const, tooltipPlacement: 'left' as const, tooltipOffset: 18, tooltipMaxWidth: 420, tooltipMaxHeight: 380 };

beforeEach(() => { captured.owners.length = 0; });

describe('rich metric canonical tooltip integration', () => {
  it.each([false, true])('passes placement, source anchor and lifecycle to the canonical owner (pinned=%s)', pinned => {
    const close = vi.fn(), enter = vi.fn(), leave = vi.fn(), pin = vi.fn();
    const anchor = {} as SVGSVGElement;
    const bounds = () => ({ left: 100, right: 106, top: 200, bottom: 206 });
    const source = [ingress, egress], snapshot = JSON.stringify(source);
    const markup = renderToStaticMarkup(createElement(RichMetricInspector, {
      id: 'traffic-observation', title: 'Gateway traffic', series: source, colors: ['#00ccdd', '#aa88ff'],
      observation: { row: 1, column: 0, value: egress.points[0].value, timestamp, series: egress, name: egress.name, unit: 'Mb/s', color: '#aa88ff', note: 'Outbound is mirrored only for display.' },
      pinned, decimals: 2, options, anchor, anchorRect: bounds, onClose: close, onEnter: enter, onLeave: leave, onPin: pin,
    }));
    expect(captured.owners).toHaveLength(1);
    const owner = captured.owners[0];
    expect(owner).toMatchObject({ id: 'traffic-observation', pinned, label: 'Observation details' });
    expect(owner.anchor).toBe(anchor);
    expect(owner.anchorRect).toBe(bounds);
    expect(owner.options).toBe(options);
    owner.onEnter?.(); owner.onLeave?.(); owner.onDismiss('outside');
    expect(enter).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(pin).not.toHaveBeenCalled();
    expect(markup).toContain('data-rich-observation=""');
    expect(markup).toContain('12.123456789 Mb/s');
    expect(markup).toContain('7.987654321 Mb/s');
    expect(markup).not.toContain('-7.987654321');
    expect(markup).toContain('2026-10-30T13:32:08.123Z');
    expect(markup).toContain('Exact observations &amp; labels');
    expect(markup).toContain('1 missing sample');
    expect(markup).toContain('Outbound is mirrored only for display.');
    expect(markup).toContain(pinned ? 'Unpin observation' : 'Pin observation');
    expect(JSON.stringify(source)).toBe(snapshot);
  });

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
    expect(captured.owners).toHaveLength(0);
  });
});

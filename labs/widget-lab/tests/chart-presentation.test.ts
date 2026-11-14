import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { areaY } from '@tanstack/charts/area';
import { lineY } from '@tanstack/charts/line';
import { ruleY } from '@tanstack/charts/rule';
import { decorative } from '@tanstack/charts/mark/decorative';
import { createChartScene, defineChart } from '@tanstack/charts/scene';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scaleTime } from 'd3-scale';
import { calendarTick, horizontalPlotBounds, signedAreaGradient, temporalPosition, timeAxisValue } from '@insights/chart-presentation';
import { widgetOptionsSchema, widgetSchema } from '@insights/schema';
import { DistributionHeatmap } from '@insights/plugins/rich-metrics';
import { DashboardTimeZoneProvider } from '@insights/dashboard-time-zone';

describe('reference presentation owner extensions', () => {
  it('keeps mixed-family time labels in UTC and maps the same timestamp to the same plot position', () => {
    const start = Date.UTC(2026, 9, 31, 10), end = start + 6 * 3600000;
    expect(calendarTick(start, end-start, 'UTC')).toBe('10:00');
    expect(calendarTick(end, end-start, 'UTC')).toBe('16:00');
    expect(temporalPosition(start,start,end,110,588)).toBe(110);
    expect(temporalPosition(end,start,end,110,588)).toBe(588);
    expect(temporalPosition(start+3*3600000,start,end,110,588)).toBe(349);
    expect(widgetOptionsSchema.safeParse({plotInsetLeft:110,plotInsetRight:12}).success).toBe(true);
    expect(widgetOptionsSchema.safeParse({plotInsetLeft:-1}).success).toBe(false);
  });

  it('keeps canonical scene positions and shared time coordinates aligned after narrow resizing', () => {
    const start = Date.UTC(2026, 9, 31, 10), end = start + 6 * 3600000;
    // Irregular cadence and a missing interior observation must not turn into
    // array-index spacing or change the authoritative time-domain endpoints.
    const points = [
      { timestamp: start, value: 1 },
      { timestamp: start + 3600000, value: 3 },
      { timestamp: start + 7200000, value: null },
      { timestamp: end, value: 2 },
    ];
    for (const width of [600, 390, 150, 90]) {
      const { left, right, plotWidth } = horizontalPlotBounds(width, 110, 12);
      const scene = createChartScene(defineChart({
        marks: [lineY(points, { x: point => timeAxisValue(point.timestamp, true), y: 'value' })],
        scales: { x: { scale: scaleTime().domain([new Date(start), new Date(end)]) }, y: { scale: scaleLinear } },
        margin: { left, right, top: 20, bottom: 29 }, clip: true,
      }), { width, height: 240 });
      expect(scene.points).toHaveLength(3);
      for (const point of scene.points) {
        expect(point.x).toBeCloseTo(temporalPosition(point.datum.timestamp, start, end, left, left + plotWidth), 8);
        expect(point.x).toBeGreaterThanOrEqual(left);
        expect(point.x).toBeLessThanOrEqual(width - right);
      }
    }
    expect(horizontalPlotBounds(600, 110, 12)).toEqual({ left: 110, right: 12, plotWidth: 478 });
    expect(horizontalPlotBounds(150, 110, 12)).toEqual({ left: 70, right: 12, plotWidth: 68 });
    for (const width of [0, 1, 5, 8, 40, 110]) {
      const bounds = horizontalPlotBounds(width, 240, 120);
      expect(Object.values(bounds).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(bounds.left + bounds.right + bounds.plotWidth).toBeCloseTo(width);
      if (width > 0) expect(bounds.plotWidth).toBeGreaterThan(0);
    }
  });

  it('keeps time-centred heatmap columns inside the shared plot bounds, in time order, without overriding an explicit gutter', () => {
    const start = Date.UTC(2026, 9, 31, 10), end = start + 6 * 3600000;
    const timestamps = [start, start + 3600000, end];
    const widget = widgetSchema.parse({
      id: 'aligned-distribution', title: 'Latency distribution', type: 'plugin', pluginId: 'distribution-heatmap', dataKind: 'metrics',
      providerId: 'fixture', query: 'histogram', unit: 'milliseconds', layout: { x: 0, y: 0, w: 6, h: 3 },
      options: { timeAxis: 'calendar', plotInsetLeft: 110, plotInsetRight: 12 },
    });
    const result = { series: [
      { name: 'Finite bucket', labels: { le: '100' }, points: timestamps.map((timestamp, index) => ({ timestamp, value: index === 1 ? null : index })) },
      { name: 'All observations', labels: { le: '+Inf' }, points: timestamps.map((timestamp, index) => ({ timestamp, value: index === 1 ? null : index + 5 })) },
    ] };
    const markup = renderToStaticMarkup(createElement(DashboardTimeZoneProvider, {
      timeZone: 'UTC', children: createElement(DistributionHeatmap, { widget, result }),
    }));
    // Production places each column inside the plot bounds by geometry, so no clip path is needed.
    expect(markup).toContain('data-bucket-value="unknown"');
    expect(markup).toContain('>10:00</text>');
    expect(markup).toContain('>16:00</text>');
    const cells = [...markup.matchAll(/<rect ([^>]*data-bucket-value[^>]*)>/g)];
    expect(cells).toHaveLength(6);
    const attribute = (attributes: string, name: string) => Number(attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]+)"`))![1]);
    for (const [, attributes] of cells) {
      expect(attribute(attributes, 'x')).toBeGreaterThanOrEqual(110);
      expect(attribute(attributes, 'x') + attribute(attributes, 'width')).toBeLessThanOrEqual(720 - 12 + 1e-6);
    }
    // Columns keep time order, so the first timestamp is never drawn right of a later one.
    const left = (timestamp: number) => Math.min(...cells.filter(([, attributes]) => attribute(attributes, 'data-timestamp') === timestamp).map(([, attributes]) => attribute(attributes, 'x')));
    expect(left(start)).toBeLessThan(left(start + 3600000));
    expect(left(start + 3600000)).toBeLessThan(left(end));
    expect(temporalPosition(end, start, end, 110, 588)).toBe(588);
  });

  it('anchors positive, negative and crossing fills to the same true zero', () => {
    const positive = signedAreaGradient('in', '#00ccdd', [10, null, 30], .2);
    const negative = signedAreaGradient('out', '#aa88ff', [-10, null, -30], .2);
    const crossing = signedAreaGradient('mixed', '#00ccdd', [-10, 30], .2);
    // Production fades to transparent at the visible zero line, and a run with no values on one side fills no such side.
    expect(positive.stops.map(stop => stop.opacity)).toEqual([.2, 0]);
    expect(negative.stops.map(stop => stop.opacity)).toEqual([0, .2]);
    expect(crossing.stops[1]).toMatchObject({ offset: .75, opacity: 0 });
    expect(signedAreaGradient('zero', '#00ccdd', [null, 0, 0]).stops.every(stop => Number.isFinite(stop.offset))).toBe(true);
  });

  it('compiles a calendar scene while preserving exact numeric source timestamps and gaps', () => {
    const start = Date.UTC(2026, 9, 30, 5, 30, 10);
    const points = [{ timestamp: start, value: 12 }, { timestamp: start + 10_000, value: null }, { timestamp: start + 20_000, value: 16 }];
    const gradient = signedAreaGradient('sample-fill', '#00ccdd', points.map(point => point.value));
    const scene = createChartScene(defineChart({
      marks: [decorative(areaY(points, { x: point => timeAxisValue(point.timestamp, true), y: 'value', fill: 'url(#sample-fill)' })),
        lineY(points, { x: point => timeAxisValue(point.timestamp, true), y: 'value' })],
      scales: { x: { scale: scaleTime }, y: { scale: scaleLinear } }, gradients: [gradient],
    }), { width: 700, height: 250 });
    expect(scene.points.map(point => point.datum.timestamp)).toEqual([start, start + 20_000]);
    expect(scene.points.every(point => typeof point.datum.timestamp === 'number')).toBe(true);
    expect(scene.gradients[0].id).toBe('sample-fill');
    expect(points[1].value).toBeNull();
  });

  it('does not turn a budget reference or decorative area into a focusable observation', () => {
    const points = [{ x: 0, y: 2 }, { x: 1, y: 4 }];
    const scene = createChartScene(defineChart({ marks: [
      decorative(areaY(points, { x: 'x', y: 'y' })), lineY(points, { x: 'x', y: 'y' }),
      decorative(ruleY([1], { strokeDasharray: '5 4' })),
    ], scales: { x: { scale: scaleLinear }, y: { scale: scaleLinear } } }), { width: 700, height: 250 });
    expect(scene.points).toHaveLength(2);
    expect(scene.points.map(point => point.datum)).toEqual(points);
  });

  it('validates the new presentation contract and rejects invented or unsafe options', () => {
    expect(widgetOptionsSchema.safeParse({ gridX: true, timeAxis: 'calendar', axisUnit: 'caption', tooltipMaxWidth: 292, showZeroLine: true,
      referenceLines: [{ value: 1, label: 'Budget pace' }], tooltipView: { type: 'timeseries', height: 80 } }).success).toBe(true);
    expect(widgetOptionsSchema.safeParse({ fillStyle: 'neon' }).success).toBe(false);
    expect(widgetOptionsSchema.safeParse({ referenceLines: [{ value: 1, label: 'Budget', color: 'url(external)' }] }).success).toBe(false);
    expect(widgetOptionsSchema.safeParse({ decorativeNoise: true }).success).toBe(false);
  });
});

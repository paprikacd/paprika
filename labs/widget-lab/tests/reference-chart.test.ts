import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeReferenceResult, referenceChartConfig } from '../src/reference/ReferenceCharts';
import { getWidgetDefinition, getWidgetPlugins } from '@insights/widget-registry';
import { widgetSchema } from '@insights/schema';
import type { QueryResult } from '@insights/schema';

const cases = [
  { kind: 'edge', index: 202, values: [912.36, -312.18], unit: 'Mb/s', start: Date.UTC(2024, 4, 29, 13, 10), end: Date.UTC(2024, 4, 29, 13, 45), selected: Date.UTC(2024, 4, 29, 13, 32, 8), step: 10_000 },
  { kind: 'reliability', index: 176, values: [1.42, .81], unit: 'x', start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 4, 31), selected: Date.UTC(2024, 4, 16, 10, 40), step: 3_600_000 },
] as const;

describe('authored reference chart contract', () => {
  it('applies explicit defaults without changing the input configuration', () => {
    const input = { kind: 'edge' };
    expect(referenceChartConfig.parse(input)).toEqual({ kind: 'edge', service: 'uptime-api', gateway: 'edge-01', phase: 0 });
    expect(input).toEqual({ kind: 'edge' });
    expect(referenceChartConfig.parse({ kind: 'reliability', phase: 100_000 }).phase).toBe(100_000);
  });

  it('rejects unsupported modes, fields and unbounded replay/configuration input', () => {
    const invalid = [
      {}, { kind: 'latency' }, { kind: 'edge', arbitraryOption: true },
      { kind: 'edge', phase: -1 }, { kind: 'edge', phase: .5 },
      { kind: 'edge', phase: 100_001 }, { kind: 'edge', phase: Infinity },
      { kind: 'edge', gateway: 'g'.repeat(81) },
      { kind: 'reliability', service: 's'.repeat(81) },
    ];
    for (const input of invalid) expect(referenceChartConfig.safeParse(input).success).toBe(false);
  });

  it('registers one trusted metrics renderer with its strict parser and preserves built-ins', () => {
    const definition = getWidgetDefinition('plugin', 'reference-timeseries');
    expect(definition).toMatchObject({ id: 'reference-timeseries', type: 'plugin', dataKind: 'metrics', styleControls: ['tooltips'] });
    expect(definition?.parseConfig?.({ kind: 'edge' })).toEqual(referenceChartConfig.parse({ kind: 'edge' }));
    expect(() => definition?.parseConfig?.({ kind: 'edge', unsupported: true })).toThrow();
    expect(getWidgetPlugins().filter(plugin => plugin.id === 'reference-timeseries')).toHaveLength(1);
    expect(getWidgetDefinition('timeseries')?.type).toBe('timeseries');
    expect(getWidgetDefinition('plugin', 'missing-reference-plugin')).toBeUndefined();
  });

  it.each(cases)('retains the exact initial $kind concept observation and signed units', ({ kind, index, values, selected }) => {
    const result = makeReferenceResult(kind);
    expect(result.series).toHaveLength(2);
    expect(result.series!.map(series => series.points[index].timestamp)).toEqual([selected, selected]);
    expect(result.series!.map(series => series.points[index].value)).toEqual(values);
    expect(result.series!.every(series => series.labels.fixture === 'reference concept')).toBe(true);
    if (kind === 'edge') {
      expect(result.series![0].points.every(point => point.value !== null && point.value >= 0)).toBe(true);
      expect(result.series![1].points.every(point => point.value !== null && point.value <= 0)).toBe(true);
    }
  });

  it.each(cases)('keeps $kind timestamps increasing and aligned across both series', ({ kind, start, end }) => {
    const series = makeReferenceResult(kind).series!;
    expect(series[0].points).toHaveLength(361);
    expect(series[0].points[0].timestamp).toBe(start);
    expect(series[0].points.at(-1)!.timestamp).toBe(end);
    expect(series[1].points.map(point => point.timestamp)).toEqual(series[0].points.map(point => point.timestamp));
    for (const line of series) {
      expect(line.points.every(point => Number.isSafeInteger(point.timestamp) && (point.value === null || Number.isFinite(point.value)))).toBe(true);
      expect(line.points.slice(1).every((point, index) => point.timestamp > line.points[index].timestamp)).toBe(true);
    }
  });

  it('keeps the unknown Reliability interval null in both series and finite on each side', () => {
    for (const series of makeReferenceResult('reliability').series!) {
      const missing = series.points.flatMap((point, index) => point.value === null ? [index] : []);
      expect(missing).toEqual(Array.from({ length: 36 }, (_, index) => index + 290));
      expect(series.points[289].value).not.toBeNull();
      expect(series.points[326].value).not.toBeNull();
    }
  });

  it('generates deterministic results without retaining mutations between calls', () => {
    const original = makeReferenceResult('edge');
    const saved = structuredClone(original);
    original.series![0].points[0].value = 99_999;
    original.series![0].labels.fixture = 'mutated';
    expect(makeReferenceResult('edge')).toEqual(saved);
    expect(makeReferenceResult('reliability', 'payment-api', 7)).toEqual(makeReferenceResult('reliability', 'payment-api', 7));
  });

  it.each(cases)('advances $kind replay deterministically without filling gaps or mutating the default', ({ kind, step }) => {
    const baseline = makeReferenceResult(kind);
    const saved = structuredClone(baseline);
    const replay = makeReferenceResult(kind, 'uptime-api', 3);
    expect(replay).toEqual(makeReferenceResult(kind, 'uptime-api', 3));
    for (let seriesIndex = 0; seriesIndex < 2; seriesIndex++) {
      const before = baseline.series![seriesIndex].points;
      const after = replay.series![seriesIndex].points;
      expect(after.map((point, index) => point.timestamp - before[index].timestamp)).toEqual(Array(361).fill(step * 3));
      expect(after.map(point => point.value === null)).toEqual(before.map(point => point.value === null));
      expect(after.some((point, index) => point.value !== before[index].value)).toBe(true);
    }
    expect(baseline).toEqual(saved);
  });

  it('changes the selected service fixture while retaining its time and missingness contract', () => {
    const baseline = makeReferenceResult('reliability');
    const payment = makeReferenceResult('reliability', 'payment-api');
    for (let index = 0; index < 2; index++) {
      expect(payment.series![index].labels.service).toBe('payment-api');
      expect(payment.series![index].points.map(point => point.timestamp)).toEqual(baseline.series![index].points.map(point => point.timestamp));
      expect(payment.series![index].points.map(point => point.value === null)).toEqual(baseline.series![index].points.map(point => point.value === null));
      expect(payment.series![index].points[176].value).toBeCloseTo(baseline.series![index].points[176].value! * 1.38, 10);
    }
  });

  it('carries the selected gateway into the public result without changing reference geometry', () => {
    const primary = makeReferenceResult('edge');
    const secondary = makeReferenceResult('edge', 'uptime-api', 0, 'edge-02');
    expect(primary.series!.every(series => series.labels.gateway === 'edge-01')).toBe(true);
    expect(secondary.series!.every(series => series.labels.gateway === 'edge-02')).toBe(true);
    expect(secondary.series!.map(series => series.points)).toEqual(primary.series!.map(series => series.points));
    expect(secondary.series!.every(series => series.labels.fixture === 'reference concept')).toBe(true);
  });

  it.each(cases)('starts $kind inspection unpinned and preserves the registered data and units', ({ kind, unit }) => {
    const result = makeReferenceResult(kind);
    const saved = structuredClone(result);
    const widget = widgetSchema.parse({
      id: `test-reference-${kind}`, title: 'Reference fixture', type: 'plugin',
      pluginId: 'reference-timeseries', dataKind: 'metrics', providerId: 'reference-fixture',
      query: `reference.${kind}`, unit, layout: { x: 0, y: 0, w: 8, h: 4 },
      config: referenceChartConfig.parse({ kind }),
    });
    const definition = getWidgetDefinition(widget)!;
    const html = renderToStaticMarkup(createElement(definition.render, { widget, result }));
    expect(html).not.toContain('class="ref-inspector"');
    expect(html).toContain('Synthetic reference reconstruction');
    expect(html).toContain('tabindex="0"');
    const disabled = renderToStaticMarkup(createElement(definition.render, { widget: { ...widget, options: { showTooltip: false } }, result }));
    expect(disabled).not.toContain('class="ref-inspector"');
    expect(disabled).toMatch(/<svg[^>]*class="ref-chart-svg"[^>]*tabindex="-1"/);
    expect(result).toEqual(saved);
    const embedded = renderToStaticMarkup(createElement(definition.render, { widget, result, embedded: true }));
    expect(embedded).not.toContain('Pinned observation');
    expect(widget.unit).toBe(unit);
  });

  it.each([
    { label: 'missing series', result: {} },
    { label: 'empty series list', result: { series: [] } },
    { label: 'empty point arrays', result: { series: [{ name: 'Ingress', labels: {}, points: [] }] } },
  ] satisfies { label: string; result: QueryResult }[])('renders a safe empty state for $label', ({ result }) => {
    const widget = widgetSchema.parse({
      id: 'test-reference-empty', title: 'Reference fixture', type: 'plugin',
      pluginId: 'reference-timeseries', dataKind: 'metrics', providerId: 'reference-fixture',
      query: 'reference.edge', unit: 'Mb/s', layout: { x: 0, y: 0, w: 8, h: 4 }, config: { kind: 'edge' },
    });
    const html = renderToStaticMarkup(createElement(getWidgetDefinition(widget)!.render, { widget, result }));
    expect(html).toContain('role="status"');
    expect(html).toContain('No reference observations');
    expect(html).not.toContain('Pinned observation');
  });

  it('keeps missing reference values unavailable in the initial Reliability legend', () => {
    const result = makeReferenceResult('reliability');
    for (const series of result.series!) series.points[176].value = null;
    const widget = widgetSchema.parse({
      id: 'test-reference-gap', title: 'Reference fixture', type: 'plugin',
      pluginId: 'reference-timeseries', dataKind: 'metrics', providerId: 'reference-fixture',
      query: 'reference.reliability', unit: 'x', layout: { x: 0, y: 0, w: 8, h: 4 }, config: { kind: 'reliability' },
    });
    const html = renderToStaticMarkup(createElement(getWidgetDefinition(widget)!.render, { widget, result }));
    const legend = html.match(/<div class="ref-chart-legend">(.*?)<\/div>/s)?.[1];
    expect(legend?.match(/No data/g)).toHaveLength(2);
    expect(html).not.toContain('class="ref-inspector"');
    expect(legend).not.toContain('1.42x');
    expect(legend).not.toContain('0.81x');
  });
});

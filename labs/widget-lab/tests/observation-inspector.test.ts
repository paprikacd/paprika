import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildObservationInspector, inspectPreparedObservation, inspectionSeriesKey, prepareObservationInspector } from '../src/renderer-extensions/observation-inspector-data';
import { RichObservationInspector } from '../src/renderer-extensions/observation-inspector';
import { buildDistribution } from '../src/renderer-extensions/plugins/rich-metrics-data';
import type { Point, Series } from '@insights/chart-data';

const stamp = Date.UTC(2026, 9, 30, 13, 32, 8, 123);
const point = (offset: number, value: number | null): Point => ({ timestamp: stamp + offset, value });
const series = (name: string, points: Point[], labels: Record<string, string> = {}): Series => ({ name, labels, points });

describe('exact observation inspection', () => {
  it('distinguishes exact zero, explicit missing and an absent same-time scrape', () => {
    const model = buildObservationInspector([
      series('Ingress', [point(0, 0), point(1000, 2)]),
      series('Egress', [point(0, null), point(1000, 4)]),
      series('Async source', [point(-1, 8), point(1, 9)]),
    ], stamp);
    expect(model.rows.map(row => row.exact)).toEqual([
      { kind: 'observed', value: 0 }, { kind: 'missing', value: null }, { kind: 'absent', value: null },
    ]);
    expect(model.rows.map(row => row.exactSamples.length)).toEqual([1, 1, 0]);
  });

  it('does not choose or sum ambiguous observations at a duplicate timestamp', () => {
    const row = buildObservationInspector([series('Requests', [point(0, 8), point(0, 13), point(0, null)])], stamp).rows[0];
    expect(row.exact).toEqual({ kind: 'ambiguous', value: null });
    expect(row.exactSamples.map(sample => sample.value)).toEqual([8, 13, null]);
    expect([row.finiteCount, row.sampleCount, row.missingCount]).toEqual([2, 3, 1]);
  });

  it('scopes history and raw statistics to inclusive UTC window bounds without mutating source data', () => {
    const source = series('Burn', [point(3000, 999), point(2000, 4), point(0, -999), point(1000, 1.123456), point(1500, null)]);
    const before = structuredClone(source);
    for (const entry of source.points) Object.freeze(entry);
    Object.freeze(source.points);
    const model = buildObservationInspector([source], stamp + 1000, { start: stamp + 1000, end: stamp + 2000 });
    expect(model).toMatchObject({ start: stamp + 1000, end: stamp + 2000, windowed: true });
    expect(model.rows[0]).toMatchObject({ min: 1.123456, max: 4, finiteCount: 2, sampleCount: 3, missingCount: 1, exact: { kind: 'observed', value: 1.123456 } });
    expect(model.rows[0].points.map(sample => sample.timestamp)).toEqual([1000, 1500, 2000].map(offset => stamp + offset));
    expect(source).toEqual(before);
  });

  it('does not fabricate extrema or healthy coverage for empty and all-missing histories', () => {
    const model = buildObservationInspector([series('Empty', []), series('Missing', [point(0, null), point(5000, null)])], stamp);
    expect(model.rows.map(row => [row.min, row.max, row.finiteCount, row.sampleCount])).toEqual([[null, null, 0, 0], [null, null, 0, 2]]);
    const zero = buildObservationInspector([series('Zero', [point(0, 0)])], stamp).rows[0];
    expect([zero.min, zero.max, zero.finiteCount]).toEqual([0, 0, 1]);
    const emptyWindow = buildObservationInspector([], stamp, { start: stamp - 1000, end: stamp + 1000 });
    expect(emptyWindow).toMatchObject({ rows: [], start: stamp - 1000, end: stamp + 1000, windowed: true });
  });

  it('discloses invalid timestamps separately and normalizes non-finite values to missing samples', () => {
    const model = buildObservationInspector([series('Invalid input', [point(0, Infinity), point(1000, NaN), point(2000, -2), { timestamp: Infinity, value: 19 }, { timestamp: 9e15, value: 20 }])], stamp);
    expect(model.rows[0]).toMatchObject({ invalidTimestampCount: 2, sampleCount: 3, missingCount: 2, finiteCount: 1, min: -2, max: -2, exact: { kind: 'missing', value: null } });
    expect([model.start, model.end]).toEqual([stamp, stamp + 2000]);
  });

  it('labels an invalid requested window as source history rather than claiming window statistics', () => {
    const source = [series('Source', [point(0, 1), point(2000, 4)])];
    for (const window of [{ start: stamp + 2000, end: stamp }, { start: NaN, end: stamp }, { start: stamp, end: Infinity }]) {
      expect(buildObservationInspector(source, stamp, window)).toMatchObject({ start: stamp, end: stamp + 2000, windowed: false });
    }
  });

  it('keeps stable label identity and the selected series when inspection rows are bounded', () => {
    const first = series('Requests', [point(0, 1)], { service: 'api', region: 'eu' });
    const reordered = { ...first, labels: { region: 'eu', service: 'api' } };
    expect(inspectionSeriesKey(first)).toBe(inspectionSeriesKey(reordered));
    const inputs = Array.from({ length: 15 }, (_, index) => series(`Series ${index}`, [point(0, index)], { id: String(index) }));
    const model = buildObservationInspector(inputs, stamp, undefined, 12, 96, 14);
    expect(model.rows).toHaveLength(12);
    expect(model.omittedSeries).toBe(3);
    expect(model.rows.at(-1)).toMatchObject({ sourceIndex: 14, name: 'Series 14', exact: { kind: 'observed', value: 14 } });
    expect(new Set(model.rows.map(row => row.key)).size).toBe(12);
    const changedOrder = buildObservationInspector([reordered], stamp).rows[0];
    expect(changedOrder.key).toBe(buildObservationInspector([first], stamp).rows[0].key);
  });

  it('reuses prepared histories while exact selection remains independent of visual reduction', () => {
    const points = Array.from({ length: 600 }, (_, index) => point(index * 1000, index % 13 + .12345));
    points[231].value = 9000;
    points[410].value = null;
    points.at(-1)!.value = null;
    const prepared = prepareObservationInspector([series('History', points)], undefined, 12, 32);
    const first = inspectPreparedObservation(prepared, points[233].timestamp);
    const second = inspectPreparedObservation(prepared, points[234].timestamp);
    expect(first.rows[0].points).toBe(second.rows[0].points);
    expect(first.rows[0]).toMatchObject({ reduced: true, min: .12345, max: 9000, sampleCount: 600, missingCount: 2, exact: { kind: 'observed', value: points[233].value } });
    expect(first.rows[0].points.length).toBeLessThanOrEqual(32);
    expect(first.rows[0].points.some(sample => sample.value === 9000)).toBe(true);
    expect(first.rows[0].points.at(-1)).toEqual(points.at(-1));
    const reduced = first.rows[0].points;
    for (let index = 1; index < reduced.length; index++) {
      if (reduced[index - 1].value === null || reduced[index].value === null) continue;
      expect(points.some(sample => sample.value === null && sample.timestamp > reduced[index - 1].timestamp && sample.timestamp < reduced[index].timestamp)).toBe(false);
    }
  });

  it('handles a large source without spreading its values onto the call stack', () => {
    const points = Array.from({ length: 150_000 }, (_, index) => point(index, index % 97));
    const model = buildObservationInspector([series('Large source', points)], stamp + 132_157);
    expect(model.rows[0]).toMatchObject({ min: 0, max: 96, finiteCount: 150_000, sampleCount: 150_000, reduced: true, exact: { kind: 'observed', value: 132_157 % 97 } });
    expect(model.rows[0].points.length).toBeLessThanOrEqual(96);
  });

  it('retains unsampled non-cumulative histogram observations for full-source inspection', () => {
    const low = Array.from({ length: 100 }, (_, index) => point(index * 1000, index + 10));
    const high = low.map((sample, index) => ({ ...sample, value: sample.value! + (index === 37 ? 500 : 3) }));
    const data = buildDistribution([series('Low', low, { le: '10', service: 'api' }), series('High', high, { le: '20', service: 'api' })], { maxColumns: 8 });
    expect(data.sampled).toBe(true);
    expect(data.rows[1].cells).toHaveLength(8);
    expect(data.rows[1].sourceCells).toHaveLength(100);
    const source = series('10–20 ms', data.rows[1].sourceCells, data.rows[1].labels);
    expect(buildObservationInspector([source], stamp + 37_000).rows[0]).toMatchObject({ sampleCount: 100, min: 3, max: 500, exact: { kind: 'observed', value: 500 } });
    expect(data.rows[0].sourceCells.map(sample => sample.value)).toEqual(low.map(sample => sample.value));
  });

  it('renders explicit UTC precision, raw data access and functional pin/close labels', () => {
    const markup = renderToStaticMarkup(createElement(RichObservationInspector, {
      title: 'Gateway traffic', series: [series('Ingress', [point(0, 1.23456789)], { gateway: 'edge-01', region: 'eu' }), series('Egress', [point(0, null)])],
      selectedSeriesIndex: 0, timestamp: stamp, unit: 'Mb/s', decimals: 2, pinned: false,
      colors: ['#00ccdd', '#aa88ff'], onPin: () => {}, onClose: () => {},
    }));
    expect(markup).toMatch(/datetime="2026-10-30T13:32:08\.123Z"/i);
    expect(markup).toContain('13:32:08.123');
    expect(markup).toContain('UTC');
    expect(markup).toContain('1.23 Mb/s');
    expect(markup).toContain('1.23456789 Mb/s');
    expect(markup).toContain('Missing observation');
    expect(markup).toContain('Exact observations &amp; labels');
    expect(markup).toContain('aria-label="Close observation"');
    expect(markup).toContain('Pin observation');
    expect(markup).toContain('edge-01');
    expect(markup).not.toContain('View events');
  });

  it('keeps signed history geometry finite and fades its area at true zero', () => {
    const markup = renderToStaticMarkup(createElement(RichObservationInspector, {
      title: 'Signed source', series: [series('Signed', [point(0, -1e308), point(1000, 1e308)])],
      selectedSeriesIndex: 0, timestamp: stamp, unit: '', pinned: false,
      colors: ['#00ccdd'], onPin: () => {}, onClose: () => {},
    }));
    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(markup).toContain('offset="0.5"');
    expect(markup).toContain('y1="20" y2="20"');
  });
});

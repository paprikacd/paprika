import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeReferenceResult, ReferenceTimeseries } from '../src/reference/ReferenceCharts';
import { referenceSource, selectedObservationIndex, selectionAfterResultChange, type ReferenceObservations, type ReferenceSelection } from '../src/reference/reference-selection';

const observe = (result: ReturnType<typeof makeReferenceResult>): ReferenceObservations => ({
  points: result.series![0].points,
  source: referenceSource(result.series![0].labels),
});
const visibleWindow = (points: ReferenceObservations['points']) => ({ start: points[0].timestamp, end: points.at(-1)!.timestamp });
const EDGE_AUTHORED = Date.UTC(2024, 4, 29, 13, 32, 8);
const RELIABILITY_AUTHORED = Date.UTC(2024, 4, 16, 10, 40);

describe('reference inspection lifecycle', () => {
  it('mounts with no inspection, so the authored fixture value is not presented as a pinned reading', () => {
    // The authored mount pin was removed upstream; the chart renders with no selection until someone inspects it.
    for (const kind of ['edge', 'reliability'] as const) {
      const html = renderToStaticMarkup(createElement(ReferenceTimeseries, { kind }));
      expect(html, kind).not.toContain('ref-inspector');
      expect(html, kind).not.toContain('data-pinned="true"');
    }
  });

  it('keeps a dismissal dismissed through replay ticks and never re-pins on refresh', () => {
    for (const phase of [0, 1, 2, 3]) {
      expect(selectionAfterResultChange(null, observe(makeReferenceResult('edge', 'uptime-api', phase)))).toBeNull();
      expect(selectionAfterResultChange(null, observe(makeReferenceResult('reliability', 'uptime-api', phase)))).toBeNull();
    }
  });

  it('clears transient inspection on any replacement result', () => {
    const edge = observe(makeReferenceResult('edge'));
    const hover: ReferenceSelection = { timestamp: EDGE_AUTHORED, pinned: false, source: edge.source };
    expect(selectionAfterResultChange(hover, edge)).toBeNull();
  });

  it('keeps a pin that follows its timestamp rather than its index', () => {
    const base = observe(makeReferenceResult('reliability'));
    const pin: ReferenceSelection = { timestamp: RELIABILITY_AUTHORED, pinned: true, source: base.source };
    expect(selectedObservationIndex(base.points, pin, visibleWindow(base.points))).toBe(176);
    // One earlier observation is prepended, so the same timestamp now sits at index 177.
    const shifted = { points: [{ timestamp: base.points[0].timestamp - 3_600_000 }, ...base.points], source: base.source };
    expect(shifted.points[176].timestamp).not.toBe(RELIABILITY_AUTHORED);
    const kept = selectionAfterResultChange(pin, shifted);
    expect(kept).toBe(pin);
    expect(selectedObservationIndex(shifted.points, kept, visibleWindow(shifted.points))).toBe(177);
  });

  it('clears a pin whose timestamp is missing from the new result', () => {
    // A replay tick moves every timestamp forward, so the authored observation is no longer present.
    const pin: ReferenceSelection = { timestamp: EDGE_AUTHORED, pinned: true, source: observe(makeReferenceResult('edge')).source };
    const tick = observe(makeReferenceResult('edge', 'uptime-api', 1));
    expect(tick.points.some(point => point.timestamp === EDGE_AUTHORED)).toBe(false);
    expect(selectionAfterResultChange(pin, tick)).toBeNull();
  });

  it('clears a pin when the source it describes changes, even if the timestamps match', () => {
    const base = observe(makeReferenceResult('edge'));
    const pin: ReferenceSelection = { timestamp: EDGE_AUTHORED, pinned: true, source: base.source };
    const otherGateway = observe(makeReferenceResult('edge', 'uptime-api', 0, 'edge-02'));
    expect(otherGateway.points.map(point => point.timestamp)).toEqual(base.points.map(point => point.timestamp));
    expect(selectionAfterResultChange(pin, otherGateway)).toBeNull();
  });

  it('reports no index for an observation outside the visible window', () => {
    const base = observe(makeReferenceResult('edge'));
    const pin: ReferenceSelection = { timestamp: EDGE_AUTHORED, pinned: true, source: base.source };
    expect(selectedObservationIndex(base.points, pin, { start: EDGE_AUTHORED + 1, end: EDGE_AUTHORED + 60_000 })).toBeNull();
    expect(selectedObservationIndex(base.points, pin, visibleWindow(base.points))).toBe(202);
    expect(selectedObservationIndex(base.points, null, visibleWindow(base.points))).toBeNull();
  });

  it('identifies a source by its label content, independent of label order', () => {
    expect(referenceSource({ b: '2', a: '1' })).toBe(referenceSource({ a: '1', b: '2' }));
    expect(referenceSource({ gateway: 'edge-01' })).not.toBe(referenceSource({ gateway: 'edge-02' }));
  });
});

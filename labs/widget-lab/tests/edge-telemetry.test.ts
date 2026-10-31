import { describe, expect, it } from 'vitest';
import { buildEdgeTelemetry, EDGE_BASE_END_MS, EDGE_DETAIL_INTERVAL_MS, EDGE_INTERVAL_MS, makeEdgeChartResult } from '../src/data/edge-telemetry';

describe('Edge Watch fixture semantics', () => {
  it('generates deterministic, bounded minute intervals', () => {
    const data = buildEdgeTelemetry({ minutes: 60 });
    expect(buildEdgeTelemetry({ minutes: 60 })).toEqual(data);
    expect(data.points).toHaveLength(60);
    expect(data.points[0].timestampMs).toBe(data.startMs + EDGE_INTERVAL_MS);
    expect(data.points.at(-1)?.timestampMs).toBe(data.endMs);
    expect(data.endMs).toBe(EDGE_BASE_END_MS);
  });

  it('conserves request outcomes, protocol counts and destination bytes', () => {
    const data = buildEdgeTelemetry({ minutes: 60 });
    for (const point of data.points) {
      expect(point.allowed! + point.challenged! + point.blocked!).toBe(point.requests);
      expect(point.protocolRequests!.reduce((sum, count) => sum + count, 0)).toBe(point.requests);
      expect(point.destinationBytes!.reduce((sum, bytes) => sum + bytes, 0)).toBe(point.ingressBytes);
      expect(point.ingressMbps).toBeCloseTo(point.ingressBytes! * 8 / 60 / 1_000_000, 9);
      expect(point.egressMbps).toBeCloseTo(point.egressBytes! * 8 / 60 / 1_000_000, 9);
      expect(point.allowed).toBeGreaterThanOrEqual(0);
      expect(point.egressMbps).toBeGreaterThanOrEqual(0);
    }
  });

  it('derives shares and weighted block ratio from the same observed population', () => {
    const data = buildEdgeTelemetry({ minutes: 60 });
    expect(data.summary.blockedRatio).toBe(data.summary.blocked / data.summary.requests);
    expect(data.summary.allowed + data.summary.challenged + data.summary.blocked).toBe(data.summary.requests);
    expect(data.destinations.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12);
    expect(data.destinations.reduce((sum, row) => sum + row.meanMbps, 0)).toBeCloseTo(data.summary.ingressMbps!, 9);
    expect(data.protocols.reduce((sum, row) => sum + row.requests, 0)).toBe(data.summary.requests);
    expect(data.protocols.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12);
    expect(data.events.reduce((sum, event) => sum + event.count, 0)).toBe(data.summary.blocked);
  });

  it('aggregates gateways without averaging population counts or bytes', () => {
    const all = buildEdgeTelemetry({ minutes: 60 });
    const sydney = buildEdgeTelemetry({ gateway: 'edge-01', minutes: 60 });
    const singapore = buildEdgeTelemetry({ gateway: 'edge-02', minutes: 60 });
    expect(all.summary.requests).toBe(sydney.summary.requests + singapore.summary.requests);
    expect(all.summary.blocked).toBe(sydney.summary.blocked + singapore.summary.blocked);
    all.points.forEach((point, index) => {
      expect(point.ingressBytes).toBe(sydney.points[index].ingressBytes! + singapore.points[index].ingressBytes!);
      expect(point.activeConnections).toBe(sydney.points[index].activeConnections! + singapore.points[index].activeConnections!);
    });
  });

  it('retains sample and event identity when selecting a shorter window', () => {
    const full = buildEdgeTelemetry({ minutes: 60 });
    const short = buildEdgeTelemetry({ minutes: 15 });
    expect(short.points).toEqual(full.points.slice(-15));
    expect(short.samples10s).toEqual(full.samples10s.slice(-15 * 6));
    expect(short.events).toEqual(full.events.filter(event => event.timestampMs > short.startMs));
    expect(short.summary.requests).toBe(short.points.reduce((sum, point) => sum + point.requests!, 0));
  });

  it('keeps missing samples null, tracks coverage and exposes the stale tail', () => {
    const data = buildEdgeTelemetry({ scenario: 'gaps', minutes: 60 });
    expect(data.coverage).toBe(54 / 60);
    expect(data.points.filter(point => point.requests === null)).toHaveLength(6);
    expect(data.points.at(-1)?.ingressMbps).toBeNull();
    expect(data.lastObservedMs).toBe(data.endMs - 2 * EDGE_INTERVAL_MS);
    expect(data.summary.activeConnections).toBe(data.points.at(-3)?.activeConnections);
    expect(data.summary.ingressMbps).toBeCloseTo(data.points.reduce((sum, point) => sum + (point.ingressMbps ?? 0), 0) / 54, 10);
    expect(data.destinations.reduce((sum, row) => sum + row.meanMbps, 0)).toBeCloseTo(data.summary.ingressMbps!, 9);
  });

  it('advances the snapshot time without changing cadence or sample count', () => {
    const before = buildEdgeTelemetry({ revision: 0 });
    const after = buildEdgeTelemetry({ revision: 1 });
    expect(after.endMs - before.endMs).toBe(EDGE_INTERVAL_MS);
    expect(after.startMs - before.startMs).toBe(EDGE_INTERVAL_MS);
    expect(after.points).toHaveLength(before.points.length);
  });

  it.each(['incident', 'gaps'] as const)('preserves overlapping %s observations and events when advancing a snapshot', scenario => {
    for (const gateway of ['all', 'edge-01', 'edge-02'] as const) {
      const before = buildEdgeTelemetry({ scenario, gateway, minutes: 60, revision: 0 });
      const after = buildEdgeTelemetry({ scenario, gateway, minutes: 60, revision: 1 });
      expect(after.points.slice(0, -1)).toEqual(before.points.slice(1));
      expect(after.samples10s.slice(0, -6)).toEqual(before.samples10s.slice(6));
      expect(after.events.filter(event => event.timestampMs <= before.endMs)).toEqual(before.events.filter(event => event.timestampMs > after.startMs));
      expect(after.points.at(-1)?.timestampMs).toBe(before.endMs + EDGE_INTERVAL_MS);
      expect(after.points.at(-1)?.requests).toBeGreaterThan(0);
    }
  });

  it.each(['steady', 'gaps'] as const)('maps only actual %s intervals to chart points, preserving real gaps and mirroring egress', scenario => {
    const data = buildEdgeTelemetry({ scenario });
    const result = makeEdgeChartResult(data);
    expect(result.series[0].points).toEqual(data.points.map(point => ({ timestamp: point.timestampMs, value: point.ingressMbps })));
    expect(result.series[1].points).toEqual(data.points.map(point => ({ timestamp: point.timestampMs, value: point.egressMbps === null ? null : -point.egressMbps })));
    expect(result.series[0].points[0].timestamp).toBe(data.startMs + EDGE_INTERVAL_MS);
    expect(result.series[0].points.at(-1)?.timestamp).toBe(data.endMs);
  });

  it.each(['all', 'edge-01', 'edge-02'] as const)('conserves every minute byte and outcome total in six integer %s fixture samples', gateway => {
    const fields = ['ingressBytes', 'egressBytes', 'requests', 'allowed', 'challenged', 'blocked'] as const;
    const data = buildEdgeTelemetry({ gateway, minutes: 60 });
    expect(data.samples10s).toHaveLength(360);
    expect(data.samples10s[0].timestampMs).toBe(data.startMs + EDGE_DETAIL_INTERVAL_MS);
    expect(data.samples10s.at(-1)?.timestampMs).toBe(data.endMs);
    data.points.forEach((minute, index) => {
      const samples = data.samples10s.slice(index * 6, (index + 1) * 6);
      for (const field of fields) {
        expect(samples.reduce((sum, sample) => sum + sample[field]!, 0)).toBe(minute[field]);
        for (const sample of samples) {
          expect(Number.isSafeInteger(sample[field])).toBe(true);
          expect(sample[field]).toBeGreaterThanOrEqual(0);
        }
      }
      samples.forEach((sample, subIndex) => {
        expect(sample.timestampMs).toBe(minute.timestampMs - EDGE_INTERVAL_MS + (subIndex + 1) * EDGE_DETAIL_INTERVAL_MS);
        expect(sample.allowed! + sample.challenged! + sample.blocked!).toBe(sample.requests);
        expect(sample.ingressMbps).toBeCloseTo(sample.ingressBytes! * 8 / 10 / 1_000_000, 10);
        expect(sample.egressMbps).toBeCloseTo(sample.egressBytes! * 8 / 10 / 1_000_000, 10);
      });
      expect(samples.reduce((sum, sample) => sum + sample.ingressMbps!, 0) / 6).toBeCloseTo(minute.ingressMbps!, 9);
      expect(samples.reduce((sum, sample) => sum + sample.egressMbps!, 0) / 6).toBeCloseTo(minute.egressMbps!, 9);
    });
    expect(data.samples10s.reduce((sum, sample) => sum + sample.requests!, 0)).toBe(data.summary.requests);
    expect(data.samples10s.reduce((sum, sample) => sum + sample.blocked!, 0)).toBe(data.summary.blocked);
  });

  it('aggregates ten-second gateway populations without regenerating their observation shape', () => {
    const all = buildEdgeTelemetry({ minutes: 60 });
    const sydney = buildEdgeTelemetry({ gateway: 'edge-01', minutes: 60 });
    const singapore = buildEdgeTelemetry({ gateway: 'edge-02', minutes: 60 });
    const fields = ['ingressBytes', 'egressBytes', 'requests', 'allowed', 'challenged', 'blocked'] as const;
    all.samples10s.forEach((sample, index) => {
      for (const field of fields) expect(sample[field]).toBe(sydney.samples10s[index][field]! + singapore.samples10s[index][field]!);
    });
  });

  it('preserves each missing minute as six missing observations and excludes them from measured means', () => {
    const data = buildEdgeTelemetry({ scenario: 'gaps', minutes: 60 });
    data.points.forEach((minute, index) => {
      const samples = data.samples10s.slice(index * 6, (index + 1) * 6);
      expect(samples.every(sample => sample.requests === null)).toBe(minute.requests === null);
      if (minute.requests === null) for (const sample of samples) {
        expect(Object.entries(sample).filter(([key]) => key !== 'timestampMs').every(([, value]) => value === null)).toBe(true);
      }
    });
    const observed = data.samples10s.filter(sample => sample.ingressMbps !== null);
    expect(observed).toHaveLength(54 * 6);
    expect(observed.reduce((sum, sample) => sum + sample.ingressMbps!, 0) / observed.length).toBeCloseTo(data.summary.ingressMbps!, 9);
    expect(data.samples10s.at(-1)?.requests).toBeNull();
  });

  it.each(['steady', 'gaps'] as const)('renders exact %s ten-second fixture observations with explicit cadence, preserving gaps and positive source egress', scenario => {
    const data = buildEdgeTelemetry({ scenario });
    const originalSummary = structuredClone(data.summary);
    const detailed = makeEdgeChartResult(data, '10s');
    const minutes = makeEdgeChartResult(data, '1m');
    expect(detailed.series[0].points).toHaveLength(data.minutes * 6);
    expect(detailed.series[0].points).toEqual(data.samples10s.map(sample => ({ timestamp: sample.timestampMs, value: sample.ingressMbps })));
    expect(detailed.series[1].points).toEqual(data.samples10s.map(sample => ({ timestamp: sample.timestampMs, value: sample.egressMbps === null ? null : -sample.egressMbps })));
    expect(detailed.series[0].labels).toMatchObject({ source: 'Synthetic 10s fixture', interval: '10 seconds' });
    expect(minutes.series[0].points).toHaveLength(data.minutes);
    expect(minutes.series[0].labels).toMatchObject({ interval: '1 minute' });
    expect(data.summary).toEqual(originalSummary);
  });
});

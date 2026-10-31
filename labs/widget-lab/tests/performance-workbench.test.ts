import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { differentialProfile, differentialProfileConfig, empiricalQuantile, latencyDensity, latencyHistogram, meanInterval, pairedEvidenceConfig, pairedPerformance, performanceDensityConfig, performanceObservations, performanceTrace, performanceTraceConfig, type PerformanceObservation } from '../src/charts/performance/model';
import { performanceChartCatalog, makePerformanceCatalogFixture } from '../src/charts/performance/catalog';
import { registerPerformanceCharts } from '../src/charts/performance/register';
import { PerformanceDifferentialFlamegraph } from '../src/charts/performance/PerformanceProfile';
import { buildPerformanceWorkbench, PERFORMANCE_ROUTES, performanceProfileFixture, performanceRequestFixture } from '../src/lenses/performance/fixtures';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { parseRecordFrame } from '../src/vendor/paprika/ui/src/features/insights/record-data';
import { widgetSchema } from '../src/vendor/paprika/ui/src/features/insights/schema';

describe('performance request populations and distributions', () => {
  it('keeps seeded workload variation deterministic and paired while preserving exact trace examples', () => {
    for (const route of PERFORMANCE_ROUTES) {
      const fixture = performanceRequestFixture(route.id), rows = performanceObservations(fixture.records!);
      expect(performanceRequestFixture(route.id)).toEqual(fixture);
      expect(rows).toHaveLength(960);
      const before = rows.filter(row => row.version === 'before'), after = rows.filter(row => row.version === 'after');
      expect(new Set(before.map(row => row.pair)).size).toBe(480);
      for (const baseline of before) {
        const candidate = after.find(row => row.pair === baseline.pair)!;
        expect(candidate.timestamp).toBe(baseline.timestamp);
        expect(candidate.latency).toBeGreaterThanOrEqual(baseline.latency!);
      }
      for (const build of ['before', 'after'] as const) {
        expect(rows.find(row => row.pair === 'req-217' && row.version === build)?.latency).toBe(route[build]);
        expect(rows.find(row => row.pair === 'req-083' && row.version === build)?.latency).toBe(Number((route[build] * .83).toFixed(3)));
      }
      const summary = buildPerformanceWorkbench(route.id).summary;
      expect(summary.beforeP99).toBe(empiricalQuantile(before.map(row => row.latency!), .99));
      expect(summary.afterP99).toBe(empiricalQuantile(after.map(row => row.latency!), .99));
    }
  });
  it('empirical quantiles interpolate original observations without manufacturing request counts', () => {
    expect(empiricalQuantile([4, 1, 3, 2], .5)).toBe(2.5);
    expect(empiricalQuantile([1, 2, 3, 4], .95)).toBeCloseTo(3.85);
    expect(empiricalQuantile([], .99)).toBeNull();
    expect(empiricalQuantile([0], 1)).toBe(0);
    expect(() => empiricalQuantile([1, 2], 1.1)).toThrow();
  });
  it('logarithmic bins retain measured zero, exact upper-bound values and total population', () => {
    const values = [0, 0, 1, 2, 4, 7, 12, 300, 1000];
    const bins = latencyHistogram(values, 24, 1000);
    expect(bins.reduce((total, bin) => total + bin.count, 0)).toBe(values.length);
    expect(bins[0].count).toBe(3);
    expect(bins.at(-1)?.count).toBe(1);
    expect(() => latencyHistogram([-1], 24, 1000)).toThrow();
  });
  it('heatmap cells and distributions reconcile to each build’s observed denominator', () => {
    for (const gaps of [false, true]) {
      const observations = performanceObservations(performanceRequestFixture('checkout', gaps).records!);
      const data = latencyDensity(observations);
      const after = observations.filter(row => row.version === 'after');
      const known = after.filter(row => row.latency !== null).length;
      expect(data.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(known);
      expect(data.buckets.reduce((sum, bucket) => sum + bucket.missing + bucket.count, 0)).toBe(after.length);
      expect(data.after.reduce((sum, bin) => sum + bin.count, 0)).toBe(known);
      expect(data.before.reduce((sum, bin) => sum + bin.count, 0)).toBe(480);
      expect(latencyDensity(observations, { build: 'before', bins: 36, timeBuckets: 8 }).cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(480);
    }
  });
  it('requires real typed bindings and rejects mismatched units and duplicate request/build identities', () => {
    const valid = performanceRequestFixture().records!;
    expect(() => performanceObservations(valid, { latencyField: 'absent' })).toThrow(/Missing source field/);
    expect(() => performanceObservations(valid, { latencyField: 'route' })).toThrow(/number/);
    const seconds = structuredClone(valid); seconds.columns.find(column => column.key === 'latency')!.unit = 'seconds';
    expect(() => performanceObservations(seconds)).toThrow(/Convert the source/);
    const duplicate = structuredClone(valid); duplicate.rows[1] = duplicate.rows[0];
    expect(() => performanceObservations(duplicate)).toThrow(/unique/);
    const mismatch = structuredClone(valid); mismatch.rows[1][3] = Number(mismatch.rows[1][3]) + 1;
    expect(() => performanceObservations(mismatch)).toThrow(/same fixture time/);
  });
});

describe('performance trace and paired CPU accounting', () => {
  it('retains independent trace capture when the matching request metric observation is missing', () => {
    const missing = buildPerformanceWorkbench('checkout', true, 'req-047', 'after');
    const complete = buildPerformanceWorkbench('checkout', false, 'req-047', 'after');
    expect(missing.selectedMetricObservation.latency).toBeNull();
    expect(missing.selectedMetricObservation.cpu).toBeNull();
    expect(missing.traceData.duration).toBe(complete.traceData.duration);
    expect(missing.selectedObservation.latency).toBe(complete.selectedObservation.latency);
    expect(missing.trace.caption).toMatch(/Independent synthetic trace capture/);
    expect(missing.trace.caption).toMatch(/metrics are unavailable/);
    expect(missing.trace.caption).toMatch(/does not fill the metric gap/);
    expect(missing.summary.observed).toBeLessThan(complete.summary.observed);
    expect(missing.summary.afterP99).toBe(empiricalQuantile(missing.observations.filter(row => row.version === 'after').flatMap(row => row.latency === null ? [] : [row.latency]), .99));
  });
  it('preserves selected request errors on the trace root without attributing failures to child spans', () => {
    for (const build of ['before', 'after'] as const) for (const index of [217, 476, 477, 478, 479]) {
      const data = buildPerformanceWorkbench('checkout', false, `req-${index}`, build);
      const isError = build === 'after' ? index >= 476 : index >= 478;
      expect(data.selectedObservation.error).toBe(isError);
      expect(data.traceData.spans.find(span => span.parentId === null)?.status).toBe(isError ? 'error' : 'ok');
      expect(data.traceData.spans.filter(span => span.parentId !== null).every(span => span.status === (isError ? 'unknown' : 'ok'))).toBe(true);
      expect(() => parseRecordFrame(data.trace.result.records)).not.toThrow();
    }
  });
  it('keeps selected request latency, elapsed trace and non-overlapping phases identical across routes/builds', () => {
    for (const route of PERFORMANCE_ROUTES) for (const build of ['before', 'after'] as const) for (const request of ['req-217', 'req-083']) {
      const data = buildPerformanceWorkbench(route.id, false, request, build);
      expect(data.traceData.duration).toBe(data.selectedObservation.latency);
      expect(data.traceData.accounted).toBeCloseTo(data.traceData.duration, 10);
      expect(data.traceData.unaccounted).toBeCloseTo(0, 10);
      expect(data.traceData.spans.reduce((sum, span) => sum + span.duration, 0)).toBeGreaterThan(data.traceData.duration * 2);
      for (const span of data.traceData.spans) if (span.parentId) {
        const parent = data.traceData.spans.find(item => item.id === span.parentId)!;
        expect(span.start).toBeGreaterThanOrEqual(parent.start); expect(span.end).toBeLessThanOrEqual(parent.end + 1e-8);
      }
    }
  });
  it('rejects overlapping phases without forbidding legitimate nested spans', () => {
    const frame = buildPerformanceWorkbench().trace.result.records!;
    expect(() => performanceTrace(frame)).not.toThrow();
    const phase = frame.columns.findIndex(column => column.key === 'phase');
    frame.rows.find(row => row[0] === 'payment-cache')![phase] = true;
    expect(() => performanceTrace(frame)).toThrow(/must not overlap/);
  });
  it('preserves inclusive = self + immediate children in both aggregate profiles and their request denominators', () => {
    for (const route of PERFORMANCE_ROUTES) {
      const data = buildPerformanceWorkbench(route.id), profile = data.profileData;
      for (const build of ['before', 'after'] as const) {
        const costs = profile[build]!;
        const rawTotal = data.observations.filter(row => row.version === build).reduce((sum, row) => sum + row.cpu!, 0);
        expect(costs.total).toBeCloseTo(rawTotal, 7);
        for (const frame of costs.frames) expect(frame.self + costs.frames.filter(child => child.parentId === frame.id).reduce((sum, child) => sum + child.total, 0)).toBeCloseTo(frame.total, 7);
      }
      expect(profile.frames.find(frame => frame.parentId === null)?.deltaShare).toBeCloseTo(0, 10);
      expect(profile.frames.find(frame => frame.label === 'encoding/json.Marshal')!.deltaShare).toBeGreaterThan(0);
    }
  });
  it('uses each original profile’s request count when normalizing unequal populations', () => {
    const frame = performanceProfileFixture().records!, index = frame.columns.findIndex(column => column.key === 'beforeRequests');
    frame.rows.forEach(row => { row[index] = 240; });
    const data = differentialProfile(frame), root = data.frames.find(item => item.parentId === null)!;
    expect(root.deltaPerRequest).toBeCloseTo(data.after!.total / 480 - data.before!.total / 240, 10);
    expect(root.deltaShare).toBeCloseTo(0, 10);
    frame.rows[0][index] = 0; expect(() => differentialProfile(frame)).toThrow(/positive integer/);
  });
  it('marks share comparison unknown for a zero profile total while preserving absolute per-request differences', () => {
    for (const zeroBuild of ['before', 'after'] as const) {
      const fixture = buildPerformanceWorkbench().profile, frame = fixture.result.records!;
      const indices = ['Start', 'Total', 'Self'].map(suffix => frame.columns.findIndex(column => column.key === `${zeroBuild}${suffix}`));
      frame.rows.forEach(row => indices.forEach(index => { row[index] = 0; }));
      const profile = differentialProfile(frame), root = profile.frames.find(item => item.parentId === null)!;
      expect(profile.frames.every(item => item.deltaShare === null)).toBe(true);
      expect(root.deltaPerRequest).toBeCloseTo(profile.after!.total / profile.afterRequests - profile.before!.total / profile.beforeRequests, 10);
      if (zeroBuild === 'after') expect(root.deltaPerRequest).toBeLessThan(0); else expect(root.deltaPerRequest).toBeGreaterThan(0);
      for (const widthBy of ['before', 'after'] as const) {
        const markup = renderToStaticMarkup(createElement(PerformanceDifferentialFlamegraph, { ...fixture, widget: { ...fixture.widget, config: { ...fixture.widget.config, widthBy, selectedId: root.id } }, embedded: true }));
        expect(markup).toContain('Unknown · zero profile total');
        expect(markup).not.toMatch(/-100 pp|\+100 pp|NaN|Infinity/);
      }
    }
  });
  it('rejects impossible cost accounting and mismatched physical units', () => {
    const frame = performanceProfileFixture().records!, self = frame.columns.findIndex(column => column.key === 'afterSelf');
    frame.rows[0][self] = 100;
    expect(() => differentialProfile(frame)).toThrow(/reconcile/);
    const wrong = performanceProfileFixture().records!; wrong.columns.find(column => column.key === 'afterTotal')!.unit = 'bytes';
    expect(() => differentialProfile(wrong)).toThrow(/requires ms/);
  });
});

describe('matched performance evidence', () => {
  const observation = (pair: string, version: 'before' | 'after', value: number | null): PerformanceObservation => ({ id: `${version}:${pair}`, pair, version, route: '/route', timestamp: 0, latency: value, cpu: value, allocations: value, bytes: value, error: false });
  it('uses within-pair differences, so a constant additive change has zero difference uncertainty', () => {
    const rows = [1, 2, 3].flatMap((value, i) => [observation(String(i), 'before', value), observation(String(i), 'after', value + 1)]);
    const cpu = pairedPerformance([...rows].reverse()).find(row => row.id === 'cpu')!;
    expect(cpu.before?.mean).toBe(2); expect(cpu.after?.mean).toBe(3);
    expect(cpu.delta).toMatchObject({ count: 3, mean: 1, lower: 1, upper: 1 });
    expect(cpu.relativeChange).toBe(50);
  });
  it('excludes incomplete pairs per metric while preserving known zero and original pair count', () => {
    const rows = [observation('a', 'before', 0), observation('a', 'after', 2), observation('b', 'before', 5), observation('b', 'after', null), observation('c', 'before', 1)];
    const cpu = pairedPerformance(rows).find(row => row.id === 'cpu')!;
    expect(cpu).toMatchObject({ count: 1, missing: 2, totalPairs: 3, relativeChange: null });
    expect(cpu.before).toMatchObject({ mean: 0, lower: null, upper: null });
    expect(cpu.delta).toMatchObject({ mean: 2, lower: null, upper: null });
    expect(meanInterval([])).toBeNull();
  });
});

describe('performance registered authoring and passive previews', () => {
  registerPerformanceCharts();
  it('every advertised fixture satisfies canonical limits, schema and registered input validation', () => {
    for (const feature of performanceChartCatalog) for (const preset of feature.presets) {
      const fixture = makePerformanceCatalogFixture(feature.id, preset), owner = getWidgetDefinition('plugin', feature.id)!;
      expect(() => widgetSchema.parse(fixture.widget)).not.toThrow();
      expect(() => parseRecordFrame(fixture.result.records)).not.toThrow();
      expect(owner.layout?.mode).toBe('intrinsic');
      expect(() => owner.validateInput?.(fixture.result, owner.parseConfig?.(fixture.widget.config))).not.toThrow();
      expect(fixture.result.records!.rows.length).toBeLessThanOrEqual(1000);
      expect(fixture.result.records!.columns.length).toBeLessThanOrEqual(64);
    }
  });
  it('unsupported and invalid options are rejected rather than silently accepted', () => {
    for (const schema of [performanceDensityConfig, performanceTraceConfig, differentialProfileConfig, pairedEvidenceConfig]) expect(() => schema.parse({ decorativeGlow: true })).toThrow();
    expect(() => performanceDensityConfig.parse({ bins: 3 })).toThrow();
    expect(() => differentialProfileConfig.parse({ widthBy: 'delta' })).toThrow();
  });
  it('all families render ready and empty previews without invalid geometry or interactive toolbar controls', () => {
    for (const feature of performanceChartCatalog) for (const preset of ['ready', 'empty'] as const) {
      const fixture = makePerformanceCatalogFixture(feature.id, preset), owner = getWidgetDefinition('plugin', feature.id)!;
      const markup = renderToStaticMarkup(createElement(owner.render, { ...fixture, embedded: true }));
      expect(markup).not.toMatch(/NaN|Infinity|tabindex="0"/);
      expect(markup).not.toMatch(/\bheight="-\d|\bwidth="-\d/);
    }
  });
});

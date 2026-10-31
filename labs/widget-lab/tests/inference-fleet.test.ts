import { describe, expect, it } from 'vitest';
import { buildInferenceFleet, histogramQuantile, inferenceObservationWindow, inferenceResultInWindow, INFERENCE_AS_OF, INFERENCE_MODELS, LATENCY_BOUNDS } from '../src/lenses/inference-fleet-data';
import { buildLogScatter, buildRackMatrix, buildRequestFlow, logScatterConfig, rackMatrixConfig, requestFlowConfig, semanticColor } from '../src/charts/inference/data';
import { buildDistribution } from '../src/vendor/paprika/ui/src/features/insights/plugins/rich-metrics-data';
import { registerInferenceCharts } from '../src/charts/inference/register';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { widgetKind, widgetSchema } from '../src/vendor/paprika/ui/src/features/insights/schema';
import { parseRecordFrame } from '../src/vendor/paprika/ui/src/features/insights/record-data';
import { timeWindowExtent } from '../src/vendor/paprika/ui/src/features/insights/time-window';

registerLabCharts(); registerInferenceCharts();
describe('Inference Fleet source contracts', () => {
  it('reconciles visible devices, source GPU capacity, unavailable observations and workload counts', () => {
    const data = buildInferenceFleet(), matrix = buildRackMatrix(data.rack.result.records!, rackMatrixConfig.parse(data.rack.widget.config));
    expect(matrix.racks).toHaveLength(16); expect(matrix.slots).toHaveLength(8); expect(matrix.cells).toHaveLength(128);
    expect(matrix.cells.filter(cell => cell.value === null)).toHaveLength(4);
    expect(data.summary.gpus).toBe(128); expect(data.summary.online).toBe(124);
    expect(data.workloads.reduce((sum, model) => sum + model.gpus, 0)).toBe(128);
    expect(data.workloads.reduce((sum, model) => sum + model.active, 0)).toBe(124);
    expect(data.workloads.reduce((sum, model) => sum + model.queue, 0)).toBe(data.queue.result.series![0].points.at(-1)!.value);
    expect(matrix.cells.find(cell => cell.id === 'gpu-073')!.value).toBe(94);
    matrix.cells.forEach(cell => expect(cell.history.at(-1)).toBe(cell.value));
  });

  it('conserves the same request population in all Sankey stages and scope filters', () => {
    for (const scope of [{ region: 'all', model: 'all', hours: 6 }, { region: 'US-EAST', model: 'all', hours: 6 }, { region: 'EU-CENTRAL', model: 'qwen-72b', hours: 1 }] as const) {
      const data = buildInferenceFleet(scope), flow = buildRequestFlow(data.routing.result.records!, requestFlowConfig.parse({}));
      flow.groups.forEach(group => expect(group.reduce((sum, node) => sum + node.value, 0)).toBe(data.summary.requestRate));
      for (const model of flow.groups[1]) {
        expect(flow.links.filter(link => link.stage === 0 && link.target === model.name).reduce((sum, link) => sum + link.value, 0)).toBe(model.value);
        expect(flow.links.filter(link => link.stage === 1 && link.source === model.name).reduce((sum, link) => sum + link.value, 0)).toBe(model.value);
      }
      expect(flow.groups[2].find(group => group.name === 'Rejected')!.value).toBe(data.summary.rejected);
    }
    expect(buildInferenceFleet().summary.requestRate).toBe(58200);
    expect(buildInferenceFleet({ region: 'US-EAST', model: 'all', hours: 6 }).summary.requestRate).toBe(21400);
  });

  it('preserves overlapping observations when the loaded window narrows', () => {
    const full = buildInferenceFleet(), narrow = buildInferenceFleet({ region: 'all', model: 'all', hours: 1 });
    expect(full.times).toHaveLength(73); expect(narrow.times).toHaveLength(13);
    expect(full.times.at(-1)).toBe(INFERENCE_AS_OF);
    narrow.histogram.result.series!.forEach((series, i) => expect(series.points).toEqual(full.histogram.result.series![i].points.slice(-13)));
    expect(narrow.queue.result.series![0].points).toEqual(full.queue.result.series![0].points.slice(-13));
    expect(narrow.summary).toEqual(full.summary);
  });

  it('accepts one exact observation domain for both paired charts, including reversed and nested selections', () => {
    const data = buildInferenceFleet(), snapshot = structuredClone(data);
    const first = inferenceObservationWindow({ start: Date.UTC(2026, 9, 31, 14, 12), end: Date.UTC(2026, 9, 31, 11, 31) }, data.times)!;
    expect(first).toEqual({ start: Date.UTC(2026, 9, 31, 11, 30), end: Date.UTC(2026, 9, 31, 14, 15) });
    const nested = inferenceObservationWindow({ start: Date.UTC(2026, 9, 31, 12, 2), end: Date.UTC(2026, 9, 31, 13, 7) }, data.times)!;
    expect(nested.start).toBeGreaterThan(first.start); expect(nested.end).toBeLessThan(first.end);
    for (const window of [first, nested]) {
      const histogram = inferenceResultInWindow(data.histogram.result, window), queue = inferenceResultInWindow(data.queue.result, window);
      expect(timeWindowExtent(histogram.series!)).toEqual(window);
      expect(timeWindowExtent(queue.series!)).toEqual(window);
      for (const series of histogram.series!) expect(series.points.map(point => point.timestamp)).toEqual(queue.series![0].points.map(point => point.timestamp));
      for (const [index, series] of histogram.series!.entries()) for (const point of series.points) expect(point).toBe(data.histogram.result.series![index].points.find(source => source.timestamp === point.timestamp));
    }
    expect(data).toEqual(snapshot);
    expect(data.histogram.widget.options?.plotInsetLeft).toBe(data.queue.widget.options?.plotInsetLeft);
    expect(data.histogram.widget.options?.plotInsetRight).toBe(data.queue.widget.options?.plotInsetRight);
    expect(data.histogram.widget.options?.timeAxis).toBe('calendar'); expect(data.queue.widget.options?.timeAxis).toBe('calendar');
  });

  it('retains a window containing only missing telemetry without manufacturing observations or shifting the domain', () => {
    const data = buildInferenceFleet();
    const window = inferenceObservationWindow({ start: Date.UTC(2026, 9, 31, 13, 21), end: Date.UTC(2026, 9, 31, 13, 39) }, data.times)!;
    expect(window).toEqual({ start: Date.UTC(2026, 9, 31, 13, 20), end: Date.UTC(2026, 9, 31, 13, 40) });
    const histogram = inferenceResultInWindow(data.histogram.result, window), queue = inferenceResultInWindow(data.queue.result, window);
    for (const series of [...histogram.series!, ...queue.series!]) {
      expect(series.points).toHaveLength(5);
      expect(series.points.every(point => point.value === null)).toBe(true);
    }
    expect(timeWindowExtent(histogram.series!)).toEqual(timeWindowExtent(queue.series!));
    expect(inferenceResultInWindow(data.queue.result, { start: data.times[0], end: data.times.at(-1)! })).toEqual(data.queue.result);
  });

  it('bounds paired selection to the current source extent and rejects invalid or undersized input', () => {
    const data = buildInferenceFleet({ region: 'US-EAST', model: 'all', hours: 1 });
    expect(inferenceObservationWindow({ start: 0, end: INFERENCE_AS_OF + 1000 }, data.times)).toEqual({ start: INFERENCE_AS_OF - 3_600_000, end: INFERENCE_AS_OF });
    for (const candidate of [{ start: NaN, end: INFERENCE_AS_OF }, { start: INFERENCE_AS_OF - 1, end: INFERENCE_AS_OF }, { start: INFERENCE_AS_OF - 300_000, end: INFERENCE_AS_OF }, { start: Infinity, end: INFERENCE_AS_OF }]) expect(inferenceObservationWindow(candidate, data.times)).toBeNull();
    expect(inferenceObservationWindow({ start: 0, end: 1000 }, [])).toBeNull();
    expect(inferenceObservationWindow({ start: 0, end: 1000 }, [0])).toBeNull();
  });

  it('differences cumulative buckets once, preserves missing telemetry and estimates pooled quantiles', () => {
    const data = buildInferenceFleet(), source = data.histogram.result.series!, distribution = buildDistribution(source, { bucketLabel: 'le', maxBuckets: 24, maxColumns: 120 });
    expect(distribution.invalidCells).toBe(0); expect(distribution.omittedBuckets).toBe(0);
    for (let time = 0; time < data.times.length; time++) {
      if (time >= 40 && time <= 44) { expect(distribution.rows.every(bucket => bucket.cells[time].value === null)).toBe(true); expect(data.queue.result.series![0].points[time].value).toBeNull(); }
      else expect(distribution.rows.reduce((sum, bucket) => sum + bucket.cells[time].value!, 0)).toBeCloseTo(data.summary.requestRate, 6);
    }
    expect(data.summary.p95).toBeCloseTo(histogramQuantile(LATENCY_BOUNDS, source.map(series => series.points.at(-1)!.value!), .95)!, 9);
    expect(histogramQuantile([10, 20, Infinity], [50, 100, 100], .75)).toBe(15);
    expect(histogramQuantile([10, Infinity], [0, 0], .95)).toBeNull();
  });

  it('rejects ambiguous identities and discloses invalid log pairs without changing valid points', () => {
    const data = buildInferenceFleet(), frame = data.scatter.result.records!, parsed = buildLogScatter(frame, logScatterConfig.parse({}));
    expect(parsed.groups).toEqual(INFERENCE_MODELS); expect(parsed.points).toHaveLength(6 * 68); expect(parsed.omitted).toBe(0);
    const invalid = { ...frame, rows: [...frame.rows, ['zero', 'new model', INFERENCE_AS_OF, 0, 40], ['negative', 'new model', INFERENCE_AS_OF, 4, -1], ['unknown', 'new model', INFERENCE_AS_OF, null, 2]] };
    const clean = buildLogScatter(invalid, logScatterConfig.parse({})); expect(clean.omitted).toBe(3); expect(clean.points).toEqual(parsed.points);
    expect(() => buildLogScatter({ ...frame, rows: [...frame.rows, frame.rows[0]] }, logScatterConfig.parse({}))).toThrow(/unique IDs/);
    const rack = data.rack.result.records!; expect(() => buildRackMatrix({ ...rack, rows: [...rack.rows, rack.rows[0]] }, rackMatrixConfig.parse({}))).toThrow(/unique/);
    expect(semanticColor('llama-3-70b')).toBe(semanticColor([...INFERENCE_MODELS].reverse().find(model => model === 'llama-3-70b')!));
  });

  it('registers every actual renderer and validates its precise configuration', () => {
    const data = buildInferenceFleet();
    for (const panel of [data.rack, data.histogram, data.queue, data.routing, data.scatter, data.workloadPanel]) {
      expect(widgetSchema.safeParse(panel.widget).success, panel.widget.id).toBe(true);
      const definition = getWidgetDefinition(panel.widget)!; expect(definition, panel.widget.id).toBeDefined(); expect(definition.dataKind).toBe(widgetKind(panel.widget));
      expect(() => definition.parseConfig?.(panel.widget.config), panel.widget.id).not.toThrow();
      if (panel.result.records) expect(parseRecordFrame(panel.result.records)).toEqual(panel.result.records);
    }
    expect(() => rackMatrixConfig.parse({ gradient: 'decorative' })).toThrow();
    expect(() => logScatterConfig.parse({ pointRadius: 100 })).toThrow();
  });
});

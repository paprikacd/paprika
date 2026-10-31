import { describe, expect, it } from 'vitest';
import { buildInfrastructureLens, buildWebsiteLens, OPERATIONS_AS_OF } from '../src/lenses/operations-data';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { widgetKind, widgetSchema } from '../src/vendor/paprika/ui/src/features/insights/schema';
import { buildConnectionMap, connectionMapConfig } from '../src/vendor/paprika/ui/src/features/insights/plugins/operational-records-data';

registerLabCharts();
describe('operations lens data contracts', () => {
  it('reconciles complete and narrowed event populations without relabelling the full total', () => {
    const full = buildWebsiteLens(180), narrow = buildWebsiteLens(60);
    expect(full.eventCounts.map(values => values.reduce((sum, value) => sum + value, 0))).toEqual([190, 269, 273]);
    full.summaries.forEach((panel, index) => {
      expect(panel.result.series![0].points.at(-1)!.value).toBe([190, 269, 273][index]);
      expect(narrow.eventCounts[index]).toEqual(full.eventCounts[index].slice(-60));
      expect(narrow.summaries[index].result.series![0].points.at(-1)!.value).toBe(full.eventCounts[index].slice(-60).reduce((sum, value) => sum + value, 0));
    });
    expect(narrow.times).toHaveLength(60);
    expect(narrow.times.at(-1)).toBe(OPERATIONS_AS_OF);
    expect(full.times[0]).toBe(OPERATIONS_AS_OF - 179 * 60000);
  });

  it('uses exclusive integer latency buckets that equal every server request population', () => {
    for (const minutes of [60, 180] as const) {
      const data = buildWebsiteLens(minutes);
      for (let i = 0; i < data.times.length; i++) {
        const serverTotal = data.panels.requests.result.series!.reduce((sum, series) => sum + series.points[i].value!, 0);
        const bucketValues = data.panels.latency.result.series!.map(series => series.points[i].value!);
        expect(bucketValues.every(value => Number.isInteger(value) && value >= 0)).toBe(true);
        expect(bucketValues.reduce((a, b) => a + b, 0)).toBe(serverTotal);
      }
    }
  });

  it('keeps both narrowed rates and raw directional observations unchanged', () => {
    const full = buildWebsiteLens(180), narrow = buildWebsiteLens(60);
    for (const id of ['memory', 'cpu', 'sessions', 'requests', 'latency', 'transfer'] as const) {
      narrow.panels[id].result.series!.forEach((series, index) => expect(series.points).toEqual(full.panels[id].result.series![index].points.slice(-60)));
    }
    expect(full.panels.transfer.result.series!.every(series => series.points.every(point => point.value! >= 0))).toBe(true);
  });

  it('computes storage percentages from their displayed numerator and denominator', () => {
    const data = buildInfrastructureLens();
    for (const row of data.storageRows) expect(Number(row[2]) / Number(row[1]) * 100).toBeCloseTo(Number(row[3]), 9);
    expect(data.times).toHaveLength(144);
    expect(data.times[1] - data.times[0]).toBe(300000);
    expect(data.times.at(-1)).toBe(OPERATIONS_AS_OF);
    expect(data.health.find(row => row.name === 'Remote probes')!.detail).toBe('4 / 10 ≥ 180ms');
  });

  it('supplies separate exact spatial populations and valid classification thresholds', () => {
    const { panels } = buildInfrastructureLens();
    const latency = panels.latency.result.records!, blocked = panels.blocked.result.records!;
    expect(latency).not.toBe(blocked);
    latency.rows.forEach((row, i) => {
      expect(row.slice(0,4)).toEqual(blocked.rows[i].slice(0,4));
      const value = Number(row[4]);
      expect(row[5]).toBe(value < 50 ? 'low' : value < 180 ? 'medium' : 'high');
    });
    for (const source of [panels.latency, panels.blocked]) {
      const data = buildConnectionMap(source.result.records!, connectionMapConfig.parse(source.widget.config));
      expect(data.locations).toHaveLength(10);
    }
  });

  it('routes every panel through an existing matching renderer and strict configuration parser', () => {
    const site = buildWebsiteLens(), infra = buildInfrastructureLens();
    const panels = [...site.summaries, ...Object.values(site.panels), ...infra.summaries, ...Object.values(infra.panels)];
    expect(new Set(panels.map(panel => panel.widget.id)).size).toBe(panels.length);
    for (const panel of panels) {
      expect(widgetSchema.safeParse(panel.widget).success, panel.widget.id).toBe(true);
      const definition = getWidgetDefinition(panel.widget)!;
      expect(definition, panel.widget.id).toBeDefined();
      expect(definition.dataKind).toBe(widgetKind(panel.widget));
      expect(() => definition.parseConfig?.(panel.widget.config), panel.widget.id).not.toThrow();
    }
  });
});

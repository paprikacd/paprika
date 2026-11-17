import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DispatchMerit } from '../src/charts/energy/EnergyCharts';
import { contingencyCells, flexibilityPoints, powerNodes } from '../src/charts/energy/model';
import { forecastRecords } from '../src/charts/grid/grid-model';
import { buildGridBalance, GRID_TIME, type GridScenario } from '../src/lenses/energy/fixtures';
import { parseRecordFrame } from '@insights/record-data';

const scenarios: GridScenario[] = ['evening', 'low-wind', 'peak'];

describe('Grid Balance independent data contract review', () => {
  it('all scenario and coverage records satisfy the canonical typed-frame contract', () => {
    for (const scenario of scenarios) for (const gaps of [false, true]) {
      const data = buildGridBalance(scenario, gaps);
      for (const panel of [data.flow, data.forecast, data.flex, data.contingency, data.merit]) {
        expect(() => parseRecordFrame(panel.result.records), `${scenario} / ${gaps ? 'gaps' : 'complete'} / ${panel.widget.pluginId}`).not.toThrow();
      }
    }
  });

  it('reconciles snapshot supply, demand, losses, reserve and battery energy across panels', () => {
    for (const scenario of scenarios) {
      const data = buildGridBalance(scenario), flow = powerNodes(data.flow.result.records!);
      const forecast = forecastRecords(data.forecast.result.records!).points.find(point => point.timestamp === GRID_TIME)!;
      const storage = flexibilityPoints(data.flex.result.records!).find(point => point.timestamp === GRID_TIME)!;
      const battery = flow.nodes.find(node => node.id === 'battery')!;
      expect(flow.loads.reduce((total, node) => total + node.power, 0)).toBeCloseTo(flow.total, 10);
      expect(data.summary.demand + data.summary.losses).toBeCloseTo(flow.total, 10);
      expect(flow.available - flow.total).toBeCloseTo(data.summary.reserve, 10);
      expect(forecast.observed).toBeCloseTo(flow.total, 10);
      expect(forecast.median).toBeCloseTo(flow.total, 10);
      expect(forecast.capacity).toBeCloseTo(flow.available, 10);
      expect(storage.power).toBe(battery.power);
      expect(storage.energy).toBeCloseTo(battery.energy!, 10);
      expect(storage.capacity).toBe(battery.capacity);
      expect(storage.energy! / storage.capacity * 100).toBeCloseTo(data.summary.stateOfCharge, 10);
    }
  });

  it('integrates interval-start MW into MWh with a correct observed/predicted boundary', () => {
    const rows = flexibilityPoints(buildGridBalance().flex.result.records!);
    for (let i = 0; i < rows.length - 1; i++) {
      const current = rows[i], next = rows[i + 1], elapsedHours = (next.timestamp - current.timestamp) / 3_600_000;
      expect(next.energy! - current.energy!).toBeCloseTo(-current.power! * elapsedHours, 10);
      expect(current.energy).toBeGreaterThanOrEqual(0);
      expect(current.energy).toBeLessThanOrEqual(current.capacity);
      expect(current.predicted).toBe(current.timestamp > GRID_TIME);
    }
  });

  it('missing telemetry preserves the scenario accounting and original time grid', () => {
    const complete = buildGridBalance('low-wind'), missing = buildGridBalance('low-wind', true);
    const actual = flexibilityPoints(complete.flex.result.records!), gaps = flexibilityPoints(missing.flex.result.records!);
    expect(missing.accounting).toEqual(complete.accounting);
    expect(missing.summary).toEqual(complete.summary);
    expect(gaps.map(point => point.timestamp)).toEqual(actual.map(point => point.timestamp));
    expect(gaps.some(point => point.power === null && point.energy === null)).toBe(true);
    for (const [index, point] of gaps.entries()) if (point.power !== null) expect(point).toEqual(actual[index]);
  });

  it.each([
    ['power', 'kW'], ['available', 'kW'], ['price', '$/kWh'], ['energy', 'kWh'], ['capacity', 'kWh'],
  ])('rejects incompatible declared %s units before labelling them as MW/MWh', (field, unit) => {
    const frame = buildGridBalance().flow.result.records!;
    frame.columns.find(column => column.key === field)!.unit = unit;
    expect(() => powerNodes(frame)).toThrow();
  });

  it('rejects a fraction as percent loading and seconds as millisecond dispatch times', () => {
    const data = buildGridBalance();
    data.contingency.result.records!.columns.find(column => column.key === 'loading')!.unit = 'fraction';
    expect(() => contingencyCells(data.contingency.result.records!)).toThrow();
    data.flex.result.records!.columns.find(column => column.key === 'timestamp')!.unit = 'seconds';
    expect(() => flexibilityPoints(data.flex.result.records!)).toThrow();
  });

  it('rejects identity metadata that contradicts actual string records', () => {
    const frame = buildGridBalance().flow.result.records!;
    frame.columns.find(column => column.key === 'id')!.type = 'number';
    expect(() => powerNodes(frame)).toThrow();
  });

  it('renders valid nonnegative SVG geometry for legal negative marginal prices', () => {
    const { merit } = buildGridBalance();
    const price = merit.result.records!.columns.findIndex(column => column.key === 'price');
    merit.result.records!.rows[0][price] = -25;
    expect(powerNodes(merit.result.records!).sources[0].price).toBe(-25);
    const markup = renderToStaticMarkup(createElement(DispatchMerit, { ...merit, embedded: true }));
    const heights = [...markup.matchAll(/\bheight="(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)"/g)].map(match => Number(match[1]));
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(markup).not.toMatch(/NaN|Infinity/);
  });
});

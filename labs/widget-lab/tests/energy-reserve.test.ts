import { issueText } from './input-issues.helper';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReserveEnvelope } from '../src/charts/energy/ReserveEnvelope';
import { reserveEnvelopeConfig, reserveEnvelopePoints, reserveExtent } from '../src/charts/energy/reserve-model';
import { registerEnergyCharts } from '../src/charts/energy/register';
import { buildGridBalance, GRID_TIME, makeEnergyCatalogFixture, type GridScenario } from '../src/lenses/energy/fixtures';
import type { RecordFrame } from '@insights/schema';
import { widgetSchema } from '@insights/schema';
import { parseRecordFrame } from '@insights/record-data';
import { getWidgetDefinition } from '@insights/widget-registry';

function frame(rows: RecordFrame['rows']): RecordFrame {
  return {
    columns: ['timestamp', 'observed', 'median', 'low68', 'high68', 'low95', 'high95', 'capacity'].map(key => ({ key, type: 'number', unit: key === 'timestamp' ? 'ms' : 'MW' })),
    rows,
  };
}
const origin = Date.UTC(2026, 2, 4, 10);

describe('available reserve numerical contract', () => {
  it('inverts demand interval endpoints exactly while keeping observations separate', () => {
    const data = frame([[origin, 950, 1000, 900, 1100, 800, 1300, 1200]]);
    expect(reserveEnvelopePoints(data)[0]).toMatchObject({
      observedDemand: 950, medianDemand: 1000, capacity: 1200,
      observedReserve: 250, medianReserve: 200,
      low68: 100, high68: 300, low95: -100, high95: 400,
    });
    expect(data.rows[0]).toEqual([origin, 950, 1000, 900, 1100, 800, 1300, 1200]);
  });
  it('retains unknown capacity, missing observations, absent forecasts and measured zeros', () => {
    const data = frame([
      [origin, 0, null, null, null, null, null, 0],
      [origin + 1, null, null, null, null, null, null, 1500],
      [origin + 2, 900, 950, 900, 1000, 850, 1100, null],
      [origin + 3, null, 1000, null, null, null, null, 1200],
    ]);
    const points = reserveEnvelopePoints(data);
    expect(points[0]).toMatchObject({ observedReserve: 0, medianReserve: null, low95: null });
    expect(points[1]).toMatchObject({ capacity: 1500, observedReserve: null, medianReserve: null });
    expect(points[2]).toMatchObject({ observedDemand: 900, medianDemand: 950, capacity: null, observedReserve: null, medianReserve: null, low68: null, high95: null });
    expect(points[3]).toMatchObject({ observedReserve: null, medianReserve: 200, low68: null, high95: null });
  });
  it('requires paired, median-containing and correctly nested bounds', () => {
    expect(() => reserveEnvelopePoints(frame([[origin, null, 1000, 900, null, 800, 1200, 1100]]))).toThrow(/68% demand interval requires both/);
    expect(() => reserveEnvelopePoints(frame([[origin, null, 1000, 900, 1100, 1050, 1200, 1100]]))).toThrow(/95% demand interval must contain/);
    expect(() => reserveEnvelopePoints(frame([[origin, null, 1000, 700, 1100, 800, 1200, 1100]]))).toThrow(/inside the 95%/);
    expect(() => reserveEnvelopePoints(frame([[origin, null, null, null, null, 800, 1200, 1100]]))).toThrow(/contain its supplied median/);
  });
  it('supports optional paired 68% mappings without inventing narrower intervals', () => {
    const data = frame([[origin, null, 1000, 900, 1100, 800, 1200, 1100]]);
    data.columns = data.columns.filter(column => !['low68', 'high68'].includes(column.key));
    data.rows = [[origin, null, 1000, 800, 1200, 1100]];
    const point = reserveEnvelopePoints(data, { low68Field: '', high68Field: '' })[0];
    expect(point).toMatchObject({ medianReserve: 100, low68: null, high68: null, low95: -100, high95: 300 });
    expect(() => reserveEnvelopePoints(data, { low68Field: '', high68Field: 'high68' })).toThrow(/Bind both/);
  });
  it('sorts independent samples by true timestamps and rejects duplicate or invalid times', () => {
    const data = frame([[origin + 300_000, 1000, null, null, null, null, null, 1200], [origin, 900, null, null, null, null, null, 1200]]);
    const points = reserveEnvelopePoints(data);
    expect(points.map(point => point.timestamp)).toEqual([origin, origin + 300_000]);
    expect(data.rows[0][0]).toBe(origin + 300_000);
    expect(() => reserveEnvelopePoints(frame([data.rows[0], data.rows[0]]))).toThrow(/unique epoch/);
    for (const timestamp of [-1, 8_640_000_000_000_001]) expect(() => reserveEnvelopePoints(frame([[timestamp, 0, null, null, null, null, null, 0]]))).toThrow(/valid, unique epoch/);
  });
  it('includes zero, the full uncertainty and the chosen threshold in its signed domain', () => {
    const points = reserveEnvelopePoints(frame([[origin, null, 1000, 900, 1100, 800, 1300, 1200]]));
    const negative = reserveExtent(points, -500), positive = reserveExtent(points, 900);
    expect(negative[0]).toBeLessThan(-500); expect(negative[1]).toBeGreaterThan(400);
    expect(positive[0]).toBeLessThan(-100); expect(positive[1]).toBeGreaterThan(900);
    expect(reserveExtent([], 0)[0]).toBeLessThan(0); expect(reserveExtent([], 0)[1]).toBeGreaterThan(0);
  });
  it('reconciles each existing scenario snapshot to its conserved power-flow reserve', () => {
    for (const scenario of ['evening', 'low-wind', 'peak'] as GridScenario[]) {
      const data = buildGridBalance(scenario), point = reserveEnvelopePoints(data.reserve.result.records!).find(point => point.timestamp === GRID_TIME)!;
      expect(point.observedReserve).toBeCloseTo(data.summary.reserve, 9);
      expect(point.medianReserve).toBeCloseTo(data.summary.reserve, 9);
      expect(data.reserve.result).toBe(data.forecast.result);
      expect(point.capacity! - point.observedDemand!).toBeCloseTo(data.accounting.reserve, 9);
    }
  });
  it('does not close missing intervals or change scenario summaries with coverage', () => {
    const full = buildGridBalance(), gaps = buildGridBalance('evening', true);
    const complete = reserveEnvelopePoints(full.reserve.result.records!), missing = reserveEnvelopePoints(gaps.reserve.result.records!);
    expect(full.summary).toEqual(gaps.summary);
    expect(missing.map(point => point.timestamp)).toEqual(complete.map(point => point.timestamp));
    expect(missing.filter(point => point.observedReserve === null && point.medianReserve === null)).toHaveLength(3);
    for (const point of missing.filter(point => point.observedReserve !== null || point.medianReserve !== null)) expect(point).toEqual(complete.find(other => other.id === point.id));
  });
});

describe('reserve authoring and host integration', () => {
  registerEnergyCharts();
  it('supports renamed independent fields and rejects incompatible metadata', () => {
    const data = frame([[origin, 1000, null, null, null, null, null, 1300]]);
    data.columns[0].key = 'time_ms'; data.columns[7].key = 'supply_mw';
    expect(reserveEnvelopePoints(data, { timeField: 'time_ms', capacityField: 'supply_mw' })[0].observedReserve).toBe(300);
    expect(() => reserveEnvelopePoints(data)).toThrow(/Missing reserve field/);
    data.columns[0].unit = 'seconds';
    expect(() => reserveEnvelopePoints(data, { timeField: 'time_ms', capacityField: 'supply_mw' })).toThrow(/declare ms units/);
    data.columns[0].unit = 'ms'; data.columns[7].unit = 'MWh';
    expect(() => reserveEnvelopePoints(data, { timeField: 'time_ms', capacityField: 'supply_mw' })).toThrow(/declare MW units/);
  });
  it('validates every advertised record fixture before rendering and exposes typed mappings', () => {
    const definition = getWidgetDefinition('plugin', 'reserve-envelope')!;
    for (const preset of ['ready', 'gaps', 'empty', 'error'] as const) {
      const fixture = makeEnergyCatalogFixture('reserve-envelope', preset);
      expect(() => widgetSchema.parse(fixture.widget)).not.toThrow();
      expect(() => parseRecordFrame(fixture.result.records)).not.toThrow();
      expect(definition.validateInput!(fixture.result, fixture.widget.config)).toEqual([]);
      if (preset !== 'error') {
        const markup = renderToStaticMarkup(createElement(ReserveEnvelope, { ...fixture, embedded: true }));
        expect(markup).not.toMatch(/NaN|Infinity/);
        expect(markup).not.toContain('<select'); expect(markup).not.toContain('tabindex="0"');
        if (preset !== 'empty') expect(markup).toContain('<svg');
      }
    }
    expect(definition.configFields?.find(field => field.key === 'capacityField')?.binding).toMatchObject({ types: ['number'], unit: 'MW' });
    expect(definition.configFields?.find(field => field.key === 'low68Field')?.binding?.optional).toBe(true);
    expect(issueText(definition.validateInput!({}, {}))).toMatch(/require forecast/);
    const valid = makeEnergyCatalogFixture('reserve-envelope');
    expect(issueText(definition.validateInput!(valid.result, { capacityField: 'absent' }))).toMatch(/Missing reserve field/);
  });
  it('retains a single observed point and all-unknown samples as honest finite geometry', () => {
    const fixture = makeEnergyCatalogFixture('reserve-envelope');
    for (const records of [frame([[origin, 0, null, null, null, null, null, 0]]), frame([[origin, null, null, null, null, null, null, null]])]) {
      const markup = renderToStaticMarkup(createElement(ReserveEnvelope, { ...fixture, result: { records }, embedded: true }));
      expect(markup).not.toMatch(/NaN|Infinity/); expect(markup).toContain('<svg');
      if (records.rows[0][1] === 0) expect(markup).toContain('<circle');
    }
  });
  it('rejects unsupported configuration and keeps bands and reference presentation-only', () => {
    expect(() => reserveEnvelopeConfig.parse({ riskProbability: .5 })).toThrow();
    expect(() => reserveEnvelopeConfig.parse({ threshold: Infinity })).toThrow();
    const fixture = makeEnergyCatalogFixture('reserve-envelope'), source = JSON.stringify(fixture.result.records);
    for (const show68 of [true, false]) for (const show95 of [true, false]) {
      const widget = { ...fixture.widget, config: { ...fixture.widget.config, show68, show95, threshold: -100 } };
      const markup = renderToStaticMarkup(createElement(ReserveEnvelope, { ...fixture, widget, embedded: true }));
      expect(markup).not.toMatch(/NaN|Infinity/); expect(markup).toContain('Reference -100 MW');
      expect(JSON.stringify(fixture.result.records)).toBe(source);
    }
  });
});

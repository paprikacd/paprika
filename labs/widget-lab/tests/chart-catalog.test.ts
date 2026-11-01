import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { chartCatalog, makeCatalogFixture } from '../src/catalog/chart-fixtures';
import { geographicIdentity, mapSeverity } from '../src/catalog/ConnectionMap';
import { getWidgetDefinition, getWidgetPlugins } from '../src/renderer-extensions/widget-registry';
import { widgetKind, widgetSchema } from '../src/renderer-extensions/schema';
import { parseRecordFrame } from '@insights/record-data';
import { buildMetricPlot, buildDistribution, directionalConfigSchema, distributionConfigSchema } from '../src/renderer-extensions/plugins/rich-metrics-data';
import { buildConnectionMap, connectionMapConfig, buildIncidentCalendar, incidentCalendarConfig } from '@insights/plugins/operational-records-data';
import { tableBarGeometry } from '@insights/plugins/record-table-cells';
import { buildEdgeTelemetry } from '../src/data/edge-telemetry';
import { buildReliability, summarizeReliability, RELIABILITY_SERVICES } from '../src/data/reliability';

registerLabCharts();

describe('working chart capability coverage', () => {
  it('registers the full canonical dependency bundle explicitly and idempotently', () => {
    const before = getWidgetPlugins().map(plugin => plugin.id);
    registerLabCharts();
    expect(getWidgetPlugins().map(plugin => plugin.id)).toEqual(before);
    expect(new Set(before).size).toBe(before.length);
    for (const id of ['directional-traffic', 'stacked-timeseries', 'distribution-heatmap', 'status-history', 'record-table', 'threshold-gauge', 'incident-calendar', 'connection-map']) {
      expect(getWidgetDefinition('plugin', id)?.parseConfig).toBeTypeOf('function');
    }
  });

  for (const feature of chartCatalog) {
    it(`${feature.id} accepts each supported fixture through the existing schema and registered renderer`, () => {
      for (const preset of feature.presets) {
        const { widget, result } = makeCatalogFixture(feature.id, preset);
        expect(widgetSchema.safeParse(widget).success).toBe(true);
        const definition = getWidgetDefinition(widget)!;
        expect(definition).toBeDefined();
        expect(definition.dataKind).toBe(widgetKind(widget));
        const config = definition.parseConfig?.(widget.config) ?? widget.config;
        if (result.records) expect(parseRecordFrame(result.records)).toEqual(result.records);
        const markup = renderToStaticMarkup(createElement(definition.render, { widget: { ...widget, config }, result, embedded: true }));
        expect(markup).not.toContain('Widget could not render');
        expect(markup).not.toContain('Widget plugin unavailable');
        expect(markup).not.toContain('NaN');
      }
    });
  }

  it('preserves positive outbound input while the directional adapter mirrors its position', () => {
    const { widget, result } = makeCatalogFixture('directional-traffic');
    const outbound = result.series![1];
    expect(outbound.points.every(point => point.value === null || point.value >= 0)).toBe(true);
    const plot = buildMetricPlot(result.series!, directionalConfigSchema.parse(widget.config), true);
    expect(plot.tracks[1].cells.every(cell => cell.value === null || cell.value >= 0)).toBe(true);
    expect(plot.tracks[1].cells.some(cell => cell.upper !== null && cell.upper < 0)).toBe(true);
  });

  it('conserves exclusive outcome counts and keeps missing populations null', () => {
    for (const preset of ['ready', 'gaps'] as const) {
      const { result } = makeCatalogFixture('stacked-timeseries', preset);
      const edge = buildEdgeTelemetry({ scenario: preset === 'gaps' ? 'gaps' : 'incident', gateway: 'all', minutes: 30 });
      edge.points.forEach((source, index) => {
        const values = result.series!.map(series => series.points[index].value);
        if (source.requests === null) expect(values).toEqual([null, null, null]);
        else expect(values.reduce<number>((total, value) => total + value!, 0)).toBe(source.requests);
      });
    }
  });

  it('differences cumulative histogram buckets exactly once without changing their total', () => {
    const { widget, result } = makeCatalogFixture('distribution-heatmap');
    const data = buildDistribution(result.series!, distributionConfigSchema.parse(widget.config));
    expect(data.invalidCells).toBe(0);
    data.timestamps.forEach((timestamp, index) => {
      const total = result.series!.at(-1)!.points.find(point => point.timestamp === timestamp)!.value;
      expect(data.rows.reduce((sum, row) => sum + row.cells[index].value!, 0)).toBe(total);
    });
  });

  it('derives exact budget percentages before clipping a gauge track', () => {
    const fixture = makeCatalogFixture('budget-meter');
    const source = buildReliability(30, 'incident');
    RELIABILITY_SERVICES.forEach((service, index) => {
      const summary = summarizeReliability(source, service.id);
      expect(fixture.result.series![index].points[0].value).toBeCloseTo((summary.allowedFailures - summary.failures) / summary.allowedFailures * 100, 10);
    });
    const definition = getWidgetDefinition(fixture.widget)!;
    const negative = { series: [{ name: 'Exhausted service', labels: {}, points: [{ timestamp: source.endMs, value: -25 }] }] };
    const markup = renderToStaticMarkup(createElement(definition.render, { widget: fixture.widget, result: negative, embedded: true }));
    expect(markup).toContain('-25');
    expect(negative.series[0].points[0].value).toBe(-25);
  });

  it('keeps destination share denominators and common bar domains explicit', () => {
    const { widget, result } = makeCatalogFixture('record-table');
    expect(result.records!.rows.reduce((total, row) => total + Number(row[3]), 0)).toBeCloseTo(100, 8);
    const config = getWidgetDefinition(widget)!.parseConfig!(widget.config) as { cellStyles: { min: number; max: number }[] };
    const { min, max } = config.cellStyles[0];
    expect([min, max]).toEqual([0, 1000]);
    for (const row of result.records!.rows) expect(tableBarGeometry(Number(row[2]), min, max).end).toBeCloseTo(Number(row[2]) / 1000);
    expect(() => getWidgetDefinition(widget)!.parseConfig!({ ...widget.config, cellStyles: [{ column: 'traffic', display: 'bar', min: 100, max: 0 }] })).toThrow();
  });

  it('retains UTC event counts and does not invent zero observations for blank dates', () => {
    const { widget, result } = makeCatalogFixture('incident-calendar');
    const data = buildIncidentCalendar(result.records!, incidentCalendarConfig.parse(widget.config));
    const days = data.months.flatMap(month => month.days);
    expect(days.reduce((total, day) => total + day.observations, 0)).toBe(result.records!.rows.length);
    expect(days.some(day => day.observations === 0 && day.value === null)).toBe(true);
    expect(() => makeCatalogFixture('incident-calendar', 'gaps')).toThrow('does not define');
  });

  it('keeps map selection identity stable across input order and classifies only supplied statuses', () => {
    const { widget, result } = makeCatalogFixture('connection-map');
    const config = connectionMapConfig.parse(widget.config);
    const first = buildConnectionMap(result.records!, config);
    const reversed = buildConnectionMap({ ...result.records!, rows: [...result.records!.rows].reverse() }, config);
    expect(first.locations.map(geographicIdentity).sort()).toEqual(reversed.locations.map(geographicIdentity).sort());
    expect(geographicIdentity(first.locations[0])).toBe('syd');
    expect(mapSeverity('Australia')).toBe('unknown');
    expect(mapSeverity('low')).toBe('low');
    expect(mapSeverity('high risk')).toBe('high');
    expect(mapSeverity('blocking')).toBe('unknown');
    expect(mapSeverity('healthy')).toBe('unknown');
    const missing = makeCatalogFixture('connection-map', 'gaps');
    const missingData = buildConnectionMap(missing.result.records!, config);
    expect(missingData.invalid).toBe(1);
    expect(missingData.locations.filter(location => location.value === null)).toHaveLength(2);
  });

  it('does not offer nested map controls or inspectors in embedded mode', () => {
    const { widget, result } = makeCatalogFixture('connection-map');
    const definition = getWidgetDefinition(widget)!;
    const markup = renderToStaticMarkup(createElement(definition.render, { widget, result, embedded: true }));
    expect(markup).not.toContain('aria-label="Zoom in map"');
    expect(markup).not.toContain('aria-label="Reset map view"');
    expect(markup).not.toContain('aria-label="Inspect a map location"');
    expect(markup).not.toContain('role="dialog"');
  });

  it('keeps map navigation available when observation tooltips are disabled', () => {
    const { widget, result } = makeCatalogFixture('connection-map');
    const definition = getWidgetDefinition(widget)!;
    const markup = renderToStaticMarkup(createElement(definition.render, { widget: { ...widget, options: { ...widget.options, showTooltip: false } }, result }));
    expect(markup).toContain('aria-label="Zoom in map"');
    expect(markup).toContain('aria-label="Reset map view"');
    expect(markup).not.toContain('aria-label="Inspect a map location"');
    expect(markup).not.toContain('<title>');
  });
});

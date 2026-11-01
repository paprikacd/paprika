import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerConceptCharts } from '../src/charts/register-concept-charts';
import { allChartCatalog, chartCatalog, makeCatalogFixture } from '../src/catalog/chart-fixtures';
import { conceptChartCatalog, makeConceptCatalogFixture, type ConceptCatalogId } from '../src/catalog/concept-fixtures';
import { getWidgetDefinition, getWidgetPlugins } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { widgetKind, widgetSchema } from '../src/vendor/paprika/ui/src/features/insights/schema';
import { parseRecordFrame } from '../src/vendor/paprika/ui/src/features/insights/record-data';
import { correlationCells, correlationConfig, liquidityConfig, liquiditySegments, waterfallConfig, waterfallSteps } from '../src/charts/market-risk/market-chart-data';
import { buildLogScatter, buildRackMatrix, logScatterConfig, rackMatrixConfig } from '../src/charts/inference/data';
import { buildDependencyGraph, buildTraceSpans } from '../src/charts/incident/incident-model';
import { forecastRecords, networkRecords } from '../src/charts/grid/grid-model';

// Importing the registry and fixture modules must be sufficient: no lens route runs first.
registerConceptCharts();
describe('complex chart catalogue on a clean entry', () => {
  it('keeps the original examples and installs eleven additional unique families idempotently', () => {
    expect(chartCatalog).toHaveLength(11); expect(conceptChartCatalog).toHaveLength(11);
    expect(allChartCatalog.length).toBeGreaterThanOrEqual(22);
    expect(new Set(allChartCatalog.map(feature => feature.id)).size).toBe(allChartCatalog.length);
    const before = getWidgetPlugins().map(plugin => plugin.id); registerConceptCharts(); expect(getWidgetPlugins().map(plugin => plugin.id)).toEqual(before);
    for (const feature of conceptChartCatalog) expect(getWidgetDefinition('plugin', feature.id)).toBeDefined();
  });

  for (const feature of allChartCatalog.filter(item=>item.group)) it(`${feature.id} renders every advertised fixture through its registered contract`, () => {
    for (const preset of feature.presets) {
      const fixture = makeCatalogFixture(feature.id, preset), { widget, result } = fixture;
      expect(widgetSchema.safeParse(widget).success, `${feature.id}/${preset}`).toBe(true);
      const definition = getWidgetDefinition(widget)!; expect(definition.dataKind).toBe(widgetKind(widget));
      const config = definition.parseConfig!(widget.config);
      if (result.records) expect(parseRecordFrame(result.records)).toEqual(result.records);
      expect(() => definition.validateInput?.(result, config)).not.toThrow();
      const markup = renderToStaticMarkup(createElement(definition.render, { widget: { ...widget, config }, result, embedded: true }));
      expect(markup).not.toContain('NaN'); expect(markup).not.toContain('Widget could not render'); expect(markup).not.toContain('Widget plugin unavailable');
      if (preset === 'empty') expect(result.records?.rows.length ?? result.series?.length).toBe(0);
    }
  });

  it('mutates only cloned observations for meaningful missing-data states', () => {
    const waterfall = makeConceptCatalogFixture('contribution-waterfall', 'gaps');
    expect(waterfallSteps(waterfall.result.records!, waterfallConfig.parse(waterfall.widget.config)).total).toBeNull();
    const correlation = makeConceptCatalogFixture('correlation-matrix', 'gaps'), pairs = correlationCells(correlation.result.records!, correlationConfig.parse(correlation.widget.config));
    const newlyMissing = pairs.cells.filter(cell => cell.samples === 0); expect(newlyMissing).toHaveLength(2);
    expect(newlyMissing[0].row).toBe(newlyMissing[1].column); expect(newlyMissing[0].column).toBe(newlyMissing[1].row); expect(newlyMissing.every(cell => cell.value === null)).toBe(true);
    const liquidity = makeConceptCatalogFixture('liquidity-ladder', 'gaps'); expect(liquiditySegments(liquidity.result.records!, liquidityConfig.parse(liquidity.widget.config)).total).toBeNull();
    const rack = makeConceptCatalogFixture('rack-matrix', 'gaps'); expect(buildRackMatrix(rack.result.records!, rackMatrixConfig.parse(rack.widget.config)).cells.filter(cell => cell.value === null)).toHaveLength(11);
    const scatter = makeConceptCatalogFixture('log-scatter', 'gaps'); expect(buildLogScatter(scatter.result.records!, logScatterConfig.parse(scatter.widget.config)).omitted).toBeGreaterThan(0);
    const telemetry = makeConceptCatalogFixture('aligned-telemetry', 'gaps'); expect(telemetry.result.series!.every(series => series.points.slice(66, 85).every(point => point.value === null))).toBe(true);
    const graph = makeConceptCatalogFixture('service-dependency', 'gaps'); expect(buildDependencyGraph(graph.result.records!).edges.filter(edge => edge.latency === null)).toHaveLength(1);
    const map = makeConceptCatalogFixture('grid-network-map', 'gaps'); expect(networkRecords(map.result.records!).nodes.filter(node => node.value === null)).toHaveLength(4);
    const forecast = makeConceptCatalogFixture('forecast-bands', 'gaps'); expect(forecastRecords(forecast.result.records!).points.slice(222, 231).every(point => point.median === null && point.low68 === null && point.high95 === null)).toBe(true);
    const readyAgain = makeConceptCatalogFixture('rack-matrix'); expect(buildRackMatrix(readyAgain.result.records!, rackMatrixConfig.parse(readyAgain.widget.config)).cells.filter(cell => cell.value === null)).toHaveLength(4);
  });

  it('does not advertise invented partial-flow or missing-parent trace states', () => {
    for (const id of ['request-flow', 'trace-waterfall'] as ConceptCatalogId[]) expect(() => makeConceptCatalogFixture(id, 'gaps')).toThrow(/does not define/);
    const trace = makeConceptCatalogFixture('trace-waterfall'); expect(buildTraceSpans(trace.result.records!).duration).toBe(1892);
  });
});

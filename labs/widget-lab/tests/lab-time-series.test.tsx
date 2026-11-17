import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WidgetVisualization } from '@insights/charts';
import { DEFAULT_AREA_OPACITY, signedAreaGradient } from '@insights/chart-presentation';
import type { QueryResult, Widget } from '@insights/schema';

// The lab renders through production's renderer (M1). These checks run the lab's own
// WidgetVisualization on server markup, the same way the reviewer's evidence did, so
// a regression to a copied renderer shows up as lost gaps, bands or fills.
const start = 1_800_000_000_000;
const minute = 60_000;
const widget: Widget = { id: 'lab-series', title: 'Lab series', type: 'timeseries', providerId: 'fixture', query: 'fixture', unit: '%', layout: { x: 0, y: 0, w: 6, h: 4 } };

/** One sample a minute, with minutes 3 to 9 missing: an inferred gap of seven intervals. */
const gapped: QueryResult = { series: [{ name: 'cpu', labels: { host: 'a' }, points: [0, 1, 2, 10, 11, 12].map((m, index) => ({ timestamp: start + m * minute, value: 10 + index })) }] };

/** Plotted line runs: each run is one `d` path in the line group, and a gap starts a new run. */
function linePaths(html: string) {
  const groups = [...html.matchAll(/<g[^>]*class="ts-chart__line"[^>]*>([\s\S]*?)<\/g>/g)].map(match => match[1]);
  return groups.flatMap(group => [...group.matchAll(/ d="([^"]+)"/g)].map(match => match[1]));
}

/** The stops of the first area gradient in the markup, in order. */
function areaStops(html: string) {
  const gradient = html.match(/<linearGradient[^>]*data-ts-key="gradient:area-gradient-0"[^>]*>([\s\S]*?)<\/linearGradient>/);
  if (!gradient) return [];
  return [...gradient[1].matchAll(/<stop [^>]*offset="([^"]+)"[^>]*stop-opacity="([^"]+)"/g)].map(match => ({ offset: match[1], opacity: Number(match[2]) }));
}

describe('lab time series through production\'s renderer', () => {
  it('draws a gap as two line runs with one no-sample band, and marks the entrance', () => {
    const html = renderToStaticMarkup(createElement(WidgetVisualization, { widget, result: gapped }));
    expect(linePaths(html)).toHaveLength(2);
    expect(html.match(/data-no-sample-band/g) ?? []).toHaveLength(1);
    expect(html).toContain('data-chart-entering="true"');
    // Each run starts with its own move: the gap is not bridged by a segment.
    for (const path of linePaths(html)) expect(path.match(/M/g) ?? []).toHaveLength(1);
  });

  it('fades a negative series\' area to transparent at the zero line, not at its lowest value', () => {
    const negative: QueryResult = { series: [{ name: 'loss', labels: {}, points: [0, 1, 2].map(index => ({ timestamp: start + index * minute, value: -10 - index })) }] };
    const html = renderToStaticMarkup(createElement(WidgetVisualization, { widget: { ...widget, options: { display: 'area' } }, result: negative }));
    const stops = areaStops(html);
    // The top stop sits at the zero line, which for an all-negative run is the top of its fill.
    expect(stops).toEqual([{ offset: '0%', opacity: 0 }, { offset: '100%', opacity: DEFAULT_AREA_OPACITY }]);
  });

  it('builds the same zero-anchored stops as the production gradient helper', () => {
    const gradient = signedAreaGradient('check', '#000000', [-10, -11, -12]);
    expect(gradient.stops.map(stop => stop.opacity)).toEqual([0, DEFAULT_AREA_OPACITY]);
    const mixed = signedAreaGradient('mixed', '#000000', [-10, 30]);
    expect(mixed.stops.map(stop => stop.opacity)).toEqual([DEFAULT_AREA_OPACITY, 0, DEFAULT_AREA_OPACITY]);
  });
});

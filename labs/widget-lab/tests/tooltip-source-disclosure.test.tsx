import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetricDetails } from '@insights/metric-tooltip-content';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';

describe('metric tooltip source disclosure', () => {
  it.each([false, true])('keeps source metadata collapsed beneath the reading (compact=%s)', compact => {
    const widget = makeCatalogFixture('timeseries').widget;
    const series = {
      name: 'paprika_example_node_cpu{cluster="staging", node="node-01"}',
      labels: { cluster: 'staging', node: 'node-01', pod: 'paprika-collector-01' },
      points: [{timestamp:Date.UTC(2026,10,4),value:0.75}],
    };
    const html = renderToStaticMarkup(createElement(MetricDetails, {
      widget, series, index:0, point:series.points[0], unit:'cores', compact, seriesLabel:'CPU per node',
    }));
    const source = html.match(/<details\b[^>]*>.*?<\/details>/s)?.[0];
    expect(source).toBeDefined();
    expect(source).not.toMatch(/<details[^>]+open/);
    expect(source).toContain(series.name.replaceAll('"', '&quot;'));
    expect(source).toContain('node-01');
    expect(source).toContain('paprika-collector-01');
    expect(source).toContain('Source details');
    expect(source).toContain('Exact value');
    const reading = html.replace(source!, '');
    expect(reading).toContain('CPU per node');
    expect(reading).toContain('data-metric-value="0.75"');
    expect(reading).not.toContain('node-01');
    expect(reading).not.toContain('paprika-collector-01');
    expect((html.match(/paprika-collector-01/g) ?? []).length).toBe(1);
  });

  it('keeps extensive metadata collapsed until deliberately inspected', () => {
    const widget = makeCatalogFixture('timeseries').widget;
    const series = {
      name:'long telemetry source',
      labels:Object.fromEntries(Array.from({length:12},(_,i)=>['resource_'+i,'value_'+i])),
      points:[{timestamp:Date.UTC(2026,10,4),value:1}],
    };
    const html = renderToStaticMarkup(createElement(MetricDetails,{
      widget,series,index:0,point:series.points[0],unit:'',
    }));
    expect(html).toContain('Source details');
    expect(html).not.toMatch(/<details[^>]+open/);
  });
});


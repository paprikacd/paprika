import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetricDetails } from '@insights/metric-tooltip-content';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';

describe('metric tooltip source disclosure', () => {
  it('keeps ordinary source disclosure collapsed, with optional visible pinned source context', () => {
    const widget = makeCatalogFixture('timeseries').widget;
    const series = {
      name: 'paprika_example_node_cpu{cluster="staging", node="node-01"}',
      labels: { cluster: 'staging', node: 'node-01', pod: 'paprika-collector-01' },
      points: [{timestamp:Date.UTC(2026,10,4),value:0.75}],
    };
    const html = renderToStaticMarkup(createElement(MetricDetails, {
      widget, series, index:0, point:series.points[0], unit:'cores',
    }));
    expect(html).not.toMatch(/<details[^>]+open/);
    expect(html).toContain(series.name.replaceAll('"', '&quot;'));
    expect(html).toContain('node-01');
    expect(html).toContain('paprika-collector-01');
    expect(html).toContain('Source details');
    expect(html).toContain('Exact value');

    const pinned = renderToStaticMarkup(createElement(MetricDetails, {
      widget, series, index:0, point:series.points[0], unit:'cores', showSourceContext:true,
    }));
    expect(pinned).not.toMatch(/<details[^>]+open/);
    expect(pinned).toContain(series.name.replaceAll('"', '&quot;'));
    expect(pinned).toContain('paprika-collector-01');
    expect(pinned).toContain('node-01');
    expect((pinned.match(/paprika-collector-01/g) ?? []).length).toBe(1);
    expect((pinned.match(/node-01/g) ?? []).length).toBe(2);
    expect(pinned).toContain('Source details');
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


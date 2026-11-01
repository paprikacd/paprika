import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartLoading, ChartRefreshing, type ChartLoadingVariant } from '../src/components/lab/ChartLoading';

describe('chart loading state semantics', () => {
  it('exposes one loading message while keeping placeholder marks out of inspection and accessibility', () => {
    const variants: ChartLoadingVariant[] = ['line', 'bars', 'table', 'matrix', 'topology'];
    for (const variant of variants) {
      const html = renderToStaticMarkup(createElement(ChartLoading, { variant, label: 'Loading node pressure' }));
      expect(html.match(/role="status"/g)).toHaveLength(1);
      expect(html).toContain('aria-live="polite" aria-atomic="true"');
      expect(html).toContain('class="chart-loading-visual" aria-hidden="true"');
      expect(html).toContain('Loading node pressure</span>');
      expect(html).not.toMatch(/aria-valuenow|tabindex|role="(?:button|slider|progressbar|img)"|<button|<input/);
    }
  });

  it('accepts a host-owned fill height and remains server-renderable without document globals', () => {
    const html = renderToStaticMarkup(createElement(ChartLoading, { height: 'fill' }));
    expect(html).toContain('height:100%');
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('identifies retained-data refresh separately from first load without claiming progress', () => {
    const html = renderToStaticMarkup(createElement(ChartRefreshing, { label: 'Refreshing node pressure' }));
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('Refreshing node pressure</span>');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/aria-valuenow|aria-modal|role="progressbar"|tabindex/);
  });
});

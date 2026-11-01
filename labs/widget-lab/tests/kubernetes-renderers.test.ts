import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerKubernetesCharts } from '../src/charts/kubernetes/register';
import { kubernetesChartCatalog, makeKubernetesCatalogFixture } from '../src/charts/kubernetes/catalog';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { widgetSchema } from '../src/renderer-extensions/schema';
import { parseRecordFrame } from '@insights/record-data';

describe('Kubernetes canonical registered renderers', () => {
  registerKubernetesCharts();
  it('preflights every fixture with canonical records, strict config and the actual input adapter', () => {
    for (const feature of kubernetesChartCatalog) for (const preset of feature.presets) {
      const fixture = makeKubernetesCatalogFixture(feature.id, preset), def = getWidgetDefinition('plugin', feature.id)!;
      expect(() => widgetSchema.parse(fixture.widget)).not.toThrow(); expect(() => parseRecordFrame(fixture.result.records)).not.toThrow();
      expect(() => def.parseConfig!(fixture.widget.config)).not.toThrow(); expect(() => def.validateInput!(fixture.result, fixture.widget.config)).not.toThrow();
      expect(def.layout?.mode).toBe('intrinsic'); expect(fixture.result.records!.rows.length).toBeLessThanOrEqual(1000);
      if (preset === 'empty') expect(fixture.result.records!.rows).toHaveLength(0);
    }
  });
  it('renders ready, gap and empty states without nonfinite geometry or embedded interactive controls', () => {
    for (const feature of kubernetesChartCatalog) for (const preset of feature.presets.filter(p => p !== 'error')) {
      const fixture = makeKubernetesCatalogFixture(feature.id, preset), def = getWidgetDefinition('plugin', feature.id)!;
      const html = renderToStaticMarkup(createElement(def.render, { ...fixture, embedded: true }));
      expect(html).not.toMatch(/NaN|Infinity|undefined/); expect(html).not.toMatch(/role="button"|<button|<select|<input/);
      if (preset !== 'empty') expect(html).toContain('<svg');
    }
  });
  it('exposes non-drag node selection, matrix paging and native time-window controls', () => {
    const render = (id: typeof kubernetesChartCatalog[number]['id']) => renderToStaticMarkup(createElement(getWidgetDefinition('plugin', id)!.render, makeKubernetesCatalogFixture(id)));
    expect(render('kubernetes-placement')).toContain('aria-label="Inspect Kubernetes node"');
    expect(render('kubernetes-throttle-matrix')).toContain('Previous nodes');
    expect(render('kubernetes-throttle-matrix')).toContain('Next nodes');
    const trend = render('kubernetes-resource-trend'); expect(trend).toContain('Chart window start UTC'); expect(trend).toContain('Chart window end UTC'); expect(trend).toContain('Drag across the plot to zoom');
  });
  it('makes gap snapshots visually unavailable rather than painting zero usage', () => {
    const fixture = makeKubernetesCatalogFixture('kubernetes-resource-bars', 'gaps'), html = renderToStaticMarkup(createElement(getWidgetDefinition('plugin', 'kubernetes-resource-bars')!.render, { ...fixture, embedded: true }));
    expect(html).toContain('Unavailable observed'); expect(html).toContain('CPU 0/12');
  });
  it('retains a valid isolated time observation with visible marks and its actual UTC time', () => {
    const fixture = makeKubernetesCatalogFixture('kubernetes-resource-trend');
    fixture.result.records!.rows = [fixture.result.records!.rows.at(-1)!];
    const def = getWidgetDefinition('plugin', 'kubernetes-resource-trend')!;
    expect(() => def.validateInput!(fixture.result, fixture.widget.config)).not.toThrow();
    const html = renderToStaticMarkup(createElement(def.render, fixture));
    expect(html).toContain('12:00 UTC · Workload CPU:');
    expect(html).toContain('12:00 UTC · Memory:');
    expect(html).toContain('12:00 UTC · Network:');
    expect((html.match(/<circle /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain('Chart window start UTC');
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

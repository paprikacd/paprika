import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allChartCatalog, makeCatalogFixture, productCatalogIds } from '../src/catalog/chart-fixtures';

// An entry is "In Paprika" when its fixture widget is one the product renders: a built-in type,
// or a plugin id that the product registers. Everything else is a lab-only concept study.
const { pluginIds } = JSON.parse(readFileSync('../../docs/design/insights/widget-plugins.json', 'utf8')) as { pluginIds: string[] };

describe('catalogue tiers', () => {
  it('marks an entry In Paprika exactly when its fixture widget is a built-in type or a registered product plugin', () => {
    for (const feature of allChartCatalog) {
      const { widget } = makeCatalogFixture(feature.id, 'ready');
      const inProduct = widget.type !== 'plugin' || pluginIds.includes(widget.pluginId ?? '');
      expect(productCatalogIds.has(feature.id), feature.id).toBe(inProduct);
    }
  });

  it('keeps the Kubernetes families and the core catalogue in the product tier', () => {
    for (const id of ['stat', 'timeseries', 'connection-map', 'kubernetes-placement', 'kubernetes-resource-bars', 'kubernetes-throttle-matrix', 'kubernetes-resource-trend'] as const) {
      expect(productCatalogIds.has(id), id).toBe(true);
    }
  });

  it('lists only catalogue ids and plugin ids that exist', () => {
    const ids = new Set<string>(allChartCatalog.map(feature => feature.id));
    for (const id of productCatalogIds) expect(ids.has(id), id).toBe(true);
    expect(productCatalogIds.size).toBe(15);
  });
});

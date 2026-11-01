import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { waferChartCatalog, makeWaferCatalogFixture } from '../src/charts/wafer/catalog';
import { registerWaferCharts } from '../src/charts/wafer/register';
import { waferFocusId, waferKeyboardTarget, waferRows } from '../src/charts/wafer/model';
import { waferFixtures, waferResult } from '../src/lenses/wafer/fixtures';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { widgetSchema } from '../src/renderer-extensions/schema';
import { parseRecordFrame } from '@insights/record-data';

describe('wafer authoring and registered owners', () => {
  registerWaferCharts();
  it('validates every fixture against the canonical transport and the actual renderer adapter', () => {
    for (const feature of waferChartCatalog) for (const preset of feature.presets) {
      const fixture = makeWaferCatalogFixture(feature.id, preset), definition = getWidgetDefinition('plugin', feature.id)!;
      expect(() => widgetSchema.parse(fixture.widget)).not.toThrow();
      expect(() => parseRecordFrame(fixture.result.records)).not.toThrow();
      expect(() => definition.parseConfig!(fixture.widget.config)).not.toThrow();
      expect(() => definition.validateInput!(fixture.result, fixture.widget.config)).not.toThrow();
      expect(definition.layout?.mode).toBe('intrinsic');
      if (preset === 'empty') expect(fixture.result.records!.rows).toHaveLength(0);
    }
  });
  it('rejects absent fields, incompatible column metadata and unrepresentable stage timestamps', () => {
    const def = getWidgetDefinition('plugin', 'wafer-die-map')!;
    const missing = waferResult(); missing.records!.columns.find(c => c.key === 'xMm')!.key = 'renamed';
    expect(() => def.validateInput!(missing, {})).toThrow(/Missing chart column/);
    const wrong = waferResult(); wrong.records!.columns.find(c => c.key === 'column')!.type = 'string';
    expect(() => def.validateInput!(wrong, {})).toThrow(/type number/);
    const units = waferResult(); units.records!.columns.find(c => c.key === 'leakageNA')!.unit = 'A';
    expect(() => def.validateInput!(units, {})).toThrow(/must use nA/);
    const time = waferResult(); const i = time.records!.columns.findIndex(c => c.key === 'cleanAt'); time.records!.rows[0][i] = 1e30;
    expect(() => def.validateInput!(time, {})).toThrow(/timestamp/);
    const chamber = waferFixtures().chambers.result; chamber.records!.columns.find(c => c.key === 'median')!.unit = 'A';
    expect(() => getWidgetDefinition('plugin', 'wafer-chamber-distribution')!.validateInput!(chamber, {})).toThrow(/nA/);
  });
  it('renders ready, missing-test and empty states as passive embedded content', () => {
    for (const feature of waferChartCatalog) for (const preset of feature.presets.filter(p => p !== 'error')) {
      const fixture = makeWaferCatalogFixture(feature.id, preset), definition = getWidgetDefinition('plugin', feature.id)!;
      const html = renderToStaticMarkup(createElement(definition.render, { ...fixture, embedded: true }));
      expect(html).not.toMatch(/NaN|Infinity|undefined/);
      expect(html).not.toMatch(/role="button"|<button|<select|<input/);
      if (preset !== 'empty') expect(html).toContain(feature.id === 'wafer-process-lineage' ? 'Recorded timestamp' : '<svg');
    }
  });
  it('gives the full map non-drag controls, an exact table and one logical die tab stop', () => {
    const fixture = makeWaferCatalogFixture('wafer-die-map'), def = getWidgetDefinition('plugin', 'wafer-die-map')!;
    const html = renderToStaticMarkup(createElement(def.render, fixture));
    expect(html).toContain('aria-label="Zoom in wafer"');
    expect(html).toContain('aria-label="Fit wafer"');
    expect(html).toContain('aria-label="Inspect wafer die"');
    expect(html).toContain('Search exact wafer dies');
    expect(html).toContain('<table');
    expect((html.match(/data-wafer-die="[^"]+" role="button" tabindex="0"/g) ?? [])).toHaveLength(1);
  });
  it('carries real unknown electrical observations through the lineage gap preset', () => {
    const fixture = makeWaferCatalogFixture('wafer-process-lineage', 'gaps'), def = getWidgetDefinition('plugin', 'wafer-process-lineage')!;
    const html = renderToStaticMarkup(createElement(def.render, { ...fixture, embedded: true }));
    expect(html).toContain('No leakage observation');
    expect(html).toContain('Not tested');
    expect(html).toContain('Not recorded');
  });
});

describe('wafer keyboard and linked selection model', () => {
  const dies = waferRows(waferResult().records), centre = dies.find(d => d.column === 0 && d.row === 0)!;
  it('moves through logical die neighbours with physical positive Y pointing up', () => {
    expect(waferKeyboardTarget(dies, centre, 'ArrowUp')).toMatchObject({ row: 1, column: 0, yMm: 10 });
    expect(waferKeyboardTarget(dies, centre, 'ArrowDown')).toMatchObject({ row: -1, column: 0, yMm: -10 });
    expect(waferKeyboardTarget(dies, centre, 'ArrowRight')).toMatchObject({ row: 0, column: 1, xMm: 10 });
    expect(waferKeyboardTarget(dies, centre, 'ArrowLeft')).toMatchObject({ row: 0, column: -1, xMm: -10 });
    expect(waferKeyboardTarget(dies, dies.find(d => d.column === 15)!, 'ArrowRight')).toBeNull();
    expect(waferKeyboardTarget(dies, centre, 'Tab')).toBeNull();
  });
  it('skips filtered marks while recovering a tab stop after wafer or filter changes', () => {
    const removed = dies.find(d => d.column === 0 && d.row === 1)!;
    const visible = dies.filter(d => d.id !== removed.id);
    expect(waferKeyboardTarget(visible, centre, 'ArrowUp')).toMatchObject({ row: 2, column: 0 });
    expect(waferFocusId(visible, removed.id, centre.id)).toBe(centre.id);
    expect(waferFocusId(visible, 'old-wafer-id', null)).toBe(visible[0].id);
    expect(waferFocusId([], removed.id, centre.id)).toBeNull();
    expect(dies).toHaveLength(709);
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { waferRows, waferTransect, waferTransectConfig, waferTransectRows, waferTransectSegments } from '../src/charts/wafer/model';
import { WaferTransect } from '../src/charts/wafer/WaferTransect';
import { makeWaferCatalogFixture } from '../src/charts/wafer/catalog';
import { registerWaferCharts } from '../src/charts/wafer/register';
import { waferResult } from '../src/lenses/wafer/fixtures';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';

const config = waferTransectConfig.parse({ followSelection: false });
const source = waferResult(), dies = waferRows(source.records);

describe('physical wafer cross-sections', () => {
  it('selects physical rows and columns, sorts by coordinate and retains their original observations', () => {
    const reordered = [...dies].reverse(), selected = dies.find(die => die.column === 4 && die.row === -2)!;
    const row = waferTransect(reordered, waferTransectConfig.parse({ selectedDieId: selected.id }));
    expect(row.index).toBe(-2);
    expect(row.fixedMm).toBe(-20);
    expect(row.points.map(die => die.xMm)).toEqual([...row.points.map(die => die.xMm)].sort((a, b) => a - b));
    expect(row.points.every(die => die.row === -2 && dies.includes(die))).toBe(true);
    const column = waferTransect(reordered, waferTransectConfig.parse({ axis: 'column', selectedDieId: selected.id }));
    expect(column.index).toBe(4);
    expect(column.fixedMm).toBe(40);
    expect(column.points.map(die => die.yMm)).toEqual([...column.points.map(die => die.yMm)].sort((a, b) => a - b));
    expect(column.points.every(die => die.column === 4 && dies.includes(die))).toBe(true);
    expect(reordered[0]).toBe(dies.at(-1));
  });

  it('keeps fixed sections independent of linked selection and never treats the index as an array offset', () => {
    const selected = dies.find(die => die.row === -3)!;
    const section = waferTransect(dies, { ...config, index: 4, selectedDieId: selected.id });
    expect(section.index).toBe(4);
    expect(section.points.every(die => die.row === 4)).toBe(true);
    expect(() => waferTransect(dies, { ...config, index: 42 })).toThrow(/index: No supplied die positions/);
    const fallback = waferTransect(dies, waferTransectConfig.parse({ selectedDieId: 'old-wafer:missing', index: -1 }));
    expect(fallback.index).toBe(-1);
  });

  it('never connects across a missing measurement or an unsupplied physical grid slot', () => {
    const points = dies.filter(die => die.row === 0 && Math.abs(die.column) <= 3 && die.column !== 1).map(die => ({ ...die, leakageNA: die.column === -1 ? null : 2 + die.column / 10 }));
    const segments = waferTransectSegments([...points].reverse(), 'row');
    expect(segments.map(segment => segment.map(die => die.column))).toEqual([[-3, -2], [0], [2, 3]]);
    expect(points.find(die => die.column === -1)?.leakageNA).toBeNull();
    const vertical = points.map(die => ({ ...die, row: die.column, column: 0 }));
    expect(waferTransectSegments(vertical, 'column').map(segment => segment.map(die => die.row))).toEqual([[-3, -2], [0], [2, 3]]);
  });

  it('separates missing test coverage, edge exclusions and unavailable leakage from the measured population', () => {
    const section = waferTransect(waferRows(waferResult('W-17', 'gaps').records), config);
    expect(section.observed + section.untested + section.unavailable).toBe(section.eligible);
    expect(section.eligible + section.excluded).toBe(section.points.length);
    expect(section.median).not.toBeNull();
    expect(section.untested).toBeGreaterThan(0);
    const missing = section.points.map(die => ({ ...die, leakageNA: null, probeAt: null, bin: die.bin === 'excluded' ? 'excluded' as const : 'untested' as const }));
    expect(waferTransect(missing, config)).toMatchObject({ observed: 0, median: null, unavailable: 0 });
    expect(waferTransect([], config)).toMatchObject({ points: [], observed: 0, fixedMm: null, median: null });
  });

  it('retains measured zero on linear scale and blocks a misleading log preview', () => {
    const zero = dies.map(die => die.row === 0 && die.column === 0 ? { ...die, leakageNA: 0 } : die);
    expect(() => waferTransect(zero, config)).toThrow(/scale: Logarithmic/);
    const linear = waferTransect(zero, { ...config, scale: 'linear' });
    expect(linear.points.find(die => die.column === 0)?.leakageNA).toBe(0);
    expect(linear.observed).toBe(waferTransect(dies, config).observed);
    // A zero in another section does not prohibit the selected section's log scale.
    expect(() => waferTransect(zero, { ...config, index: 1 })).not.toThrow();
  });
});

describe('wafer cross-section field mapping and independent data', () => {
  it('binds renamed coordinate and leakage columns without modifying the result', () => {
    const renamed = structuredClone(source.records!);
    for (const [oldKey, nextKey] of [['xMm', 'centre_x'], ['yMm', 'centre_y'], ['leakageNA', 'probe_leakage']]) renamed.columns.find(column => column.key === oldKey)!.key = nextKey;
    const waferIndex = renamed.columns.findIndex(column => column.key === 'wafer'), idIndex = renamed.columns.findIndex(column => column.key === 'id');
    renamed.rows = renamed.rows.map((row, i) => row.map((value, j) => j === waferIndex ? 'SAMPLE-42' : j === idIndex ? `independent-${i}` : value)).reverse();
    const snapshot = structuredClone(renamed), mappedConfig = waferTransectConfig.parse({ xField: 'centre_x', yField: 'centre_y', valueField: 'probe_leakage', axis: 'column', followSelection: false, index: 3 });
    const mapped = waferTransectRows(renamed, mappedConfig), section = waferTransect(mapped, mappedConfig);
    expect(section.fixedMm).toBe(30);
    expect(section.points.every(die => die.wafer === 'SAMPLE-42' && die.id.startsWith('independent-'))).toBe(true);
    expect(section.observed).toBe(waferTransect(dies, { ...config, axis: 'column', index: 3 }).observed);
    expect(renamed).toEqual(snapshot);
  });

  it('rejects missing, mistyped, wrong-unit, duplicated and physically inconsistent bindings', () => {
    expect(() => waferTransectRows(source.records, { ...config, valueField: 'renamed' })).toThrow(/valueField: Missing chart column/);
    expect(() => waferTransectRows(source.records, { ...config, valueField: 'bin' })).toThrow(/valueField: bin must have type number/);
    expect(() => waferTransectRows(source.records, { ...config, yField: 'xMm' })).toThrow(/distinct source fields/);
    expect(() => waferTransectRows(source.records, { ...config, xField: 'yMm', yField: 'xMm' })).toThrow(/coordinates disagree/);
    const wrong = structuredClone(source.records!); wrong.columns.find(column => column.key === 'leakageNA')!.unit = 'µA';
    expect(() => waferTransectRows(wrong, config)).toThrow(/must use nA/);
    expect(() => waferTransectConfig.parse({ index: .5 })).toThrow();
    expect(() => waferTransectConfig.parse({ unsupported: true })).toThrow();
  });

  it('advertises field types and rejects invalid input before preview promotion', () => {
    registerWaferCharts();
    const definition = getWidgetDefinition('plugin', 'wafer-transect')!;
    expect(definition.configFields?.find(field => field.key === 'valueField')?.binding).toMatchObject({ types: ['number'], unit: 'nA' });
    expect(() => definition.validateInput!(source, { index: 50, followSelection: false })).toThrow(/No supplied die/);
    expect(() => definition.validateInput!(source, { valueField: 'not_in_result' })).toThrow(/Missing chart column/);
    expect(() => definition.parseConfig!({ scale: 'symlog' })).toThrow();
  });

  it('renders clear source scope, exact alternatives and one logical plot tab stop', () => {
    const fixture = makeWaferCatalogFixture('wafer-transect');
    const html = renderToStaticMarkup(createElement(WaferTransect, fixture));
    expect(html).toContain('Physical X coordinate (mm)');
    expect(html).toContain('Exact section values');
    expect(html).toContain('aria-label="Inspect wafer transect die"');
    expect(html).toContain('Unmeasured positions in separate lane');
    expect(html).toContain('<table');
    expect((html.match(/data-transect-die="[^"]+" role="button" tabindex="0"/g) ?? [])).toHaveLength(1);
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { allocationColor, allocationRecords, allocationTreemapConfig, financeHistory, financePanels, FINANCE_AS_OF, FINANCE_HOLDINGS, summarizeHoldings } from '../src/lenses/finance-data';
import { AllocationTreemap } from '../src/lenses/FinanceLens';
import { getWidgetDefinition } from '@insights/widget-registry';
import { widgetSchema } from '@insights/schema';
import { parseRecordFrame } from '@insights/record-data';

describe('finance lens accounting and allocation', () => {
  it('reconciles holdings, sector weights, cash and the portfolio headline', () => {
    const summary = summarizeHoldings();
    expect(summary.value).toBeCloseTo(FINANCE_HOLDINGS.reduce((sum, item) => sum + item.shares * item.price, 0), 8);
    expect(summary.sectors.reduce((sum, sector) => sum + sector.value, 0)).toBeCloseTo(summary.value, 8);
    expect(summary.sectors.reduce((sum, sector) => sum + sector.weight, 0)).toBeCloseTo(100, 12);
    expect(summary.cash).toBe(138000);
    expect(summary.equityWeight + summary.cash / summary.value * 100).toBeCloseTo(100, 12);
  });

  it('pools previous closing values rather than averaging holding percentage changes', () => {
    const summary = summarizeHoldings();
    expect(summary.dayPnl).toBeCloseTo(FINANCE_HOLDINGS.reduce((sum, holding) => sum + holding.dayPnl, 0), 8);
    expect(summary.sectors.reduce((sum, sector) => sum + sector.dayPnl, 0)).toBeCloseTo(summary.dayPnl, 8);
    expect(summary.dayChange).toBeCloseTo(summary.dayPnl / summary.previousValue * 100, 12);
    const technology = summary.sectors.find(sector => sector.name === 'Technology')!;
    const techPrevious = FINANCE_HOLDINGS.filter(item => item.sector === 'Technology').reduce((sum, item) => sum + item.previousValue, 0);
    expect(technology.change).toBeCloseTo((technology.value / techPrevious - 1) * 100, 12);
  });

  it('rebases every performance window and reconciles its final daily return to the holdings', () => {
    const snapshot = summarizeHoldings();
    for (const days of [30, 90, 180] as const) {
      const history = financeHistory(days);
      expect(history).toHaveLength(days);
      expect(history[0].portfolio).toBe(0);
      expect(history[0].benchmark).toBe(0);
      expect(history.at(-1)!.timestamp).toBe(FINANCE_AS_OF);
      expect(history[1].timestamp - history[0].timestamp).toBe(86_400_000);
      const previous = 1 + history.at(-2)!.portfolio / 100, current = 1 + history.at(-1)!.portfolio / 100;
      expect((current / previous - 1) * 100).toBeCloseTo(snapshot.dayChange, 10);
    }
  });

  it('sizes negative-return holdings by their positive market value, preserving source records', () => {
    const { allocation } = financePanels();
    const frame = allocation.result.records!;
    const before = JSON.stringify(frame);
    const built = allocationRecords(frame, allocationTreemapConfig.parse(allocation.widget.config));
    expect(built.records).toHaveLength(FINANCE_HOLDINGS.length);
    expect(built.records.some(record => record.change! < 0 && record.value > 0)).toBe(true);
    expect(built.total).toBeCloseTo(summarizeHoldings().value, 8);
    expect(built.omitted).toBe(0);
    expect(JSON.stringify(frame)).toBe(before);
  });

  it('discloses omitted values, keeps missing change unknown, and does not manufacture zero area', () => {
    const frame = financePanels().allocation.result.records!;
    const modified = { ...frame, rows: [['ZERO', 'Zero', 'Test', 0, 0], ['MISSING', 'Missing', 'Test', null, 2], ['NEG', 'Negative', 'Test', -1, -3], ['UNKNOWN', 'Unknown change', 'Test', 100, null]] };
    const built = allocationRecords(modified, allocationTreemapConfig.parse({}));
    expect(built.zero).toBe(1);
    expect(built.omitted).toBe(2);
    expect(built.total).toBe(100);
    expect(built.records[0].change).toBeNull();
  });

  it('rejects ambiguous identity and invalid field mappings', () => {
    const frame = financePanels().allocation.result.records!;
    expect(() => allocationRecords({ ...frame, rows: [frame.rows[0], frame.rows[0]] }, allocationTreemapConfig.parse({}))).toThrow(/unique/);
    expect(() => allocationRecords(frame, allocationTreemapConfig.parse({ value: 'missing' }))).toThrow(/Missing/);
    expect(() => allocationRecords(frame, allocationTreemapConfig.parse({ value: 'symbol' }))).toThrow(/numeric/);
    expect(allocationTreemapConfig.safeParse({ colorLimit: 0 }).success).toBe(false);
    expect(allocationTreemapConfig.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('uses a stable zero midpoint and clips only the visual color scale', () => {
    expect(allocationColor(0)).toBe('var(--gamma-chart-grid)');
    expect(allocationColor(1)).toContain('var(--gamma-success)');
    expect(allocationColor(-1)).toContain('var(--gamma-danger)');
    expect(allocationColor(null)).not.toBe(allocationColor(0));
    expect(allocationColor(-100)).toBe(allocationColor(-3));
    expect(allocationColor(100)).toBe(allocationColor(3));
    expect(allocationColor(-1)).not.toBe(allocationColor(1));
  });

  it('accepts the existing widget and record contracts with exact weight rows', () => {
    const panels = financePanels();
    for (const panel of [panels.allocation, panels.performance, panels.holdings]) {
      expect(widgetSchema.safeParse(panel.widget).success).toBe(true);
      const definition = getWidgetDefinition(panel.widget)!;
      expect(definition).toBeDefined();
      expect(() => definition.parseConfig?.(panel.widget.config)).not.toThrow();
      if (panel.result.records) expect(parseRecordFrame(panel.result.records)).toEqual(panel.result.records);
    }
    expect(panels.holdings.result.records!.rows.reduce((sum, row) => sum + Number(row[3]), 0)).toBeCloseTo(100, 12);
  });

  it('renders the registered allocation chart with positive geometry and accessible exact values', () => {
    const panel = financePanels().allocation;
    const markup = renderToStaticMarkup(createElement(AllocationTreemap, { ...panel, onContextChange: () => {} }));
    expect(markup).toContain('Open Technology sector');
    expect(markup).toContain('Market value');
    expect(markup).toContain('MSFT:');
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('Infinity');
  });
});

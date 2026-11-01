import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MARKET_AS_OF, MARKET_POSITIONS, marketSummary, marketHistory, marketContribution, marketCorrelations, marketRiskPanels, pairedCorrelation } from '../src/lenses/market-risk-data';
import { correlationCells, correlationConfig, correlationColor, liquidityConfig, liquiditySegments, waterfallConfig, waterfallSteps } from '../src/charts/market-risk/market-chart-data';
import { CorrelationMatrix, ContributionWaterfall, LiquidityLadder } from '../src/charts/market-risk/MarketCharts';
import { registerMarketCharts } from '../src/charts/market-risk/register';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { widgetSchema, type RecordFrame } from '../src/renderer-extensions/schema';
import { parseRecordFrame } from '@insights/record-data';

describe('Market Risk accounting and analytical evidence', () => {
  it('reconciles 35 unchanged synthetic positions, prices, NAV and daily change', () => {
    const summary = marketSummary();
    expect(MARKET_POSITIONS).toHaveLength(35);
    expect(summary.value).toBe(24_800_000);
    expect(MARKET_POSITIONS.reduce((sum, position) => sum + position.price * position.shares, 0)).toBeCloseTo(summary.value, 6);
    expect(MARKET_POSITIONS.reduce((sum, position) => sum + position.dayPnl, 0)).toBeCloseTo(summary.dayPnl, 6);
    expect(summary.dayChange).toBeCloseTo((summary.value / summary.previousValue - 1) * 100, 12);
    expect(MARKET_POSITIONS.reduce((sum, position) => sum + position.value / summary.value * 100, 0)).toBeCloseTo(100, 12);
  });

  it('rebases comparison histories, reconciles final close and preserves the same daily P&L across windows', () => {
    const summary = marketSummary();
    for (const days of [14, 30, 90] as const) {
      const history = marketHistory(days);
      expect(history).toHaveLength(days);
      expect(history[0].portfolio).toBe(0);
      expect(history[0].benchmark).toBe(0);
      expect(history.at(-1)!.timestamp).toBe(MARKET_AS_OF);
      expect(history.at(-1)!.value).toBe(summary.value);
      expect(history.at(-2)!.value).toBeCloseTo(summary.previousValue, 6);
      expect(history.at(-1)!.value - history.at(-2)!.value).toBeCloseTo(summary.dayPnl, 6);
      let peak = history[0].value;
      for (const point of history) { peak = Math.max(peak, point.value); expect(point.drawdown).toBeLessThanOrEqual(0); expect(point.drawdown).toBeCloseTo((point.value / peak - 1) * 100, 12); }
    }
  });

  it('reconciles sector contribution with plotted period return, including cash', () => {
    for (const days of [14, 30, 90] as const) {
      const contributions = marketContribution(days), panels = marketRiskPanels(days);
      expect(contributions.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(marketHistory(days).at(-1)!.portfolio, 10);
      expect(contributions.find(item => item.sector === 'Cash')!.value).toBe(0);
      const waterfall = waterfallSteps(panels.waterfall.result.records!, waterfallConfig.parse(panels.waterfall.widget.config));
      expect(waterfall.total).toBeCloseTo(marketHistory(days).at(-1)!.portfolio, 10);
    }
  });

  it('keeps negative contributions and unknown totals distinct from zero', () => {
    const frame: RecordFrame = { columns: [{ key:'label',type:'string' },{key:'value',type:'number'}], rows: [['Large', 4], ['Loss', -2], ['Flat', 0]] };
    const waterfall = waterfallSteps(frame, waterfallConfig.parse({}));
    expect(waterfall.steps[1]).toMatchObject({ value: -2, start: 4, end: 2 });
    expect(waterfall.total).toBe(2);
    const missing = waterfallSteps({ ...frame, rows: [['Large',4],['Unknown',null],['Flat',0]] }, waterfallConfig.parse({}));
    expect(missing.total).toBeNull();
    expect(missing.incomplete).toBe(true);
    expect(missing.steps[2].value).toBe(0);
    expect(missing.steps[2].end).toBeNull();
  });

  it('computes a symmetric bounded correlation matrix from paired observations', () => {
    for (const days of [14, 30, 90] as const) {
      const matrix = correlationCells(marketCorrelations(days), correlationConfig.parse({ samples:'samples' }));
      expect(matrix.labels).toHaveLength(8); expect(matrix.cells).toHaveLength(64);
      for (const cell of matrix.cells) {
        expect(cell.samples).toBe(days - 1);
        expect(cell.value).not.toBeNull();
        expect(cell.value!).toBeGreaterThanOrEqual(-1); expect(cell.value!).toBeLessThanOrEqual(1);
        expect(cell.value).toBeCloseTo(matrix.cells.find(other => other.row === cell.column && other.column === cell.row)!.value!, 10);
        if (cell.row === cell.column) expect(cell.value).toBeCloseTo(1, 12);
      }
    }
  });

  it('does not turn missing or constant daily returns into observed correlation', () => {
    expect(pairedCorrelation([1,2,null,3], [3,2,7,1], 3)).toEqual({ value:-1, samples:3 });
    expect(pairedCorrelation([1,null,3],[1,2,3],3)).toEqual({ value:null, samples:2 });
    expect(pairedCorrelation([1,1,1],[1,2,3],3)).toEqual({ value:null, samples:3 });
    expect(correlationColor(null)).not.toBe(correlationColor(0));
    const frame: RecordFrame = { columns:[{key:'row',type:'string'},{key:'column',type:'string'},{key:'value',type:'number'}], rows:[['A','A',1],['B','B',1],['A','B',null],['B','A',null]] };
    expect(correlationCells(frame, correlationConfig.parse({})).cells.filter(cell => cell.value === null)).toHaveLength(2);
    expect(() => correlationCells({ ...frame, rows:[['A','A',.5]] }, correlationConfig.parse({}))).toThrow(/diagonal/);
    expect(() => correlationCells({ ...frame, rows:[['A','A',1],['B','B',1],['A','B',.7],['B','A',.3]] }, correlationConfig.parse({}))).toThrow(/symmetric/);
  });

  it('reconciles liquidity segments and horizons to the same NAV without double counting', () => {
    const { liquidity, summary } = marketRiskPanels(), source = liquidity.result.records!, before = JSON.stringify(source);
    const chart = liquiditySegments(source, liquidityConfig.parse(liquidity.widget.config));
    expect(chart.groups).toHaveLength(5);
    expect(chart.total).toBe(summary.value);
    expect(chart.groups.slice(0,2).reduce((sum, group) => sum + group.total!, 0)).toBe(summary.liquid);
    expect(chart.groups.every(group => group.total! > 0)).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('supports unrelated category names and preserves missing magnitudes in the liquidity adapter', () => {
    const frame: RecordFrame = { columns:[{key:'bucket',type:'string'},{key:'category',type:'string'},{key:'value',type:'number'}], rows:[['Tomorrow','Reserve',200],['Tomorrow','Other',0],['Later','Reserve',null],['Later','Other',5]] };
    const chart = liquiditySegments(frame, liquidityConfig.parse({}));
    expect(chart.groups[0].total).toBe(200); expect(chart.groups[1].total).toBeNull(); expect(chart.total).toBeNull();
    expect(() => liquiditySegments({ ...frame, rows:[['Tomorrow','Reserve',-2]] }, liquidityConfig.parse({}))).toThrow(/nonnegative/);
    expect(() => liquiditySegments({ ...frame, rows:[frame.rows[0],frame.rows[0]] }, liquidityConfig.parse({}))).toThrow(/unique/);
  });

  it('registers strict host-compatible plugins independently of a previously visited route', () => {
    registerMarketCharts(); registerMarketCharts();
    const panels = marketRiskPanels();
    for (const panel of [panels.waterfall, panels.correlation, panels.liquidity]) {
      const definition = getWidgetDefinition(panel.widget)!;
      expect(definition).toBeDefined(); expect(widgetSchema.safeParse(panel.widget).success).toBe(true);
      expect(() => definition.parseConfig?.(panel.widget.config)).not.toThrow();
      expect(() => definition.parseConfig?.({ ...panel.widget.config, inventedEffect:true })).toThrow();
      expect(parseRecordFrame(panel.result.records!)).toEqual(panel.result.records);
    }
  });

  it('renders static embedded charts without nested interactive controls', () => {
    const panels = marketRiskPanels();
    for (const [render, panel] of [[ContributionWaterfall,panels.waterfall],[CorrelationMatrix,panels.correlation],[LiquidityLadder,panels.liquidity]] as const) {
      const markup = renderToStaticMarkup(createElement(render,{ widget:panel.widget,result:panel.result,embedded:true }));
      expect(markup).toContain('<svg'); expect(markup).not.toContain('role="button"'); expect(markup).not.toContain('<button');
    }
  });
});

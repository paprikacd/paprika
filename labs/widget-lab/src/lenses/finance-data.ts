import { z } from 'zod';
import type { QueryResult, RecordFrame, Widget } from '../renderer-extensions/schema';

export const FINANCE_AS_OF = Date.UTC(2026, 9, 30, 20);
export type FinanceWindow = 30 | 90 | 180;
export interface Holding {
  symbol: string; name: string; sector: string; shares: number; price: number; change: number;
  value: number; previousValue: number; dayPnl: number;
}

// Deliberately authored closing prices and positions; these are not market quotes.
const positions: Array<[string, string, string, number, number, number]> = [
  ['NVDA', 'NVIDIA', 'Technology', 1720, 143.8, 2.42],
  ['MSFT', 'Microsoft', 'Technology', 630, 428.2, .82],
  ['AAPL', 'Apple', 'Technology', 1180, 229.4, -.46],
  ['GOOGL', 'Alphabet', 'Communication', 1050, 177.65, 1.14],
  ['META', 'Meta Platforms', 'Communication', 305, 581.2, 1.78],
  ['AMZN', 'Amazon', 'Consumer', 845, 204.3, -.92],
  ['COST', 'Costco', 'Consumer', 123, 892.3, .31],
  ['JPM', 'JPMorgan Chase', 'Financials', 710, 226.2, .64],
  ['V', 'Visa', 'Financials', 455, 285.9, -.23],
  ['BRK.B', 'Berkshire Hathaway', 'Financials', 430, 462.1, .36],
  ['UNH', 'UnitedHealth', 'Healthcare', 220, 548.6, -1.58],
  ['LLY', 'Eli Lilly', 'Healthcare', 170, 812.4, .72],
  ['XOM', 'Exxon Mobil', 'Energy', 930, 119.8, -1.12],
  ['NEE', 'NextEra Energy', 'Utilities', 1080, 79.35, .54],
  ['CASH', 'US dollar cash', 'Cash', 1, 138000, 0],
];

export const FINANCE_HOLDINGS: readonly Holding[] = positions.map(([symbol, name, sector, shares, price, change]) => {
  const value = Math.round(shares * price * 100) / 100;
  const previousValue = value / (1 + change / 100);
  return { symbol, name, sector, shares, price, change, value, previousValue, dayPnl: value - previousValue };
});

export function summarizeHoldings(holdings: readonly Holding[] = FINANCE_HOLDINGS) {
  const value = holdings.reduce((sum, holding) => sum + holding.value, 0);
  const previousValue = holdings.reduce((sum, holding) => sum + holding.previousValue, 0);
  const cash = holdings.filter(holding => holding.sector === 'Cash').reduce((sum, holding) => sum + holding.value, 0);
  const sectors = [...new Set(holdings.map(holding => holding.sector))].map(name => {
    const items = holdings.filter(holding => holding.sector === name);
    const total = items.reduce((sum, holding) => sum + holding.value, 0);
    const previous = items.reduce((sum, holding) => sum + holding.previousValue, 0);
    return { name, value: total, weight: value ? total / value * 100 : 0, change: previous ? (total / previous - 1) * 100 : 0, dayPnl: total - previous, holdings: items.length };
  }).sort((a, b) => b.value - a.value);
  return { value, previousValue, dayPnl: value - previousValue, dayChange: previousValue ? (value / previousValue - 1) * 100 : 0, cash, equityWeight: value ? (value - cash) / value * 100 : 0, sectors, topThreeWeight: value ? [...holdings].sort((a, b) => b.value - a.value).slice(0, 3).reduce((sum, holding) => sum + holding.value, 0) / value * 100 : 0 };
}

export function financeHistory(days: FinanceWindow) {
  const complete = Array.from({ length: 180 }, (_, i) => {
    const portfolio = 100 + i * .072 + Math.sin(i * .17) * .92 + Math.sin(i * .71) * .38 - 2.4 * Math.exp(-(((i - 124) / 6) ** 2));
    const benchmark = 100 + i * .049 + Math.sin(i * .15) * .58 + Math.sin(i * .51) * .21 - 1.7 * Math.exp(-(((i - 124) / 7) ** 2));
    return { timestamp: FINANCE_AS_OF - (179 - i) * 86_400_000, portfolio, benchmark };
  });
  // The final daily movement reconciles to the same holdings as the headline.
  const snapshot = summarizeHoldings();
  complete[178].portfolio = complete[179].portfolio * snapshot.previousValue / snapshot.value;
  const all = complete.slice(-days);
  const origin = all[0];
  return all.map(point => ({ timestamp: point.timestamp, portfolio: (point.portfolio / origin.portfolio - 1) * 100, benchmark: (point.benchmark / origin.benchmark - 1) * 100 }));
}

export const allocationTreemapConfig = z.strictObject({
  label: z.string().min(1).default('symbol'),
  value: z.string().min(1).default('value'),
  group: z.string().min(1).default('sector'),
  change: z.string().min(1).optional().default('change'),
  showLabels: z.boolean().default(true),
  colorLimit: z.number().finite().positive().max(100).default(3),
});
export type AllocationConfig = z.infer<typeof allocationTreemapConfig>;
export interface AllocationRecord { id: string; label: string; name: string; group: string; value: number; change: number | null; row: RecordFrame['rows'][number] }

export function allocationRecords(frame: RecordFrame, config: AllocationConfig) {
  const index = (key: string) => {
    const position = frame.columns.findIndex(column => column.key === key);
    if (position < 0) throw new Error(`Missing allocation column “${key}”.`);
    return position;
  };
  const label = index(config.label), value = index(config.value), group = index(config.group), change = config.change ? index(config.change) : -1;
  const name = frame.columns.findIndex(column => column.key === 'name');
  if (frame.columns[value].type !== 'number' || (change >= 0 && frame.columns[change].type !== 'number')) throw new Error('Allocation value and change columns must be numeric.');
  const seen = new Set<string>();
  let omitted = 0, zero = 0;
  const records: AllocationRecord[] = [];
  for (const row of frame.rows) {
    if (typeof row[value] !== 'number' || !Number.isFinite(row[value]) || row[value] < 0 || row[label] === null || row[group] === null) { omitted++; continue; }
    if (row[value] === 0) { zero++; continue; }
    const id = JSON.stringify([row[group], row[label]]);
    if (seen.has(id)) throw new Error('Allocation labels must be unique within each group.');
    seen.add(id);
    const delta = change >= 0 && typeof row[change] === 'number' && Number.isFinite(row[change]) ? row[change] as number : null;
    records.push({ id, label: String(row[label]), name: name >= 0 ? String(row[name] ?? row[label]) : String(row[label]), group: String(row[group]), value: row[value] as number, change: delta, row });
  }
  return { records, omitted, zero, total: records.reduce((sum, item) => sum + item.value, 0) };
}

/** A fixed zero-centred diverging scale. Display clipping never changes the exact change. */
/** Gain and loss tint in Gamma tokens: the grid colour at zero, success or danger toward the clip limit. */
export function allocationColor(change: number | null, limit = 3) {
  if (change === null) return 'color-mix(in srgb, var(--gamma-muted) 30%, var(--gamma-chart-grid))';
  const magnitude = Math.min(1, Math.abs(change) / limit);
  if (magnitude === 0) return 'var(--gamma-chart-grid)';
  const token = change < 0 ? 'var(--gamma-danger)' : 'var(--gamma-success)';
  return `color-mix(in srgb, ${token} ${Math.round(magnitude * 100)}%, var(--gamma-chart-grid))`;
}

const baseWidget = (id: string, title: string): Widget => ({ id, title, type: 'plugin', dataKind: 'records', pluginId: 'record-table', providerId: 'finance-fixture', query: 'synthetic.portfolio.closing_snapshot', unit: '', layout: { x: 0, y: 0, w: 6, h: 5 } });

export function financePanels(days: FinanceWindow = 30) {
  const summary = summarizeHoldings(), history = financeHistory(days);
  const allocationResult: QueryResult = { records: {
    columns: [{ key: 'symbol', label: 'Holding', type: 'string' }, { key: 'name', label: 'Name', type: 'string' }, { key: 'sector', label: 'Sector', type: 'string' }, { key: 'value', label: 'Market value', type: 'number', unit: 'USD' }, { key: 'change', label: 'Day change', type: 'number', unit: '%' }],
    rows: FINANCE_HOLDINGS.map(holding => [holding.symbol, holding.name, holding.sector, holding.value, holding.change]),
  } };
  const allocation: { widget: Widget; result: QueryResult } = { widget: { ...baseWidget('finance-allocation', 'Portfolio allocation'), pluginId: 'allocation-treemap', unit: 'USD', config: allocationTreemapConfig.parse({}), options: { showTooltip: true, decimals: 2 } }, result: allocationResult };
  const performance: { widget: Widget; result: QueryResult } = {
    widget: { ...baseWidget('finance-performance', 'Cumulative return'), type: 'timeseries', dataKind: undefined, pluginId: undefined, unit: '%', query: 'synthetic.portfolio.daily_return', color: '#00d5b1', options: { display: 'area', timeAxis: 'calendar', gridX: true, showGrid: true, showLegend: true, showTooltip: true, fillStyle: 'gradient', fillOpacity: .14, lineWidth: 1.5, curve: 'linear', decimals: 2, inspectorDensity: 'compact', showZeroLine: true } },
    result: { series: [{ name: 'Portfolio', labels: { portfolio: 'Core allocation', fixture: 'synthetic', basis: 'Period start = 0%' }, points: history.map(point => ({ timestamp: point.timestamp, value: point.portfolio })) }, { name: 'Reference basket', labels: { fixture: 'synthetic', basis: 'Period start = 0%' }, points: history.map(point => ({ timestamp: point.timestamp, value: point.benchmark })) }] },
  };
  const holdings: { widget: Widget; result: QueryResult } = {
    widget: { ...baseWidget('finance-holdings', 'Holdings ledger'), config: { columns: ['symbol', 'sector', 'value', 'weight', 'change'], density: 'compact', showSearch: true, pageSize: 20, cellStyles: [{ column: 'weight', display: 'bar', min: 0, max: 15 }, { column: 'change', display: 'color-text' }] }, color: '#08cdb0', options: { decimals: 2, thresholds: [{ value: -100, color: '#f47786', label: 'Decline' }, { value: 0, color: '#08d8b5', label: 'Gain' }] } },
    result: { records: { columns: [{ key: 'symbol', label: 'Holding', type: 'string' }, { key: 'sector', label: 'Sector', type: 'string' }, { key: 'value', label: 'Market value', type: 'number', unit: 'USD' }, { key: 'weight', label: 'Weight', type: 'number', unit: '%' }, { key: 'change', label: '1D', type: 'number', unit: '%' }], rows: [...FINANCE_HOLDINGS].sort((a, b) => b.value - a.value).map(holding => [holding.symbol, holding.sector, holding.value, holding.value / summary.value * 100, holding.change]) } },
  };
  return { allocation, performance, holdings, summary, history };
}

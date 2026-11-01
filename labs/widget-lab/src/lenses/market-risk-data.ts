import type { QueryResult, RecordFrame, Widget } from '../renderer-extensions/schema';
import { allocationTreemapConfig } from './finance-data';

export const MARKET_AS_OF = Date.UTC(2026, 9, 31, 9, 30);
export const MARKET_DAY = 86_400_000;
export type MarketWindow = 14 | 30 | 90;
export type MarketPanel = { widget: Widget; result: QueryResult };
export type MarketPosition = { symbol: string; name: string; sector: string; value: number; previousValue: number; dayChange: number; dayPnl: number; shares: number; price: number; liquidity: string; history: number[] };

// Authored synthetic closing positions. Familiar symbols are identifiers, not market quotes.
const authored: Array<[string, string, string, number, number]> = [
  ['AAPL', 'Apple', 'Technology', 2803, 1.2], ['MSFT', 'Microsoft', 'Technology', 1912, .6], ['NVDA', 'NVIDIA', 'Technology', 1289, 2.4], ['AVGO', 'Broadcom', 'Technology', 600, 1.1], ['ORCL', 'Oracle', 'Technology', 420, -.8], ['CSCO', 'Cisco', 'Technology', 320, .3], ['AMD', 'AMD', 'Technology', 310, 1.5], ['CRM', 'Salesforce', 'Technology', 290, -1.1], ['ADBE', 'Adobe', 'Technology', 220, .6], ['INTC', 'Intel', 'Technology', 180, -.4],
  ['JPM', 'JPMorgan Chase', 'Financials', 1630, .4], ['BAC', 'Bank of America', 'Financials', 900, -1.2], ['WFC', 'Wells Fargo', 'Financials', 700, -.6], ['C', 'Citigroup', 'Financials', 600, -.8], ['GS', 'Goldman Sachs', 'Financials', 600, 1.1], ['MS', 'Morgan Stanley', 'Financials', 500, .8], ['BLK', 'BlackRock', 'Financials', 400, .9], ['AXP', 'American Express', 'Financials', 300, -.7], ['SCHW', 'Charles Schwab', 'Financials', 300, 1.4], ['KKR', 'KKR', 'Financials', 300, .5],
  ['LLY', 'Eli Lilly', 'Healthcare', 1118, .9], ['JNJ', 'Johnson & Johnson', 'Healthcare', 600, -.4], ['MRK', 'Merck', 'Healthcare', 500, -.8], ['ABBV', 'AbbVie', 'Healthcare', 400, .6], ['TMO', 'Thermo Fisher', 'Healthcare', 400, 1.3], ['DHR', 'Danaher', 'Healthcare', 300, -1.1],
  ['XOM', 'Exxon Mobil', 'Energy', 895, -1.5], ['CVX', 'Chevron', 'Energy', 800, -.9], ['COP', 'ConocoPhillips', 'Energy', 400, -.3], ['SLB', 'SLB', 'Energy', 300, .3],
  ['GE', 'GE Aerospace', 'Industrials', 800, 1], ['CAT', 'Caterpillar', 'Industrials', 500, -.6], ['DE', 'Deere', 'Industrials', 400, .4], ['UPS', 'UPS', 'Industrials', 200, -1.1], ['USD', 'US dollar cash', 'Cash', 500, 0],
];
export const LIQUIDITY_BUCKETS = ['≤ 1 day', '1–7 days', '7–30 days', '30–90 days', '> 90 days'] as const;
const originalTotal = authored.reduce((sum, row) => sum + row[3], 0);
const closingValues = authored.map(row => Math.round(row[3] / originalTotal * 24_800_000));
closingValues[closingValues.length - 1] += 24_800_000 - closingValues.reduce((sum, value) => sum + value, 0);
const marketPath = (day: number, identity: number) => 100 + day * (.047 + identity % 5 * .007) + Math.sin(day * .41) * .58 + Math.sin(day * 1.17 + identity * .6) * .33 - 3.2 * Math.exp(-(((day - 75) / 3.8) ** 2)) + Math.sin(day * .17 + identity) * .48;
export const MARKET_POSITIONS: readonly MarketPosition[] = authored.map(([symbol, name, sector, , dayChange], index) => {
  const value = closingValues[index], previousValue = value / (1 + dayChange / 100);
  const history = Array.from({ length: 90 }, (_, day) => sector === 'Cash' ? value : value * marketPath(day, index) / marketPath(89, index));
  history[88] = previousValue; history[89] = value;
  const shares = sector === 'Cash' ? 1 : 5000 + index * 600;
  const liquidity = sector === 'Cash' || index < 23 ? LIQUIDITY_BUCKETS[0] : index < 29 ? LIQUIDITY_BUCKETS[1] : index < 32 ? LIQUIDITY_BUCKETS[2] : index < 33 ? LIQUIDITY_BUCKETS[3] : LIQUIDITY_BUCKETS[4];
  return { symbol, name, sector, value, previousValue, dayChange, dayPnl: value - previousValue, shares, price: value / shares, liquidity, history };
});

export function marketSummary(positions = MARKET_POSITIONS) {
  const value = positions.reduce((sum, position) => sum + position.value, 0), previousValue = positions.reduce((sum, position) => sum + position.previousValue, 0);
  const liquid = positions.filter(position => position.liquidity === LIQUIDITY_BUCKETS[0] || position.liquidity === LIQUIDITY_BUCKETS[1]).reduce((sum, position) => sum + position.value, 0);
  return { value, previousValue, dayPnl: value - previousValue, dayChange: previousValue ? (value / previousValue - 1) * 100 : null, liquid, liquidPercent: value ? liquid / value * 100 : null };
}

export function marketHistory(days: MarketWindow, positions = MARKET_POSITIONS) {
  const start = 90 - days, values = Array.from({ length: days }, (_, i) => positions.reduce((sum, position) => sum + position.history[start + i], 0));
  const benchmark = (day: number) => 100 + day * .039 + Math.sin(day * .4) * .22 - 1.7 * Math.exp(-(((day - 75) / 4) ** 2));
  let peak = values[0];
  return values.map((value, i) => {
    peak = Math.max(peak, value);
    return { timestamp: MARKET_AS_OF - (days - 1 - i) * MARKET_DAY, value, portfolio: (value / values[0] - 1) * 100, benchmark: (benchmark(start + i) / benchmark(start) - 1) * 100, drawdown: (value / peak - 1) * 100 };
  });
}

export function marketContribution(days: MarketWindow, positions = MARKET_POSITIONS) {
  const start = 90 - days, base = positions.reduce((sum, position) => sum + position.history[start], 0);
  return [...new Set(positions.map(position => position.sector))].map(sector => {
    const items = positions.filter(position => position.sector === sector);
    return { sector, value: items.reduce((sum, position) => sum + position.value - position.history[start], 0) / base * 100 };
  });
}

/** Paired finite observations only. Insufficient or constant evidence is unknown. */
export function pairedCorrelation(a: readonly (number | null)[], b: readonly (number | null)[], minimum = 8): { value: number | null; samples: number } {
  const pairs = a.map((value, index) => [value, b[index]] as const).filter((pair): pair is readonly [number, number] => typeof pair[0] === 'number' && Number.isFinite(pair[0]) && typeof pair[1] === 'number' && Number.isFinite(pair[1]));
  if (pairs.length < minimum) return { value: null, samples: pairs.length };
  const mx = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length, my = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  const covariance = pairs.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0), vx = pairs.reduce((sum, [x]) => sum + (x - mx) ** 2, 0), vy = pairs.reduce((sum, [, y]) => sum + (y - my) ** 2, 0);
  return { value: vx > 0 && vy > 0 ? Math.max(-1, Math.min(1, covariance / Math.sqrt(vx * vy))) : null, samples: pairs.length };
}

export const CORRELATION_ASSETS = ['SPX', 'NDX', 'DAX', 'FTSE', 'HSI', 'US10Y', 'GOLD', 'BTC'];
export function marketCorrelations(days: MarketWindow): RecordFrame {
  const returns = CORRELATION_ASSETS.map((_, asset) => Array.from({ length: days - 1 }, (__, day) => {
    const d = day + 90 - days;
    const market = Math.sin(d * .74) * .6 + Math.cos(d * .29) * .3;
    return market * (asset === 5 ? -.38 : asset === 6 ? .1 : .8) + Math.sin(d * (asset * .143 + .37) + asset) * (asset === 7 ? 1.3 : .23 + asset * .06);
  }));
  return { columns: [{ key: 'row', label: 'Asset', type: 'string' }, { key: 'column', label: 'Comparison', type: 'string' }, { key: 'value', label: 'Pearson r', type: 'number' }, { key: 'samples', label: 'Paired daily returns', type: 'number' }], rows: CORRELATION_ASSETS.flatMap((asset, row) => CORRELATION_ASSETS.map((comparison, column) => { const correlation = pairedCorrelation(returns[row], returns[column]); return [asset, comparison, correlation.value, correlation.samples]; })) };
}

const recordWidget = (id: string, title: string, pluginId: string, unit = ''): Widget => ({ id, title, type: 'plugin', pluginId, dataKind: 'records', providerId: 'market-risk-fixture', query: 'synthetic.market_risk.closing_snapshot', unit, layout: { x: 0, y: 0, w: 6, h: 5 }, options: { showTooltip: true, showLegend: true, decimals: 2 } });
export function marketRiskPanels(days: MarketWindow = 30) {
  const summary = marketSummary(), history = marketHistory(days), contributions = marketContribution(days);
  const allocation: MarketPanel = { widget: { ...recordWidget('market-allocation', 'Allocation by sector and holding', 'allocation-treemap', 'USD'), config: allocationTreemapConfig.parse({}) }, result: { records: { columns: [{ key: 'symbol', label: 'Holding', type: 'string' }, { key: 'name', label: 'Name', type: 'string' }, { key: 'sector', label: 'Sector', type: 'string' }, { key: 'value', label: 'Market value', type: 'number', unit: 'USD' }, { key: 'change', label: '1D return', type: 'number', unit: '%' }], rows: MARKET_POSITIONS.map(position => [position.symbol, position.name, position.sector, position.value, position.dayChange]) } } };
  const timeWidget = (id: string, title: string, color: string): Widget => ({ ...recordWidget(id, title, '', '%'), type: 'timeseries', dataKind: undefined, pluginId: undefined, query: 'synthetic.market_risk.daily_valuations', color, options: { display: 'area', timeAxis: 'calendar', gridX: true, showGrid: true, showLegend: true, showTooltip: true, fillStyle: 'gradient', fillOpacity: .12, lineWidth: 1.5, curve: 'linear', decimals: 2, inspectorDensity: 'compact', showZeroLine: true } });
  const performance: MarketPanel = { widget: timeWidget('market-performance', 'Portfolio cumulative return', '#0dd4eb'), result: { series: [{ name: 'Portfolio', labels: { basis: 'Unchanged positions; no external flows', currency: 'USD', fixture: 'synthetic' }, points: history.map(point => ({ timestamp: point.timestamp, value: point.portfolio })) }, { name: 'Reference basket', labels: { basis: 'Rebased to the same start instant', fixture: 'synthetic' }, points: history.map(point => ({ timestamp: point.timestamp, value: point.benchmark })) }] } };
  const drawdown: MarketPanel = { widget: { ...timeWidget('market-drawdown', 'Drawdown', '#f3737c'), options: { ...timeWidget('x', 'x', '#f3737c').options, showLegend: false } }, result: { series: [{ name: 'Drawdown', labels: { basis: 'From running peak inside selected performance window', fixture: 'synthetic' }, points: history.map(point => ({ timestamp: point.timestamp, value: point.drawdown })) }] } };
  const waterfall: MarketPanel = { widget: { ...recordWidget('market-contribution', 'Contribution to portfolio return', 'contribution-waterfall', 'pp'), config: { label: 'sector', value: 'value', showLabels: true, showTotal: true } }, result: { records: { columns: [{ key: 'sector', label: 'Sector', type: 'string' }, { key: 'value', label: 'Return contribution', type: 'number', unit: 'pp' }], rows: contributions.map(item => [item.sector, item.value]) } } };
  const correlation: MarketPanel = { widget: { ...recordWidget('market-correlation', 'Asset correlation matrix', 'correlation-matrix'), config: { row: 'row', column: 'column', value: 'value', samples: 'samples', showValues: true } }, result: { records: marketCorrelations(days) } };
  const liquidityRows = LIQUIDITY_BUCKETS.flatMap(bucket => ['Cash', 'Equities', 'Restricted'].map(category => [bucket, category, MARKET_POSITIONS.filter(position => position.liquidity === bucket && (position.sector === 'Cash' ? 'Cash' : bucket === LIQUIDITY_BUCKETS[3] || bucket === LIQUIDITY_BUCKETS[4] ? 'Restricted' : 'Equities') === category).reduce((sum, position) => sum + position.value, 0)]));
  const liquidity: MarketPanel = { widget: { ...recordWidget('market-liquidity', 'Liquidity horizon', 'liquidity-ladder', 'USD'), config: { bucket: 'bucket', category: 'category', value: 'value', restrictedCategory: 'Restricted', showValues: true } }, result: { records: { columns: [{ key: 'bucket', label: 'Liquidation horizon', type: 'string' }, { key: 'category', label: 'Category', type: 'string' }, { key: 'value', label: 'Market value', type: 'number', unit: 'USD' }], rows: liquidityRows as RecordFrame['rows'] } } };
  const ledger: MarketPanel = { widget: { ...recordWidget('market-positions', 'Positions', 'record-table', ''), config: { columns: ['symbol', 'name', 'sector', 'weight', 'value', 'change', 'pnl', 'liquidity'], density: 'compact', showSearch: true, pageSize: 8, cellStyles: [{ column: 'weight', display: 'bar', min: 0, max: 15 }, { column: 'change', display: 'color-text' }, { column: 'pnl', display: 'color-text' }] }, color: '#0dd5b7', options: { decimals: 2, thresholds: [{ value: -1e9, color: '#f47c89', label: 'Decline' }, { value: 0, color: '#00dbba', label: 'Gain' }] } }, result: { records: { columns: [{ key: 'symbol', label: 'Ticker', type: 'string' }, { key: 'name', label: 'Name', type: 'string' }, { key: 'sector', label: 'Sector', type: 'string' }, { key: 'weight', label: 'Weight', type: 'number', unit: '%' }, { key: 'value', label: 'Market value', type: 'number', unit: 'USD' }, { key: 'change', label: '1D return', type: 'number', unit: '%' }, { key: 'pnl', label: '1D P&L', type: 'number', unit: 'USD' }, { key: 'liquidity', label: 'Liquidity horizon', type: 'string' }], rows: [...MARKET_POSITIONS].sort((a, b) => b.value - a.value).map(position => [position.symbol, position.name, position.sector, position.value / summary.value * 100, position.value, position.dayChange, position.dayPnl, position.liquidity]) } } };
  return { summary, history, contributions, allocation, performance, drawdown, waterfall, correlation, liquidity, ledger };
}

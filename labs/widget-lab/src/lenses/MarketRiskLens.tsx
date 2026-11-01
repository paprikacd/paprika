import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Clock3, X } from 'lucide-react';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { ChartCursorProvider } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import type { Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import type { DrilldownContext } from '../vendor/paprika/ui/src/features/insights/drilldown';
import { Panel, Sparkline } from '../components/lab/StudyPrimitives';
import { registerMarketCharts } from '../charts/market-risk/register';
import { registerLabCharts } from '../charts/register-lab-charts';
import { MARKET_AS_OF, MARKET_POSITIONS, marketRiskPanels, type MarketPanel, type MarketWindow } from './market-risk-data';
import type { EditLensWidget } from './LensStudio';
import './FinanceLens'; // Explicit owner of the shared allocation-treemap registration.
import './MarketRiskLens.css';

registerLabCharts();
registerMarketCharts();
const dollars = (value: number, decimals = 0) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
const signed = (value: number, decimals = 2) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(decimals)}`;

export function MarketRiskLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [days, setDays] = useState<MarketWindow>(30), [context, setContext] = useState<DrilldownContext | null>(null);
  const data = useMemo(() => marketRiskPanels(days), [days]);
  const panels = useDashboardPanels(onEdit);
  const current = (panel: MarketPanel) => panels.current(panel.widget);
  const editAction = panels.actions;
  const selected = MARKET_POSITIONS.find(position => position.symbol === context?.series || position.symbol === context?.labels?.symbol || position.symbol === context?.labels?.holding);
  const end = data.history.at(-1)!, worst = data.history.reduce((current, point) => point.drawdown < current.drawdown ? point : current, data.history[0]);
  const historyLabel = `${new Date(data.history[0].timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })} – 31 Oct`;
  return <div className="market-risk-lens">
    <header className="market-heading"><div><p>PAPRIKA / FINANCE</p><h1>Market Risk</h1></div><div className="market-scope"><span>Portfolio<strong>Global macro</strong></span><span>Currency<strong>USD</strong></span><label>Window<select aria-label="Market Risk performance window" value={days} onChange={event => { setDays(Number(event.target.value) as MarketWindow); setContext(null); }}><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label><time dateTime={new Date(MARKET_AS_OF).toISOString()}><Clock3 size={14}/>31 Oct 2026 · 09:30 UTC</time></div><span className="market-concept"><i/>Concept · synthetic data</span></header>
    <div className="market-metric-strip">
      <section><span>Net asset value</span><strong>${(data.summary.value / 1e6).toFixed(1)}M</strong><small>35 positions · unlevered</small></section>
      <section><span>Day P&amp;L</span><strong className={data.summary.dayPnl >= 0 ? 'market-positive' : 'market-negative'}>{data.summary.dayPnl >= 0 ? '+' : '−'}${Math.abs(data.summary.dayPnl / 1000).toFixed(1)}K <small>{signed(data.summary.dayChange!)}%</small></strong><div className="market-kpi-trace"><Sparkline values={data.history.map(point => point.value)} filled={false} color="#12d6ba" height={28}/></div></section>
      <section><span>Max drawdown · {days} days</span><strong className="market-negative">{signed(worst.drawdown)}%</strong><small>From the running portfolio peak</small></section>
      <section><span>Liquidity · within 7 days</span><strong className="market-positive">{data.summary.liquidPercent!.toFixed(1)}%</strong><small>{dollars(data.summary.liquid)} · scenario estimate</small></section>
    </div>
    <ChartCursorProvider><div className="market-grid-layout">
      <Panel title={current(data.allocation).title} subtitle="Treemap area is positive market value in USD; color is the signed one-day return on a fixed −3% to +3% scale. Sector drill is local to this chart. Whole-portfolio weights include cash." actions={editAction(data.allocation)} className="market-allocation-panel"><div className="market-allocation"><WidgetVisualization widget={current(data.allocation)} result={data.allocation.result} onContextChange={setContext}/></div></Panel>
      <Panel title={current(data.performance).title} subtitle="Unchanged positions, daily synthetic valuations, no external cash flows. Both histories start at zero for the selected period. Chart dragging changes only that plot's local view; use the Window control to change all historical panels." actions={editAction(data.performance)} className="market-performance-panel"><div className="market-performance-legend"><span><i/>Portfolio <strong>{signed(end.portfolio)}%</strong></span><span><i/>Reference <strong>{signed(end.benchmark)}%</strong></span><small>{historyLabel}</small></div><div className="market-performance"><WidgetVisualization widget={current(data.performance)} result={data.performance.result} onContextChange={setContext}/></div><div className="market-subheading"><h3>Drawdown <span>(portfolio)</span></h3><span>Max <b>{signed(worst.drawdown)}%</b> · {new Date(worst.timestamp).toLocaleDateString('en-GB', { day:'2-digit', month:'short', timeZone:'UTC' })}</span>{editAction(data.drawdown)}</div><div className="market-drawdown"><WidgetVisualization widget={current(data.drawdown)} result={data.drawdown.result} onContextChange={setContext}/></div></Panel>
      <Panel title={current(data.waterfall).title} subtitle={`Sector change in USD divided by the total portfolio value at the beginning of ${historyLabel}. Contributions in percentage points reconcile to the ${signed(end.portfolio)}% portfolio return. Cash is included.`} actions={editAction(data.waterfall)} className="market-waterfall-panel"><div className="market-period-caption">{historyLabel} <span>Unchanged positions · percentage points</span></div><div className="market-waterfall"><WidgetVisualization widget={current(data.waterfall)} result={data.waterfall.result} onContextChange={setContext}/></div></Panel>
      <Panel title={current(data.correlation).title} subtitle={`Pearson correlation from ${days - 1} paired synthetic daily returns, fixed range −1 to +1. These are reference instruments, not portfolio holdings. Unknown or insufficient evidence receives hatching; an observed zero is neutral.`} actions={editAction(data.correlation)} className="market-correlation-panel"><div className="market-period-caption">{days - 1} paired daily returns <span>Fixed scale · −1 to +1</span></div><div className="market-correlation"><WidgetVisualization widget={current(data.correlation)} result={data.correlation.result} onContextChange={setContext}/></div></Panel>
      <Panel title={current(data.liquidity).title} subtitle="Authored liquidation-horizon scenario for the current closing portfolio. Categories are mutually exclusive and all horizons sum to net asset value. Restricted stock is hatched. These are assumed execution/settlement horizons, not contractual bond maturities or forecasts." actions={editAction(data.liquidity)} className="market-liquidity-panel"><div className="market-period-caption">Closing portfolio <span>Assumed liquidation horizon</span></div><div className="market-liquidity"><WidgetVisualization widget={current(data.liquidity)} result={data.liquidity.result} onContextChange={setContext}/></div></Panel>
      <Panel title={current(data.ledger).title} subtitle="Exact closing positions, including cash. Market value = shares × synthetic closing price. Daily P&L sums to the headline; weights use the full closing portfolio. Search only filters this ledger." actions={<><span className="market-record-count">35 positions</span>{editAction(data.ledger)}</>} className="market-ledger-panel"><div className="market-ledger"><WidgetVisualization widget={current(data.ledger)} result={data.ledger.result} onContextChange={setContext}/></div></Panel>
    </div></ChartCursorProvider>
    {selected && <aside className="market-holding-detail" aria-label={`${selected.symbol} position evidence`}><header><div><small>Selected position</small><strong>{selected.symbol}<span>{selected.name}</span></strong></div><button aria-label="Clear selected market evidence" onClick={() => setContext(null)}><X size={15}/></button></header><dl><div><dt>Market value</dt><dd>{dollars(selected.value, 2)}</dd></div><div><dt>Portfolio weight</dt><dd>{(selected.value / data.summary.value * 100).toFixed(3)}%</dd></div><div><dt>Day P&amp;L</dt><dd className={selected.dayPnl < 0 ? 'market-negative' : 'market-positive'}>{selected.dayPnl < 0 ? <ArrowDownRight size={13}/> : <ArrowUpRight size={13}/>} {dollars(selected.dayPnl, 2)}</dd></div><div><dt>Synthetic price</dt><dd>{dollars(selected.price, 4)}</dd></div><div><dt>Quantity</dt><dd>{selected.shares.toLocaleString('en-US')}</dd></div></dl><div className="market-holding-history"><span>{days}-day position value · USD</span><Sparkline values={selected.history.slice(-days)} filled={false} color="#12cde4" height={44}/></div></aside>}
    <footer className="market-footer"><span><i/>Synthetic closing valuations · no external flows · USD</span><span>Period controls update historical evidence. Allocation and liquidity remain the closing snapshot.</span></footer>
  </div>;
}

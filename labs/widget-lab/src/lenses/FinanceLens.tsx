import { restoreTooltipFocus } from '../renderer-extensions/tooltip-focus';
import { useTooltipDismiss } from '../components/lab/useTooltipDismiss';
import { ChartTooltip } from '../components/lab/ChartTooltip';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { hierarchy, treemap } from 'd3-hierarchy';
import { ArrowDownRight, ArrowUpRight, ChartNoAxesCombined, ChevronRight, CircleHelp, Coins, Maximize2, TrendingUp, Wallet, X } from 'lucide-react';
import { registerLabCharts } from '../charts/register-lab-charts';
import { WidgetVisualization } from '../renderer-extensions/charts';
import { ChartCursorProvider } from '@insights/chart-cursor';
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from '../renderer-extensions/widget-registry';
import type { QueryResult, Widget } from '../renderer-extensions/schema';
import type { DrilldownContext } from '@insights/drilldown';
import theme from '@insights/gamma/gamma-theme.module.css';
import { MiniTrace } from '../reference/ReferenceShared';
import { allocationColor, allocationRecords, allocationTreemapConfig, financePanels, FINANCE_AS_OF, type AllocationRecord, type FinanceWindow } from './finance-data';
import './FinanceLens.css';
import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { labMotionStyle, useLabMotion } from '../components/lab/motion';

const money = (value: number, digits = 0) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
const compactMoney = (value: number) => value >= 1e6 ? `$${(value / 1e6).toFixed(2)}m` : `$${(value / 1000).toFixed(1)}k`;
const signed = (value: number, digits = 2) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
type TreeNode = { name: string; record?: AllocationRecord; children?: TreeNode[] };

/** A trusted records renderer: normalized host data in, bounded geometry out. */
export function AllocationTreemap({ widget, result, onContextChange, embedded }: WidgetRendererProps) {
  const config = useMemo(() => allocationTreemapConfig.parse(widget.config ?? {}), [widget.config]);
  const source = useMemo(() => result.records ? allocationRecords(result.records, config) : { records: [], omitted: 0, zero: 0, total: 0 }, [result.records, config]);
  const [group, setGroup] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [pinned, setPinned] = useState(false);
  const [size, setSize] = useState({ width: 760, height: 300 });
  const body = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const cellRefs = useRef(new Map<string, SVGGElement>());
  const uid = useId().replaceAll(':', '');
  const groups = [...new Set(source.records.map(record => record.group))];
  const activeGroup = group && groups.includes(group) ? group : null;
  const visible = useMemo(() => activeGroup ? source.records.filter(record => record.group === activeGroup) : source.records, [source.records, activeGroup]);
  const displayedTotal = visible.reduce((sum, record) => sum + record.value, 0);
  const inspectable = !embedded && widget.options?.showTooltip !== false;
  const inspectionRevision = useMemo(() => ({ result, activeGroup, label: config.label, value: config.value, group: config.group, change: config.change }), [result, activeGroup, config.label, config.value, config.group, config.change]);
  const currentRevision = useRef(inspectionRevision);
  const active = currentRevision.current === inspectionRevision && inspectable ? visible.find(record => record.id === selected) : undefined;
  const hoverDismiss = useTooltipDismiss({ onDismiss: () => setSelected(null), pinned, revision: inspectionRevision, enabled: inspectable });
  useEffect(() => { currentRevision.current = inspectionRevision; setSelected(null); setPinned(false); }, [inspectionRevision]);
  useEffect(() => { if (!inspectable) { setSelected(null); setPinned(false); } }, [inspectable]);
  useEffect(() => {
    const element = body.current; if (!element) return;
    const measure = () => { const width = element.clientWidth, height = element.clientHeight; if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height }); };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => {
    const root = hierarchy<TreeNode>({ name: 'Portfolio', children: activeGroup ? visible.map(record => ({ name: record.label, record })) : groups.map(name => ({ name, children: visible.filter(record => record.group === name).map(record => ({ name: record.label, record })) })) })
      .sum(node => node.record?.value ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<TreeNode>().size([size.width, size.height]).round(true).paddingInner(3).paddingOuter(2).paddingTop(node => !activeGroup && node.depth === 1 ? 23 : 2)(root);
  }, [visible, activeGroup, size.width, size.height]);
  const leaves = layout.leaves();
  function inspect(record: AllocationRecord, pin: boolean) {
    if (!inspectable) return;
    hoverDismiss.cancel(); setSelected(record.id); if (pin) setPinned(true);
    if (pin) onContextChange?.({ series: record.label, value: record.value, labels: { holding: record.label, sector: record.group, change: record.change === null ? 'Unknown' : String(record.change), weight: String(record.value / source.total * 100), currency: widget.unit || 'USD' } });
  }
  function focusCell(index: number) { const record = leaves[Math.max(0, Math.min(leaves.length - 1, index))]?.data.record; if (record) cellRefs.current.get(record.id)?.focus(); }
  function close() { hoverDismiss.cancel(); setSelected(null); setPinned(false); restoreTooltipFocus(svg.current); }
  const drill = (next: string | null) => { hoverDismiss.cancel(); setGroup(next); setSelected(null); setPinned(false); };
  if (!source.records.length) return <div className="finance-tree-empty">No positive allocation values to display.{source.zero > 0 && <span>{source.zero} zero-value positions have no area.</span>}</div>;
  return <div className="finance-tree" data-embedded={embedded || undefined} data-allocation-scope={activeGroup ?? 'portfolio'}>
    {!embedded && <div className="finance-tree-breadcrumb"><button onClick={() => drill(null)} disabled={!activeGroup}>Portfolio</button>{activeGroup && <><ChevronRight size={12}/><span>{activeGroup}</span><button className="finance-tree-reset" onClick={() => drill(null)}><Maximize2 size={11}/>Reset view</button></>}<small>{visible.length} holdings · {compactMoney(displayedTotal)}</small></div>}
    <div className="finance-tree-body" ref={body} onPointerLeave={hoverDismiss.schedule} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hoverDismiss.schedule(); }}>
      <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} tabIndex={-1} role="group" aria-label={widget.title} aria-description="Area represents market value. Color represents one-day percentage change, with zero at the neutral midpoint. Select a holding for exact values. Select a sector heading to drill in; Portfolio resets the view." onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
        {!activeGroup && layout.children?.map(node => <g key={node.data.name} className="finance-tree-sector" role={embedded ? undefined : 'button'} tabIndex={embedded ? undefined : 0} aria-label={`Open ${node.data.name} sector`} onClick={() => !embedded && drill(node.data.name)} onKeyDown={event => { if (!embedded && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); drill(node.data.name); } }}><rect x={node.x0} y={node.y0} width={node.x1 - node.x0} height={Math.min(21, node.y1 - node.y0)} rx={2} fill="#102a35"/><text x={node.x0 + 7} y={node.y0 + 15}>{node.data.name}<tspan fill="#87aaba"> {((node.value ?? 0) / source.total * 100).toFixed(1)}%</tspan></text><title>Open {node.data.name} · {money(node.value ?? 0, 2)}</title></g>)}
        {leaves.map((leaf, index) => {
          const record = leaf.data.record!; if (!record) return null;
          const width = leaf.x1 - leaf.x0, height = leaf.y1 - leaf.y0, chosen = record.id === active?.id;
          const label = `${record.label}: ${money(record.value, 2)}, ${(record.value / source.total * 100).toFixed(2)}% of portfolio, day change ${record.change === null ? 'unknown' : `${signed(record.change)}%`}`;
          return <g key={record.id} ref={element => { if (element) cellRefs.current.set(record.id, element); else cellRefs.current.delete(record.id); }} className="finance-tree-cell" role={inspectable ? 'button' : 'img'} tabIndex={inspectable ? 0 : undefined} aria-label={label} aria-pressed={inspectable ? chosen && pinned : undefined} onPointerEnter={() => { if (!pinned) inspect(record, false); }} onPointerLeave={hoverDismiss.schedule} onBlur={hoverDismiss.schedule} onFocus={() => { if (!pinned) inspect(record, false); }} onClick={() => inspect(record, true)} onKeyDown={event => {
            if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); focusCell(event.key === 'Home' ? 0 : event.key === 'End' ? leaves.length - 1 : index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1)); }
            else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(record, true); }
          }}>
            <defs><clipPath id={`${uid}-${index}`}><rect x={leaf.x0 + 3} y={leaf.y0 + 2} width={Math.max(0, width - 6)} height={Math.max(0, height - 4)}/></clipPath></defs>
            <rect x={leaf.x0} y={leaf.y0} width={Math.max(0, width)} height={Math.max(0, height)} rx={2} fill={allocationColor(record.change, config.colorLimit)} stroke={chosen ? '#a5f9e6' : '#223c45'} strokeWidth={chosen ? 1.5 : .5}/>
            {config.showLabels && width > 44 && height > 29 && <g pointerEvents="none" clipPath={`url(#${uid}-${index})`}><text x={leaf.x0 + width / 2} y={leaf.y0 + height / 2 - (height > 62 ? 14 : 2)} textAnchor="middle" className="finance-tree-symbol" style={{ fontSize: width > 130 && height > 100 ? 24 : width > 80 ? 17 : 12 }}>{record.label}</text>{height > 43 && <text x={leaf.x0 + width / 2} y={leaf.y0 + height / 2 + (height > 62 ? 7 : 15)} textAnchor="middle" className="finance-tree-change">{record.change === null ? 'Unknown' : `${signed(record.change)}%`}</text>}{height > 90 && width > 95 && <text x={leaf.x0 + width / 2} y={leaf.y0 + height / 2 + 28} textAnchor="middle" className="finance-tree-value">{compactMoney(record.value)}</text>}</g>}
            <title>{label}</title>
          </g>;
        })}
      </svg>
      {inspectable && active && <ChartTooltip pinned={pinned} onClose={close} onLeave={hoverDismiss.schedule}><section className="finance-tree-inspector" aria-label={`${active.label} allocation details`}><header><span>{pinned ? 'Pinned holding' : 'Holding detail'}</span><button onClick={close} aria-label="Close allocation details"><X size={13}/></button></header><strong>{active.label} <small>{active.name}</small></strong><div className="finance-tree-amount">{money(active.value, widget.options?.decimals ?? 2)}</div><dl><div><dt>Portfolio weight</dt><dd>{(active.value / source.total * 100).toFixed(2)}%</dd></div><div><dt>1 day change</dt><dd className={active.change !== null && active.change < 0 ? 'is-negative' : 'is-positive'}>{active.change === null ? 'Unknown' : `${signed(active.change)}%`}</dd></div><div><dt>Sector</dt><dd>{active.group}</dd></div></dl><footer>{!activeGroup && <button onClick={() => drill(active.group)}>Open sector<ChevronRight size={12}/></button>}<button onClick={() => { hoverDismiss.cancel(); setPinned(value => !value); }}>{pinned ? 'Unpin' : 'Pin holding'}</button></footer></section></ChartTooltip>}
    </div>
    {widget.options?.showLegend !== false && <div className="finance-tree-legend"><span>Area <strong>Market value</strong></span><span>1D change</span><div className="finance-tree-color-key"><i style={{ background: allocationColor(-config.colorLimit, config.colorLimit) }}/><i style={{ background: allocationColor(-config.colorLimit / 2, config.colorLimit) }}/><i style={{ background: allocationColor(0, config.colorLimit) }}/><i style={{ background: allocationColor(config.colorLimit / 2, config.colorLimit) }}/><i style={{ background: allocationColor(config.colorLimit, config.colorLimit) }}/></div><span>−{config.colorLimit}%</span><span>0</span><span>+{config.colorLimit}%</span></div>}
    {(source.omitted > 0 || source.zero > 0 || result.records?.truncated) && <p className="finance-tree-note">{source.omitted > 0 && `${source.omitted} invalid or missing positions omitted. `}{source.zero > 0 && `${source.zero} zero-value positions have no area. `}{result.records?.truncated && 'Partial source response.'}</p>}
  </div>;
}

registerLabCharts();
if (!getWidgetDefinition('plugin', 'allocation-treemap')) registerWidgetPlugin({
  id: 'allocation-treemap', label: 'Allocation treemap', description: 'Positive allocation area with zero-centred change color, group drilldown and exact inspection', dataKind: 'records', render: AllocationTreemap,
  parseConfig: config => allocationTreemapConfig.parse(config ?? {}), defaultConfig: allocationTreemapConfig.parse({}), styleControls: ['decimals', 'legend', 'tooltips'],
  configFields: [{ key: 'showLabels', label: 'Show holding labels', kind: 'boolean' }, { key: 'colorLimit', label: 'Change color limit (%)', kind: 'number', min: .1, max: 100, step: .1, help: 'Symmetric around zero. Exact changes remain unchanged.' }],
});

export type FinanceLensEdit = (widget: Widget, result: QueryResult, apply: (widget: Widget) => void) => void;
function Panel({ title, description, action, className = '', children }: { title: string; description: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`finance-panel ${className}`}><header><div><h2>{title}</h2><p>{description}</p></div>{action}</header>{children}</section>;
}

export function FinanceLens({ onEdit }: { onEdit?: FinanceLensEdit }) {
  const motion = useLabMotion();
  const [days, setDays] = useState<FinanceWindow>(30), [context, setContext] = useState<DrilldownContext | null>(null);
  const data = useMemo(() => financePanels(days), [days]);
  const { summary, history } = data;
  const periodReturn = history.at(-1)!.portfolio, benchmarkReturn = history.at(-1)!.benchmark;
  const panels = useDashboardPanels(onEdit);
  const current = (panel: { widget: Widget; result: QueryResult }) => panels.current(panel.widget);
  const editAction = panels.actions;
  const bestSector = summary.sectors.reduce((best, sector) => sector.dayPnl > best.dayPnl ? sector : best, summary.sectors[0]);
  const metrics = [
    { label: 'Net asset value', value: money(summary.value, 0), unit: 'USD', delta: `${signed(summary.dayChange)}% today`, sub: `${summary.dayPnl < 0 ? '−' : '+'}${money(Math.abs(summary.dayPnl), 0)} unrealized change`, icon: Wallet, trace: history.map(point => point.portfolio), color: '#00d7b5' },
    { label: `${days}-day return`, value: `${signed(periodReturn)}%`, unit: '', delta: `${signed(periodReturn - benchmarkReturn)} pp`, sub: 'vs. synthetic reference basket', icon: TrendingUp, trace: history.map(point => point.portfolio - point.benchmark), color: '#13c6eb' },
    { label: 'Equity allocation', value: summary.equityWeight.toFixed(2), unit: '%', delta: `${summary.sectors.length - 1} sectors`, sub: 'Market value / total portfolio', icon: ChartNoAxesCombined, meter: summary.equityWeight, color: '#a184f2' },
    { label: 'Cash reserve', value: money(summary.cash, 0), unit: 'USD', delta: `${(100 - summary.equityWeight).toFixed(2)}% weight`, sub: 'Closing balance · no leverage', icon: Coins, meter: 100 - summary.equityWeight, color: '#f4c05f' },
  ];
  return <div className={`${theme.scope} finance-lens`} data-insights-theme="dark" style={labMotionStyle(motion.reduced)}>
    <div className="finance-heading"><div><p>PAPRIKA / FINANCE</p><h1>Portfolio briefing</h1><span>Core allocation <i/> Synthetic portfolio · closing snapshot</span></div><div className="finance-heading-tools"><span className="finance-snapshot">30 Oct 2026 · 20:00 UTC</span><label>Performance window<select aria-label="Finance performance window" value={days} onChange={event => setDays(Number(event.target.value) as FinanceWindow)}><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={180}>Last 180 days</option></select></label></div></div>
    <div className="finance-metrics">{metrics.map(metric => <section key={metric.label} className="finance-metric" style={{ '--finance-metric-color': metric.color } as CSSProperties}><div className="finance-metric-icon"><metric.icon size={21}/></div><div className="finance-metric-label">{metric.label}</div><div className="finance-metric-value">{metric.value}<span>{metric.unit}</span></div><span className="finance-metric-delta">{metric.delta}</span><p>{metric.sub}</p>{metric.trace ? <div className="finance-metric-spark"><MiniTrace values={metric.trace} color={metric.color} height={29}/></div> : <div className="finance-metric-meter" aria-hidden="true"><i style={{width:`${metric.meter}%`}}/></div>}</section>)}</div>
    <ChartCursorProvider><div className="finance-grid">
      <Panel title={current(data.allocation).title} description="Position size and one-day movement, grouped by sector" className="finance-allocation-panel" action={editAction(data.allocation)}><div className="finance-allocation-chart"><WidgetVisualization widget={current(data.allocation)} result={data.allocation.result} onContextChange={setContext}/></div></Panel>
      <Panel title="Sector exposure" description="Weight in the closing portfolio" className="finance-sector-panel"><div className="finance-sector-list">{summary.sectors.map(sector => <div className="finance-sector-row" key={sector.name}><div><span>{sector.name}</span><strong>{sector.weight.toFixed(2)}%</strong></div><div className="finance-sector-track"><i style={{ width: `${sector.weight}%`, background: allocationColor(sector.change, 2) }}/></div><small>{sector.holdings} {sector.holdings === 1 ? 'holding' : 'holdings'}<span className={sector.dayPnl < 0 ? 'is-negative' : 'is-positive'}>{sector.dayPnl < 0 ? <ArrowDownRight size={12}/> : <ArrowUpRight size={12}/>} {signed(sector.change)}% today</span></small></div>)}</div><footer className="finance-sector-note"><CircleHelp size={13}/><span>Top 3 positions account for <strong>{summary.topThreeWeight.toFixed(2)}%</strong> of portfolio value.</span></footer></Panel>
      <Panel title={current(data.performance).title} description={`Daily close · both series rebased to 0% at the ${days}-day window start`} className="finance-performance-panel" action={editAction(data.performance)}><div className="finance-performance-summary"><strong className="is-positive">{signed(periodReturn)}%</strong><span>Portfolio</span><i/><strong>{signed(benchmarkReturn)}%</strong><span>Reference basket</span></div><div className="finance-performance-chart"><WidgetVisualization widget={current(data.performance)} result={data.performance.result} onContextChange={setContext}/></div></Panel>
      <Panel title="Daily contribution" description="Change in position value from the previous close" className="finance-contribution-panel"><div className="finance-contribution-summary"><span>Largest positive contributor</span><strong>{bestSector.name}<b>{money(bestSector.dayPnl, 0)}</b></strong></div><div className="finance-contribution-bars">{[...summary.sectors].sort((a, b) => b.dayPnl - a.dayPnl).filter(sector => sector.name !== 'Cash').map(sector => { const max = Math.max(...summary.sectors.map(item => Math.abs(item.dayPnl))), length = Math.abs(sector.dayPnl) / max * 50; return <div key={sector.name}><span>{sector.name}</span><div className="finance-contribution-track"><i style={{ width: `${length}%`, left: sector.dayPnl < 0 ? `${50 - length}%` : '50%', background: sector.dayPnl < 0 ? '#c7586b' : '#12b698' }}/></div><strong className={sector.dayPnl < 0 ? 'is-negative' : 'is-positive'}>{sector.dayPnl < 0 ? '−' : '+'}{money(Math.abs(sector.dayPnl), 0)}</strong></div>; })}</div><p className="finance-contribution-total">Net daily change<strong className={summary.dayPnl < 0 ? 'is-negative' : 'is-positive'}>{summary.dayPnl < 0 ? '−' : '+'}{money(Math.abs(summary.dayPnl), 2)}</strong></p></Panel>
      <Panel title={current(data.holdings).title} description="Exact closing values · search and select a position" className="finance-holdings-panel" action={editAction(data.holdings)}><div className="finance-holdings-chart"><WidgetVisualization widget={current(data.holdings)} result={data.holdings.result} onContextChange={setContext}/></div>{context && <div className="finance-selected-record"><span>Selected evidence</span><strong>{context.series ?? context.labels?.symbol ?? 'Holding'}</strong><span>{context.value !== undefined && context.value !== null ? money(context.value, 2) : Object.entries(context.labels ?? {}).slice(0, 3).map(([key, value]) => `${key}: ${value}`).join(' · ')}</span><button onClick={() => setContext(null)} aria-label="Clear selected finance evidence"><X size={13}/></button></div>}</Panel>
    </div></ChartCursorProvider>
    <footer className="finance-footer"><span><i/>Synthetic data · {new Date(FINANCE_AS_OF).toISOString().slice(0, 10)}</span><span>USD reporting currency · market-value weights · unlevered positions</span></footer>
  </div>;
}

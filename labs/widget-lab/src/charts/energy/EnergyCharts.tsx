import { useId, useMemo, useRef } from 'react';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../../vendor/paprika/ui/src/features/insights/time-window-controls';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { contingencyCells, contingencyConfig, flexibilityConfig, flexibilityPoints, meritConfig, meritOrder, powerFlowConfig, powerNodes, type FlexPoint, type PowerNode } from './model';
import './energy.css';

const clock = (t: number) => new Date(t).toISOString().slice(11, 16);
const fmt = (n: number | null, d = 1) => n === null ? 'Unknown' : n.toLocaleString('en-US', { maximumFractionDigits: d });
const color = (id: string) => ({ wind: C.mint, solar: C.amber, gas: C.violet, imports: C.blue, battery: C.cyan, industrial: C.amber, residential: C.red, transport: C.blue, losses: C.muted }[id] ?? C.cyan);
const ribbon = (x1: number, x2: number, y1: number, y2: number, h: number) => `M${x1},${y1}C${(x1+x2)/2},${y1} ${(x1+x2)/2},${y2} ${x2},${y2}L${x2},${y2+h}C${(x1+x2)/2},${y2+h} ${(x1+x2)/2},${y1+h} ${x1},${y1+h}Z`;

export function PowerFlow({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = powerFlowConfig.parse(widget.config ?? {}), data = useMemo(() => result.records ? powerNodes(result.records, config) : { nodes: [], sources: [], loads: [], total: 0, available: 0, reserve: 0 }, [result.records, config.valueField, config.labelField]);
  const ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 740), enabled = !embedded && widget.options?.showTooltip !== false;
  const inspect = useInspection(data.nodes, result, enabled, config.selectedAsset);
  const pick = (n: PowerNode, target: SVGElement | HTMLElement) => { inspect.select(n.id, target); onContextChange?.({ series: n.label, value: n.power, labels: { asset: n.id, side: n.side, unit: 'MW' } }); };
  const plotHeight = 220, gap = 13, useful = plotHeight - (Math.max(data.sources.length, data.loads.length) - 1) * gap, scale = data.total ? useful / data.total : 0;
  function segments(nodes: PowerNode[]) { let bus = 0, y = 28 + (plotHeight - (useful + (nodes.length - 1) * gap)) / 2; return nodes.map(n => { const h = n.power * scale, value = { ...n, y, bus: 28 + (plotHeight - useful)/2 + bus, h }; y += h + gap; bus += h; return value; }); }
  const left = segments(data.sources), right = segments(data.loads), middle = width / 2, active = inspect.item;
  const marks = (n: PowerNode) => ({ role: 'button' as const, tabIndex: enabled ? 0 : undefined, 'aria-label': `${n.label}, ${fmt(n.power)} MW`, onPointerEnter: () => inspect.setHover(n.id), onPointerLeave: () => inspect.setHover(null), onFocus: () => inspect.setHover(n.id), onBlur: () => inspect.setHover(null), onClick: (e: React.MouseEvent<SVGGElement>) => pick(n, e.currentTarget), onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(n, e.currentTarget); } } });
  return <div ref={ref} className="energy-chart" onKeyDown={inspect.onKeyDown}>
    {!data.nodes.length ? <div className="domain-empty">No power-flow observations.</div> : <>
      <div className="energy-accounting"><span>Total in <b>{fmt(data.total)} MW</b></span><span>Total out <b>{fmt(data.total)} MW</b></span></div>
      {width < 480 ? <div className="energy-flow-compact">{[data.sources, data.loads].map((nodes, i) => <div key={i}><h3>{i ? 'Loads and losses' : 'Sources'}</h3>{nodes.map(n => <button key={n.id} onClick={e => pick(n, e.currentTarget)} onFocus={() => inspect.setHover(n.id)} onBlur={() => inspect.setHover(null)}><span>{n.label}</span><span className="energy-mini-bar"><i style={{ width: `${n.power/data.total*100}%`, background: color(n.id) }}/></span><b>{fmt(n.power)} MW</b></button>)}</div>)}</div> : <svg viewBox={`0 0 ${width} 280`} role="group" aria-label="Conserved power flow in megawatts">
        {left.map(n => <g key={n.id} {...marks(n)} className="energy-mark"><path d={ribbon(118, middle-22, n.y, n.bus, n.h)} fill={color(n.id)} fillOpacity={inspect.item && inspect.item.id !== n.id ? .25 : .57} stroke={config.selectedAsset === n.id || active?.id === n.id ? color(n.id) : 'none'} strokeWidth="1.8"/><rect x="108" y={n.y} width="10" height={Math.max(1,n.h)} fill={color(n.id)} rx="2"/><text x="101" y={n.y+n.h/2-3} textAnchor="end" fill="var(--gamma-ink)">{n.label}</text>{config.showValues && <text x="101" y={n.y+n.h/2+12} textAnchor="end" fill="var(--gamma-muted)">{fmt(n.power)} MW</text>}</g>)}
        {right.map(n => <g key={n.id} {...marks(n)} className="energy-mark"><path d={ribbon(middle+22,width-112,n.bus,n.y,n.h)} fill={color(n.id)} fillOpacity={inspect.item && inspect.item.id !== n.id ? .25 : .57} stroke={active?.id === n.id ? color(n.id) : 'none'} strokeWidth="1.8"/><rect x={width-112} y={n.y} width="10" height={Math.max(1,n.h)} fill={color(n.id)} rx="2"/><text x={width-95} y={n.y+n.h/2-3} fill="var(--gamma-ink)">{n.label}</text>{config.showValues && <text x={width-95} y={n.y+n.h/2+12} fill="var(--gamma-muted)">{fmt(n.power)} MW</text>}</g>)}
        <rect x={middle-22} y={28+(plotHeight-useful)/2} width="44" height={useful} fill="var(--gamma-surface-2)" stroke={C.cyan} rx="5"/><text x={middle} y="125" textAnchor="middle" fill="var(--gamma-ink)">Grid</text><text x={middle} y="145" textAnchor="middle" fill="var(--gamma-ink)">{fmt(data.total,0)}</text><text x={middle} y="164" textAnchor="middle" fill="var(--gamma-muted)">MW</text>
      </svg>}
      <div className="energy-power-summary"><span>Available supply <b>{fmt(data.available)} MW</b></span><span>Reserve <b>{fmt(data.reserve)} MW</b></span><span>Snapshot <b>18:10 UTC</b></span></div>
      {active && <DomainInspector title={active.label} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[[active.side==='source'?'Dispatched power':'Received power',`${fmt(active.power)} MW`],['Share of total',`${fmt(active.power/data.total*100)}%`],...(active.side==='source'?[['Available capacity',`${fmt(active.available)} MW`],['Headroom',`${fmt(active.available-active.power)} MW`]] as [string,string][]:[]),...(active.energy!==null?[['Stored energy',`${fmt(active.energy)} MWh`],['State of charge',`${fmt(active.energy/(active.capacity||1)*100)}%`]] as [string,string][]:[])]}/></DomainInspector>}
    </>}
  </div>;
}

export function ContingencyMatrix({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = contingencyConfig.parse(widget.config ?? {}), cells = useMemo(() => result.records ? contingencyCells(result.records) : [], [result.records]);
  const ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 500), id = useId().replaceAll(':',''), enabled = !embedded && widget.options?.showTooltip !== false;
  const inspect = useInspection(cells, result, enabled, `${config.selectedAsset}:${config.selectedScenario}`), assets = [...new Set(cells.map(c => c.asset))], scenarios = [...new Set(cells.map(c => c.scenario))], cellWidth = (width-86)/Math.max(1,scenarios.length), rowHeight = 33;
  const pick = (c: typeof cells[number], target: SVGElement) => { inspect.select(c.id,target); onContextChange?.({ series:c.label,value:c.loading,labels:{asset:c.asset,scenario:c.scenario} }); };
  const fill = (v: number | null) => v===null?`url(#${id}-unknown)`:v>=100?C.red:v>=config.warning?C.amber:`color-mix(in srgb, ${C.cyan} ${Math.max(12,v*.65)}%, var(--gamma-bg))`;
  return <div ref={ref} className="energy-chart" onKeyDown={inspect.onKeyDown}>{!cells.length?<div className="domain-empty">No simulated contingencies.</div>:<>
    <svg viewBox={`0 0 ${width} ${55+assets.length*rowHeight}`} role="group" aria-label="Simulated asset loading by contingency scenario">
      <defs><pattern id={`${id}-unknown`} width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0,6L6,0" stroke="var(--gamma-muted)" strokeWidth=".7"/></pattern></defs>
      {scenarios.map((s,j)=><text key={s} x={86+(j+.5)*cellWidth} y="17" fill="var(--gamma-muted)" textAnchor="middle">{s.split(' ').map((word,k)=><tspan key={k} x={86+(j+.5)*cellWidth} dy={k?12:0}>{word}</tspan>)}</text>)}
      {assets.map((asset,i)=><text key={asset} x="78" y={52+i*rowHeight} textAnchor="end" fill={asset===config.selectedAsset?C.cyan:'var(--gamma-muted)'}>{cells.find(c=>c.asset===asset)?.label}</text>)}
      {cells.map(c=>{const x=86+scenarios.indexOf(c.scenario)*cellWidth,y=35+assets.indexOf(c.asset)*rowHeight;return <g key={c.id} role="button" tabIndex={enabled?0:undefined} aria-label={`${c.label}, ${c.scenario}, ${c.loading===null?'not simulated':fmt(c.loading)+' percent'}`} onPointerEnter={()=>inspect.setHover(c.id)} onPointerLeave={()=>inspect.setHover(null)} onFocus={()=>inspect.setHover(c.id)} onBlur={()=>inspect.setHover(null)} onClick={e=>pick(c,e.currentTarget)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(c,e.currentTarget);}}}><rect x={x} y={y} width={cellWidth-1} height={rowHeight-1} fill={fill(c.loading)} fillOpacity={c.loading!==null&&c.loading>=config.warning ? .8 : 1} stroke={inspect.item?.id===c.id?C.cyan:'var(--gamma-border)'} strokeWidth={inspect.item?.id===c.id?2:1}/>{config.showValues&&<text x={x+cellWidth/2} y={y+20} textAnchor="middle" fill={c.loading!==null&&c.loading>=config.warning?'#10212a':'var(--gamma-ink)'}>{c.loading===null?'—':fmt(c.loading,0)+'%'}</text>}</g>;})}
    </svg>
    <div className="domain-legend"><span><i style={{background:C.cyan}}/>Loading (% of capacity)</span><span><i style={{background:C.amber}}/>≥{config.warning}%</span><span><i className="energy-hatch"/>Not simulated</span></div>
    {inspect.item&&<DomainInspector title={`${inspect.item.label} · ${inspect.item.scenario}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[["Scenario result",inspect.item.loading===null?'Not simulated':`${fmt(inspect.item.loading)}% loading`],['Evidence type','Synthetic contingency simulation']]}/></DomainInspector>}
  </>}</div>;
}

export function DispatchMerit({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config=meritConfig.parse(widget.config??{}),data=useMemo(()=>result.records?powerNodes(result.records):{nodes:[],total:0,available:0},[result.records]),steps=meritOrder(data.nodes);
  const ref=useRef<HTMLDivElement>(null),width=usePlotWidth(ref,500),inspect=useInspection(steps,result,!embedded&&widget.options?.showTooltip!==false,config.selectedAsset);
  const x=scaleLinear().domain([0,Math.max(1,data.available)]).range([48,width-18]),y=scaleLinear().domain([Math.min(0,...steps.map(s=>s.price))*1.15,Math.max(1,...steps.map(s=>s.price))*1.15]).nice().range([219,20]);
  const active=inspect.item;
  return <div ref={ref} className="energy-chart" onKeyDown={inspect.onKeyDown}>{!steps.length?<div className="domain-empty">No available dispatch resources.</div>:<>
    <svg viewBox={`0 0 ${width} 270`} role="group" aria-label="Marginal price by cumulative available megawatts">
      {y.ticks(4).map(v=><g key={v}><line x1="48" x2={width-18} y1={y(v)} y2={y(v)} stroke="var(--gamma-chart-grid)"/><text x="40" y={y(v)+4} textAnchor="end" fill="var(--gamma-muted)">{fmt(v,0)}</text></g>)}
      {x.ticks(width<420?3:5).map(v=><text key={v} x={x(v)} y="239" textAnchor="middle" fill="var(--gamma-muted)">{fmt(v,0)}</text>)}<text x="48" y="12" fill="var(--gamma-muted)">$/MWh</text><text x={width/2} y="261" textAnchor="middle" fill="var(--gamma-muted)">Cumulative available capacity (MW)</text>
      {steps.map(s=><g key={s.id} role="button" tabIndex={!embedded?0:undefined} aria-label={`${s.label}, ${s.available} MW available at ${s.price} dollars per megawatt hour`} onPointerEnter={()=>inspect.setHover(s.id)} onPointerLeave={()=>inspect.setHover(null)} onFocus={()=>inspect.setHover(s.id)} onBlur={()=>inspect.setHover(null)} onClick={e=>{inspect.select(s.id,e.currentTarget);onContextChange?.({series:s.label,value:s.price,labels:{asset:s.id}});}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect.select(s.id,e.currentTarget);onContextChange?.({series:s.label,value:s.price,labels:{asset:s.id}});}}}><rect x={x(s.start)} y={Math.min(y(0),y(s.price))} width={Math.max(0,x(s.end)-x(s.start))} height={Math.abs(y(0)-y(s.price))} fill={color(s.id)} fillOpacity={active?.id===s.id||config.selectedAsset===s.id ? .3 : .16}/><path d={`M${x(s.start)},${y(s.price)}H${x(s.end)}`} stroke={color(s.id)} strokeWidth="2"/>{config.showLabels&&x(s.end)-x(s.start)>57&&<text x={(x(s.start)+x(s.end))/2} y="209" textAnchor="middle" fill="var(--gamma-ink)">{s.label.replace(' discharge','')}</text>}</g>)}
      <line x1={x(data.total)} x2={x(data.total)} y1="20" y2="220" stroke="var(--gamma-ink)" strokeDasharray="5 4"/><text x={x(data.total)-5} y="35" textAnchor="end" fill="var(--gamma-ink)">Required {fmt(data.total,0)} MW</text>
    </svg>
    {active&&<DomainInspector title={active.label} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[["Marginal price",`$${fmt(active.price)}/MWh`],['Available',`${fmt(active.available)} MW`],['Dispatched',`${fmt(active.power)} MW`],['Cumulative availability',`${fmt(active.end)} MW`]]}/></DomainInspector>}
  </>}</div>;
}

export function FlexibilityDispatch({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config=flexibilityConfig.parse(widget.config??{}),points=useMemo(()=>result.records?flexibilityPoints(result.records):[],[result.records]);
  const ref=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),width=usePlotWidth(ref,520),uid=useId().replaceAll(':','');
  const enabled=!embedded&&widget.options?.showTooltip!==false,inspect=useInspection(points,result,enabled,config.selectedTime===undefined?undefined:String(config.selectedTime)),extent=points.length?{start:points[0].timestamp,end:points.at(-1)!.timestamp}:null;
  const view=useChartTimeWindow(extent,result,600000),x=scaleLinear().domain([view.window.start,view.window.end]).range([46,width-16]),y=scaleLinear().domain([-Math.max(1,...points.map(p=>Math.abs(p.power??0)))*1.12,Math.max(1,...points.map(p=>Math.abs(p.power??0)))*1.12]).nice(4).range([150,25]);
  const visible=points.filter(p=>p.timestamp>=view.window.start&&p.timestamp<=view.window.end),active=inspect.item;
  const position=(clientX:number,clientY:number)=>{const matrix=svg.current?.getScreenCTM();if(!matrix)return null;const p=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());return {x:p.x,y:p.y,timestamp:x.invert(Math.max(46,Math.min(width-16,p.x))),inPlot:p.x>=46&&p.x<=width-16&&p.y>=25&&p.y<=270};};
  const brush=useTimeWindowBrush({enabled:!embedded&&view.enabled,revision:result,window:view.window,point:position,commit:view.commit,onStart:inspect.dismiss});
  const inspectAt=(timestamp:number,pin:boolean,target?:SVGElement)=>{const p=visible.reduce<FlexPoint|undefined>((best,row)=>!best||Math.abs(row.timestamp-timestamp)<Math.abs(best.timestamp-timestamp)?row:best,undefined);if(!p)return;if(pin){inspect.select(p.id,target);onContextChange?.({series:'Battery dispatch',value:p.power,labels:{timestamp:p.id}});}else inspect.setHover(p.id);};
  const current=active?.timestamp??config.selectedTime,barWidth=Math.max(1,Math.min(11,(width-62)*300000/(view.window.end-view.window.start)*.74));
  const energyY=scaleLinear().domain([0,100]).range([255,192]),energyPath=line<FlexPoint>().defined(p=>p.energy!==null).x(p=>x(p.timestamp)).y(p=>energyY(p.energy!/p.capacity*100))(points)??'';
  return <div ref={ref} className="energy-chart" onKeyDown={inspect.onKeyDown}>{!points.length?<div className="domain-empty">No storage dispatch observations.</div>:<>
    <div className="domain-legend"><span><i style={{background:C.cyan}}/>Discharge (+)</span><span><i style={{background:C.violet}}/>Charge (−)</span><span>MW · future bars are predicted</span></div>
    <svg ref={svg} viewBox={`0 0 ${width} ${config.showEnergy?290:182}`} role="group" aria-label="Battery dispatch; drag to zoom, arrows inspect, Enter pins" tabIndex={enabled?0:undefined} {...brush.handlers} onPointerMove={e=>{if(!enabled||brush.active||inspect.pinned)return;const p=position(e.clientX,e.clientY);if(p?.inPlot)inspectAt(p.timestamp,false);}} onPointerLeave={()=>inspect.setHover(null)} onClick={e=>{const p=position(e.clientX,e.clientY);if(p?.inPlot)inspectAt(p.timestamp,true,e.currentTarget);}} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const i=visible.findIndex(p=>p.id===active?.id);const p=visible[Math.max(0,Math.min(visible.length-1,(i<0?0:i)+(e.key==='ArrowRight'?1:-1)))];if(p)inspectAt(p.timestamp,false);}else if(e.key==='Enter'&&active){e.preventDefault();inspectAt(active.timestamp,true,e.currentTarget);}}}>
      <defs><clipPath id={`${uid}-clip`}><rect x="46" y="20" width={Math.max(1,width-62)} height="245"/></clipPath></defs>
      {y.ticks(4).map(v=><g key={v}><line x1="46" x2={width-16} y1={y(v)} y2={y(v)} stroke={v===0?'var(--gamma-muted)':'var(--gamma-chart-grid)'}/><text x="38" y={y(v)+4} textAnchor="end" fill="var(--gamma-muted)">{v}</text></g>)}
      {Array.from({length:width<480?4:7},(_,i)=>view.window.start+i/(width<480?3:6)*(view.window.end-view.window.start)).map(t=><text key={t} x={x(t)} y="172" textAnchor="middle" fill="var(--gamma-muted)">{clock(t)}</text>)}
      <g clipPath={`url(#${uid}-clip)`}>{visible.map(p=>p.power===null?<line key={p.id} x1={x(p.timestamp)} x2={x(p.timestamp)} y1="25" y2="150" stroke="var(--gamma-muted)" strokeDasharray="2 4"/>:<rect key={p.id} x={x(p.timestamp)-barWidth/2} y={Math.min(y(p.power),y(0))} width={barWidth} height={Math.max(1,Math.abs(y(p.power)-y(0)))} fill={p.power>=0?C.cyan:C.violet} opacity={p.predicted ? .48 : .9}/>)}
        {config.showEnergy&&<><path d={energyPath} stroke={C.mint} strokeWidth="1.8" fill="none"/>{[0,50,100].map(v=><g key={v}><line x1="46" x2={width-16} y1={energyY(v)} y2={energyY(v)} stroke="var(--gamma-chart-grid)"/></g>)}</>}
        {current!==undefined&&current>=view.window.start&&current<=view.window.end&&<line x1={x(current)} x2={x(current)} y1="25" y2={config.showEnergy?255:150} stroke="var(--gamma-ink)" strokeDasharray="4 4"/>}
        {brush.preview&&<rect x={Math.min(brush.preview.x1,brush.preview.x2)} y="25" width={Math.abs(brush.preview.x2-brush.preview.x1)} height={config.showEnergy?230:125} fill={C.cyan} fillOpacity=".16" stroke={C.cyan}/>}
      </g>
      {config.showEnergy&&<><text x="46" y="188" fill="var(--gamma-muted)">State of charge (%)</text>{[0,50,100].map(v=><text key={v} x="38" y={energyY(v)+4} textAnchor="end" fill="var(--gamma-muted)">{v}</text>)}<text x={width/2} y="281" textAnchor="middle" fill="var(--gamma-muted)">UTC · ideal storage, 5-minute power intervals</text></>}
    </svg>
    {!embedded&&<TimeWindowControls state={view} compact/>}
    {active&&<DomainInspector title={`${clock(active.timestamp)} UTC · ${active.predicted?'Predicted':'Observed fixture'}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[["Power",active.power===null?'No observation':`${fmt(active.power)} MW`],['Stored energy',`${fmt(active.energy)} MWh`],['State of charge',active.energy===null?'Unknown':`${fmt(active.energy/active.capacity*100)}%`]]}/></DomainInspector>}
  </>}</div>;
}

import { useMemo, useState, type ReactNode } from 'react';
import { Activity, BatteryCharging, CircleHelp, Clock3, MapPinned, Pencil, RadioTower, Zap } from 'lucide-react';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { ChartCursorProvider } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import type { Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import type { DrilldownContext } from '../vendor/paprika/ui/src/features/insights/drilldown';
import { MetricCard, Panel } from '../components/lab/StudyPrimitives';
import { registerLabCharts } from '../charts/register-lab-charts';
import { registerGridCharts } from '../charts/grid/register';
import { BATTERY_CAPACITY_MWH, buildGridOperations, type GridPanel, type GridScenario, type GridWindow } from './grid-operations-data';
import type { EditLensWidget } from './LensStudio';
import './GridOperationsLens.css';

registerLabCharts();registerGridCharts();
const number=(n:number,digits=0)=>(Math.abs(n)<.5*10**-digits?0:n).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});

export function GridOperationsLens({onEdit}:{onEdit?:EditLensWidget}) {
  const [scenario,setScenario]=useState<GridScenario>('peak'),[window,setWindow]=useState<GridWindow>('day'),[overrides,setOverrides]=useState<Record<string,Widget>>({}),[context,setContext]=useState<DrilldownContext|null>(null);
  const data=useMemo(()=>buildGridOperations(scenario,window),[scenario,window]);const {latest,panels}=data;
  const current=(panel:GridPanel)=>overrides[panel.widget.id]??panel.widget;
  const edit=(panel:GridPanel)=>onEdit&&<button className="grid-edit" aria-label={`Edit ${current(panel).title}`} onClick={()=>onEdit(current(panel),panel.result,next=>setOverrides(p=>({...p,[panel.widget.id]:next})))}><Pencil size={12}/><span>Edit</span></button>;
  const render=(source:GridPanel,className:string,extra?:ReactNode)=><Panel className={`grid-panel ${className}`} title={current(source).title} subtitle={source.caption} actions={edit(source)}><div className="grid-widget"><WidgetVisualization widget={current(source)} result={source.result} onContextChange={next=>setContext({...next,labels:{...next.labels,unit:source.widget.unit}})}/></div>{extra}<p className="grid-panel-footnote">{source.caption}</p></Panel>;
  const soc=latest.energy/BATTERY_CAPACITY_MWH*100;
  return <main className="grid-operations-lens">
    <header className="grid-lens-heading"><div><span className="grid-eyebrow">PAPRIKA / ENERGY SYSTEMS</span><h1>Grid Operations</h1></div><div><span className="grid-fixture-dot"/>Concept · synthetic data <i/>31 Oct 2026 · 16:00 UTC</div></header>
    <div className="grid-scope-toolbar"><div><MapPinned size={15}/><span>Network</span><strong>Victoria</strong></div><label>Scenario<select aria-label="Grid scenario" value={scenario} onChange={event=>{setScenario(event.target.value as GridScenario);setContext(null);}}><option value="peak">Demand peak</option><option value="balanced">Balanced dispatch</option></select></label><label><Clock3 size={14}/>Window<select aria-label="Grid observation window" value={window} onChange={event=>{setWindow(event.target.value as GridWindow);setContext(null);}}><option value="day">Today + forecast</option><option value="recent">Last 6h + forecast</option></select></label><span className="grid-cadence">5 min samples · UTC</span><details><summary aria-label="About grid data"><CircleHelp size={15}/></summary><p>Located synthetic substations use approximate city coordinates. Lines represent a hypothetical network; this is not a utility asset map. Supply, battery power, demand and exports reconcile in each five-minute observation. Forecast intervals are authored synthetic uncertainty, not calibrated operational forecasts.</p></details></div>
    <ChartCursorProvider><div className="grid-main-row">
      {render(panels.map,'grid-map-panel')}
      <div className="grid-right-column">
        <Panel className="grid-summary-panel" title="System summary" subtitle="Latest observed snapshot, 16:00 UTC. Reserve is unused available generation capacity and is not part of generation."><div className="grid-summary">
          <MetricCard label="Demand" value={number(latest.demand)} unit="MW" detail="Latest observed" trend={data.day.slice(-36).map(p=>p.demand)} tone="cyan" icon={<Zap/>}/>
          <MetricCard label="Generation" value={number(latest.generation)} unit="MW" detail={`${number(latest.exportMW)} MW export`} trend={data.day.slice(-36).map(p=>p.generation)} tone="green" icon={<RadioTower/>}/>
          <MetricCard label="Reserve" value={number(latest.reserve)} unit="MW" detail={`${number(latest.reserve/latest.demand*100,1)}% of demand`} trend={data.day.slice(-36).map(p=>p.reserve)} tone="amber" icon={<BatteryCharging/>}/>
          <MetricCard label="Frequency" value={number(latest.frequency,3)} unit="Hz" detail="49.8–50.2 Hz band" trend={data.day.slice(-36).map(p=>p.frequency)} trendFill={false} trendDomain={[49.9,50.1]} tone="violet" icon={<Activity/>}/>
        </div></Panel>
        {render(panels.mix,'grid-mix-panel')}
        <div className="grid-battery-row">{render(panels.battery,'grid-battery-panel')}<Panel className="grid-soc-panel" title="State of charge" subtitle="Stored energy divided by usable capacity. The time series integrates signed power at five-minute intervals; charging is negative grid power."><div className="grid-soc-ring" role="img" aria-label={`${number(soc,2)} percent state of charge; ${number(latest.energy,2)} of ${BATTERY_CAPACITY_MWH} MWh`}><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="46" fill="none" stroke="#173743" strokeWidth="11"/><circle cx="60" cy="60" r="46" fill="none" stroke="#1cd0df" strokeWidth="11" strokeDasharray={`${soc/100*2*Math.PI*46} ${2*Math.PI*46}`} transform="rotate(-90 60 60)"/><text x="60" y="68" textAnchor="middle" fill="#dfedf7" fontSize="24" fontWeight="600">{number(soc)}%</text></svg><strong>{number(latest.energy)} / {BATTERY_CAPACITY_MWH} <small>MWh</small></strong><span>Usable stored energy</span></div></Panel></div>
      </div>
    </div>
    <div className="grid-bottom-row">
      {render(panels.prediction,'grid-forecast-panel')}
      {render(panels.states,'grid-state-panel',<div className="grid-state-key"><span><i style={{background:'#20bb9c'}}/>Normal</span><span><i style={{background:'#f9bf56'}}/>Degraded</span><span><i style={{background:'#f56363'}}/>Outage</span><span><i className="grid-unknown-key"/>Unknown</span></div>)}
      {render(panels.events,'grid-events-panel')}
    </div></ChartCursorProvider>
    <footer className="grid-lens-footer"><span><i/>Synthetic fixture · {data.day.length} five-minute observations · {scenario==='peak'?'demand peak':'balanced dispatch'}</span><span>Supply + battery = demand + exports · latest balance {number(latest.generation+latest.battery-latest.demand-latest.exportMW,2)} MW</span></footer>
    {context&&<div className="grid-selected-evidence" role="status"><span>Selected evidence</span><strong>{context.series??context.labels?.asset??'Record'}</strong><span>{context.value===null?'Unknown':context.value!==undefined?`${number(context.value,2)} ${context.labels?.unit??''}`:Object.entries(context.labels??{}).filter(([key])=>key!=='unit').slice(0,2).map(([key,v])=>`${key}: ${v}`).join(' · ')}</span><button onClick={()=>setContext(null)} aria-label="Clear selected grid evidence">×</button></div>}
  </main>;
}

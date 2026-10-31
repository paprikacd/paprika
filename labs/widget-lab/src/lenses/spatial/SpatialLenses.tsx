import { useMemo, useState, type ReactNode } from 'react';
import { Anchor, Antenna, ArrowUpRight, Clock3, Pencil, Radio, Ship, Waves } from 'lucide-react';
import { Panel } from '../../components/lab/StudyPrimitives';
import { ChartCursorProvider } from '../../vendor/paprika/ui/src/features/insights/chart-cursor';
import { WidgetVisualization } from '../../vendor/paprika/ui/src/features/insights/charts';
import type { Widget } from '../../vendor/paprika/ui/src/features/insights/schema';
import type { DrilldownContext } from '../../vendor/paprika/ui/src/features/insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import { registerSpatialCharts } from '../../charts/spatial/register';
import { registerLabCharts } from '../../charts/register-lab-charts';
import { buoyRows, dwellRows, fieldCells, rmsEvm, iqRows, shipments, vectorBearing } from '../../charts/spatial/model';
import { num, utc } from '../../charts/spatial/shared';
import { coastalFixtures, logisticsFixtures, spectrumFixtures, type SpatialPanel } from './fixtures';
import './spatial-lenses.css';

registerLabCharts();
registerSpatialCharts();

function Heading({ title, code, children }: { title: string; code: string; children: ReactNode }) {
  return <header className="spatial-heading"><div><p>PAPRIKA / {code}</p><h1>{title}</h1></div><div className="spatial-lens-controls">{children}</div><span className="spatial-synthetic"><i/>Concept · synthetic data</span></header>;
}
function Metric({ label, value, detail, icon, tone = 'cyan' }: {label: string; value: ReactNode; detail: string; icon: ReactNode; tone?: string}) {
  return <section className={'spatial-metric '+tone}><div className="spatial-metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></section>;
}
function ChartPanel({ panel, onEdit, selection, context, fixedHeight, className = '' }: {
  panel: SpatialPanel; onEdit?: EditLensWidget; selection?: Widget['config']; context?: (c: DrilldownContext) => void; fixedHeight?: number; className?: string;
}) {
  const [override, setOverride] = useState<Widget | null>(null);
  const widget = useMemo(() => ({ ...panel.widget, ...override, config: { ...panel.widget.config, ...override?.config, ...selection } }), [panel.widget, override, selection]);
  return <Panel title={widget.title} subtitle={panel.caption} className={'spatial-lens-panel '+className} actions={onEdit&&<button className="spatial-edit" aria-label={'Edit '+widget.title} onClick={()=>onEdit(widget,panel.result,setOverride)}><Pencil size={12}/><span>Edit</span></button>}><div className={fixedHeight?'spatial-lens-widget fixed':'spatial-lens-widget'} style={fixedHeight?{height:fixedHeight}:undefined}><WidgetVisualization widget={widget} result={panel.result} onContextChange={context}/></div></Panel>;
}

export function LogisticsLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [scope, setScope] = useState<'all'|'risk'>('all');
  const [selected, setSelected] = useState('PK-2048');
  const data = useMemo(()=>logisticsFixtures(scope),[scope]);
  const routes = useMemo(()=>shipments(data.map.result.records),[data]);
  const dwell = useMemo(()=>dwellRows(data.dwell.result.records),[data]);
  const active = routes.find(p=>p.id===selected);
  const risk = routes.filter(p=>p.risk>=40);
  const selection: Widget['config'] = {selectedId:selected};
  const select = (c: DrilldownContext) => { if(c.labels?.shipment!==undefined)setSelected(c.labels.shipment); };
  const atPromise = routes.filter(p=>p.median<=p.promise).length;
  return <main className="spatial-lens logistics-lens" data-spatial-lens="logistics">
    <Heading title="Logistics control tower" code="LOGISTICS / 08"><label>Network <select aria-label="Shipment scope" value={scope} onChange={e=>{setScope(e.target.value as 'all'|'risk');setSelected('');}}><option value="all">All shipments</option><option value="risk">At-risk shipments</option></select></label><span><Clock3 size={14}/>31 Oct – 14 Nov · UTC</span></Heading>
    <div className="spatial-metrics"><Metric icon={<Ship/>} label="In transit" value={routes.length} detail="Current shipment population"/><Metric icon={<ArrowUpRight/>} label="Median within promise" value={<>{num(atPromise/routes.length*100,0)}<em>%</em></>} detail={`${atPromise} of ${routes.length} shipments`} tone="green"/><Metric icon={<Clock3/>} label="At-risk arrivals" value={risk.length} detail="Scenario delay probability ≥ 40%" tone="amber"/><Metric icon={<Anchor/>} label="Port dwell samples" value={dwell.reduce((s,p)=>s+p.samples,0).toLocaleString()} detail="Historical population across six ports" tone="violet"/></div>
    <div className="spatial-main-grid"><ChartPanel panel={data.map} onEdit={onEdit} selection={selection} context={select}/><ChartPanel panel={data.eta} onEdit={onEdit} selection={selection} context={select}/></div>
    <div className="spatial-secondary-grid"><ChartPanel panel={data.dwell} onEdit={onEdit}/><Panel title="Shipment evidence" subtitle="Select a row to inspect the same shipment on the route map and arrival windows." className="spatial-lens-panel"><div className="spatial-lens-table-scroll"><table className="spatial-lens-table"><thead><tr><th>Shipment / lane</th><th>Median ETA · UTC</th><th>Promise slack</th><th>Delay risk</th><th>Scenario driver</th></tr></thead><tbody>{routes.map(p=><tr key={p.id} className={selected===p.id?'selected':''}><td><button aria-pressed={selected===p.id} onClick={()=>setSelected(p.id)}>{p.id}</button><small>{p.source} → {p.destination}</small></td><td>{utc(p.median,true)}</td><td className={p.median>p.promise?'risk':'good'}>{num((p.promise-p.median)/3600000,0)} h</td><td><div className="spatial-inline-meter"><i style={{width:p.risk+'%',background:p.risk>=65?'#f56c62':p.risk>=40?'#ffbf56':'#19c5d8'}}/><span>{p.risk}%</span></div></td><td>{p.cause}</td></tr>)}</tbody></table></div></Panel></div>
    <footer className="spatial-lens-footer"><span>Illustrative routes · authored ETA uncertainty · no connected shipment provider</span><span>{active?`Linked shipment ${active.id} · ${active.carrier}`:'Select a shipment to link map, ETA and evidence'}</span></footer>
  </main>;
}

export function SpectrumLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [receiver, setReceiver] = useState(0);
  const data = useMemo(()=>spectrumFixtures(receiver),[receiver]);
  const cells = useMemo(()=>fieldCells(data.analyzer.result.records,'frequency','timestamp','power'),[data]);
  const samples = useMemo(()=>iqRows(data.iq.result.records),[data]);
  const known=cells.filter(p=>p.value!==null), peak=Math.max(...known.map(p=>p.value!));
  const frequencies=[2.412+receiver*.001,2.437,2.447,2.466];
  const [selectedEvidence,setSelectedEvidence] = useState<DrilldownContext|null>(null);
  return <main className="spatial-lens spectrum-lens" data-spatial-lens="spectrum">
    <Heading title="Spectrum observatory" code="SPECTRUM / 09"><label>Receiver <select aria-label="Spectrum receiver" value={receiver} onChange={e=>{setReceiver(Number(e.target.value));setSelectedEvidence(null);}}><option value={0}>RF-04 · North array</option><option value={1}>RF-05 · East array</option></select></label><span><Clock3 size={14}/>14:20 – 14:30 UTC</span></Heading>
    <div className="spatial-metrics"><Metric icon={<Antenna/>} label="Frequency span" value={<>80<em>MHz</em></>} detail="2.400 – 2.480 GHz · 500 kHz bins"/><Metric icon={<Radio/>} label="Peak observed power" value={<>{num(peak,1)}<em>dBm</em></>} detail="Maximum observed bin in the fixture" tone="amber"/><Metric icon={<ArrowUpRight/>} label="Acquisition coverage" value={<>{num(known.length/cells.length*100,1)}<em>%</em></>} detail={`${known.length.toLocaleString()} of ${cells.length.toLocaleString()} bins`} tone="green"/><Metric icon={<Radio/>} label="RMS error vector" value={<>{num(rmsEvm(samples),2)}<em>%</em></>} detail={`${samples.length.toLocaleString()} complex 16-QAM samples`} tone="violet"/></div>
    <div className="spatial-spectrum-grid"><ChartPanel panel={data.analyzer} onEdit={onEdit} context={setSelectedEvidence}/><div className="spatial-side-stack"><ChartPanel panel={data.iq} onEdit={onEdit}/><Panel title="Carrier evidence" subtitle="Per-frequency maxima across observed acquisitions; missing bins are excluded." className="spatial-lens-panel"><div className="spatial-lens-table-scroll"><table className="spatial-lens-table"><thead><tr><th>Carrier</th><th>Frequency</th><th>Peak power</th></tr></thead><tbody>{frequencies.map((f,i)=>{const values=known.filter(p=>Math.abs(p.x-f)<.00001);return <tr key={f}><td>C{String(i+1).padStart(2,'0')}</td><td>{f.toFixed(3)} GHz</td><td>{num(Math.max(...values.map(p=>p.value!)),2)} dBm</td></tr>;})}</tbody></table></div></Panel></div></div>
    <ChartPanel panel={data.occupancy} onEdit={onEdit} fixedHeight={300}/>
    <div className="spatial-state-key"><span><i style={{background:'#193d4a'}}/>Idle</span><span><i style={{background:'#10cbe1'}}/>On air</span><span><i style={{background:'#ffc151'}}/>Collision</span><span><i className="unknown"/>Unknown acquisition</span></div>
    <footer className="spatial-lens-footer"><span>Synthetic RF scenario · drag across the spectrum to change its frequency window</span><span>{selectedEvidence?.labels?.frequency?`Selected ${selectedEvidence.labels.frequency} GHz`:'Spectrogram and spectrum share exact frequency gutters'}</span></footer>
  </main>;
}

export function CoastalLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [selected,setSelected]=useState('B07');
  const base=useMemo(()=>coastalFixtures(),[]);
  const data=useMemo(()=>{
    const fixture=coastalFixtures(selected||'B07');
    if(selected)return fixture;
    const empty=(panel:SpatialPanel):SpatialPanel=>({...panel,widget:{...panel.widget,title:'Select a buoy · '+panel.widget.title.split(' · ')[0]},result:panel.result.records?{records:{...panel.result.records,rows:[]}}:{series:[]}});
    return {...fixture,rose:empty(fixture.rose),curtain:empty(fixture.curtain),tide:empty(fixture.tide)};
  },[selected]);
  const buoys=useMemo(()=>buoyRows(base.map.result.records).filter(p=>p.kind==='buoy'),[base]);
  const active=buoys.find(p=>p.id===selected);
  const [timeEvidence,setTimeEvidence]=useState<DrilldownContext|null>(null);
  const selection: Widget['config'] = {selectedId:selected};
  const choose=(id:string)=>{setSelected(id);setTimeEvidence(null);};
  const selectMap=(c:DrilldownContext)=>{if(c.labels?.buoy!==undefined)choose(c.labels.buoy);};
  return <ChartCursorProvider><main className="spatial-lens coastal-lens" data-spatial-lens="coastal">
    <Heading title="Coastal observatory" code="COASTAL / 10"><label>Buoy <select aria-label="Linked coastal buoy" value={selected} onChange={e=>choose(e.target.value)}><option value="">Select buoy</option>{buoys.map(p=><option key={p.id} value={p.id}>{p.id} · {p.label}</option>)}</select></label><span><Clock3 size={14}/>31 Oct · 24 hours · UTC</span></Heading>
    <div className="spatial-metrics"><Metric icon={<Waves/>} label="Selected current" value={active?.u!=null?<>{num(Math.hypot(active.u,active.v!),2)}<em>m/s</em></>:'Unknown'} detail={active?.u!=null?`Flow toward ${num(vectorBearing(active.u,active.v!),0)}° · ${selected}`:'No current observation at the selected buoy'}/><Metric icon={<Waves/>} label="Significant wave height" value={active?.wave!=null?<>{num(active.wave,2)}<em>m</em></>:'Unknown'} detail={selected||'Choose a buoy'} tone="violet"/><Metric icon={<Radio/>} label="Surface temperature" value={active?.temperature!=null?<>{num(active.temperature,2)}<em>°C</em></>:'Unknown'} detail="Latest scenario snapshot" tone="amber"/><Metric icon={<Anchor/>} label="Reporting buoys" value={<>{buoys.filter(p=>p.u!==null).length}<em>/ {buoys.length}</em></>} detail="One buoy has unknown current data" tone="green"/></div>
    <div className="spatial-coast-grid"><ChartPanel panel={base.map} onEdit={onEdit} selection={selection} context={selectMap}/><ChartPanel panel={data.rose} onEdit={onEdit}/></div>
    <div className="spatial-coast-grid"><ChartPanel panel={data.curtain} onEdit={onEdit} context={setTimeEvidence}/><ChartPanel panel={data.tide} onEdit={onEdit} fixedHeight={330}/></div>
    <Panel title="Buoy observations" subtitle="Selecting a buoy updates the directional population, depth observations and tidal comparison. Snapshot missingness remains explicit." className="spatial-lens-panel"><div className="spatial-lens-table-scroll"><table className="spatial-lens-table"><thead><tr><th>Buoy</th><th>Location</th><th>Current · m/s</th><th>Flow toward</th><th>Wave · m</th><th>Surface · °C</th><th>Coverage</th></tr></thead><tbody>{buoys.map(p=><tr key={p.id} className={selected===p.id?'selected':''}><td><button aria-pressed={selected===p.id} onClick={()=>choose(p.id)}>{p.id}</button></td><td>{p.label}</td><td>{p.u===null?'Unknown':num(Math.hypot(p.u,p.v!),3)}</td><td>{p.u===null?'Unknown':num(vectorBearing(p.u,p.v!),1)+'°'}</td><td>{num(p.wave)}</td><td>{num(p.temperature)}</td><td>{p.coverage===null?'Unknown':num(p.coverage,1)+'%'}</td></tr>)}</tbody></table></div></Panel>
    <footer className="spatial-lens-footer"><span>Entire basin, bathymetry, currents and buoy records are synthetic scenario data</span><span>{timeEvidence?.labels?.timestamp?`Selected ${utc(Number(timeEvidence.labels.timestamp),true)} UTC`:`Linked buoy ${selected||'none'} · camera position persists independently`}</span></footer>
  </main></ChartCursorProvider>;
}

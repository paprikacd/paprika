import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { useMemo, useState } from 'react';
import { Activity, ArrowUpRight, Clock3, FileText, Plus, ShieldAlert, X } from 'lucide-react';
import { Panel, Sparkline } from '../components/lab/StudyPrimitives';
import { registerLabCharts } from '../charts/register-lab-charts';
import { registerIncidentCharts } from '../charts/incident/register';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { ChartCursorProvider } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import type { QueryResult, Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import type { EditLensWidget } from './LensStudio';
import { GeoMap } from '../charts/geo/GeoMap';
import type { GeoGeometry, GeoLocation } from '../charts/geo/geo-data';
import { worldLandPath } from '../vendor/paprika/ui/src/features/insights/plugins/world-land';
import { INCIDENT_END, INCIDENT_EVIDENCE, INCIDENT_REGIONS, INCIDENT_SERVICES, INCIDENT_START, incidentDependencyPanel, incidentTelemetryPanel, incidentTracePanel, type IncidentService } from './incident-room-data';
import './IncidentRoomLens.css';

registerLabCharts();registerIncidentCharts();
const geometry:GeoGeometry={width:720,height:360,description:'Natural Earth world outline, WGS84 equirectangular projection',countries:[{name:'World land',path:worldLandPath}],project:(longitude,latitude)=>[(longitude+180)*2,(90-latitude)*2]};
const regions:GeoLocation[]=INCIDENT_REGIONS.map(region=>({id:region.id,label:region.name,longitude:region.longitude,latitude:region.latitude,value:region.traffic,severity:region.id==='ap-southeast'?'high':'medium'}));
type PanelSource={widget:Widget;result:QueryResult};

export function IncidentRoomLens({onEdit}:{onEdit?:EditLensWidget}) {
  const [service,setService]=useState<IncidentService>('checkout-api'),[region,setRegion]=useState<string|null>(null);
  const [evidence,setEvidence]=useState<(typeof INCIDENT_EVIDENCE)[number]|null>(null),[addingNote,setAddingNote]=useState(false),[note,setNote]=useState('');
  const [notes,setNotes]=useState([{time:'09:41',text:'Elevated checkout errors across multiple regions.'},{time:'09:43',text:'Payment latency and retry counts increased.'},{time:'09:49',text:'Partial recovery observed in EU West.'}]);
  const telemetry=useMemo(()=>incidentTelemetryPanel(service),[service]),dependency=useMemo(incidentDependencyPanel,[]),trace=useMemo(incidentTracePanel,[]);
  const panels = useDashboardPanels(onEdit);
  const current = (panel: PanelSource) => panels.current(panel.widget);
  const edit = panels.actions;
  const errorTotal=INCIDENT_REGIONS.reduce((sum,item)=>sum+item.errors,0),activeRegion=INCIDENT_REGIONS.find(item=>item.id===region);
  return <main className="incident-room-lens">
    <header className="incident-room-heading"><div><p>PAPRIKA / SERVICES</p><h1>Incident Room <span>INC-2048</span><b>SEV 2</b></h1><span className="incident-heading-detail"><ShieldAlert size={13}/>Investigating · synthetic incident reconstruction</span></div><div className="incident-heading-tools"><label>Service<select aria-label="Incident service" value={service} onChange={event=>setService(event.target.value as IncidentService)}>{INCIDENT_SERVICES.map(item=><option value={item.id} key={item.id}>{item.id}</option>)}</select></label><span><Clock3 size={13}/>31 Oct 2026 · 09:30–10:00 UTC</span></div></header>
    <div className="incident-room-workspace">
      <aside className="incident-room-sidebar">
        <section className="incident-service-list"><header><h2>Impacted services</h2><span>3 / 6</span></header>{INCIDENT_SERVICES.map(item=><button key={item.id} aria-pressed={service===item.id} onClick={()=>setService(item.id)}><Activity size={13}/><strong>{item.id}</strong><span data-tone={item.tone}><i/>{item.status}</span></button>)}<p>Fixture status at incident peak · telemetry below follows the selected service.</p></section>
        <section className="incident-notes"><header><h2>Incident notes</h2><button aria-label={addingNote?'Cancel note':'Add incident note'} onClick={()=>setAddingNote(!addingNote)}>{addingNote?<X size={13}/>:<Plus size={13}/>}</button></header>{notes.map((item,index)=><article key={`${item.time}-${index}`}><time>{item.time}</time><p>{item.text}</p></article>)}{addingNote&&<form onSubmit={event=>{event.preventDefault();if(!note.trim())return;setNotes(previous=>[...previous,{time:'10:00',text:note.trim()}]);setNote('');setAddingNote(false);}}><label>Session note<textarea aria-label="Incident note" value={note} maxLength={300} onChange={event=>setNote(event.target.value)}/></label><button type="submit" disabled={!note.trim()}>Add note</button><small>Saved in this open lens only.</small></form>}</section>
        <section className="incident-traffic-map"><header><h2>Global traffic</h2><span>req/s</span></header><GeoMap label="Incident regional traffic" locations={regions} geometry={geometry} valueLabel="req/s" classificationLabels={{low:'Healthy',medium:'Degraded',high:'Errors',unknown:'Unknown'}} onSelect={location=>setRegion(location?.id??null)} selectionRevision={regions} selectedLocationId={region}/><div className="incident-map-legend"><span><i/>Degraded</span><span><i/>Errors</span></div><p>{activeRegion?<>{activeRegion.name} · {activeRegion.traffic.toLocaleString()}req/s · {(activeRegion.errors/errorTotal*100).toFixed(0)}% of sampled failures</>:'Select a region to compare its traffic and error share.'}</p></section>
        <div className="incident-coverage-note"><FileText size={14}/><span>Missing telemetry begins at 09:56 UTC. Unknown intervals are hatched, never filled with zeros.</span></div>
      </aside>
      <div className="incident-room-content"><ChartCursorProvider>
        <div className="incident-overview-grid">
          <Panel title={`${current(telemetry).title} · ${service}`} subtitle="All three lanes use the exact same time axis. Brush zoom affects this compound telemetry panel only, preserving incident evidence and the full-population summary. p95 values are supplied per-bucket fixture statistics; they are not averages of per-instance percentiles." actions={edit(telemetry)} className="incident-telemetry-panel"><div className="incident-telemetry-summary"><span>Observed requests <strong>{(telemetry.summary.requests/1e6).toFixed(2)}M</strong></span><span>Pooled error ratio <strong>{telemetry.summary.errorRatio?.toFixed(2)??'—'}%</strong></span><span>Coverage <strong>{telemetry.summary.observed}/{telemetry.samples.length} samples</strong></span></div><div className="incident-widget"><WidgetVisualization widget={current(telemetry)} result={telemetry.result}/></div></Panel>
          <Panel title={current(dependency).title} subtitle="Directed call relationships for the incident population. Edges show supplied median latency. Node error ratio pools observed incoming calls; this is a call graph, not a proof of causation." actions={edit(dependency)} className="incident-dependency-panel"><div className="incident-widget"><WidgetVisualization widget={current(dependency)} result={dependency.result}/></div><div className="incident-affected-regions"><h3>Affected regions <span>share of 10,000 sampled failures</span></h3>{INCIDENT_REGIONS.map(item=><button key={item.id} onClick={()=>setRegion(item.id)} aria-pressed={region===item.id}><span>{item.name}</span><strong>{(item.errors/errorTotal*100).toFixed(0)}%</strong><span className="incident-region-track"><i style={{width:`${item.errors/errorTotal*100}%`}}/></span></button>)}</div></Panel>
        </div>
        <Panel title={current(trace).title} subtitle="A 1,892ms sampled checkout request. Parent-child intervals are validated, parallel spans overlap, and filtering does not rewrite elapsed time. Use the span search, collapse controls, drag selection and Focus selected action." actions={edit(trace)} className="incident-trace-panel"><div className="incident-trace-context"><span>checkout-api · sampled request at 09:44:03 UTC</span><code>7f3a2e0c9b4d1a77</code></div><div className="incident-widget"><WidgetVisualization widget={current(trace)} result={trace.result}/></div></Panel>
      </ChartCursorProvider>
        <Panel title="Evidence & timeline" subtitle="Recorded fixture evidence. Selecting a row opens its source details without pretending to navigate to a live logging or deployment system." className="incident-evidence-panel"><div className="incident-evidence-scroll"><table><thead><tr><th>Time (UTC)</th><th>Type</th><th>Service</th><th>Observation</th><th>Evidence</th></tr></thead><tbody>{INCIDENT_EVIDENCE.map(item=><tr key={item.id} data-selected={evidence?.id===item.id}><td>{new Date(item.time).toISOString().slice(11,19)}</td><td><i data-kind={item.kind}/>{item.kind}</td><td>{item.service}</td><td>{item.message}</td><td><button onClick={()=>setEvidence(item)} aria-label={`Inspect ${item.kind.toLowerCase()} evidence`}>Inspect<ArrowUpRight size={11}/></button></td></tr>)}</tbody></table></div>{evidence&&<div className="incident-evidence-detail" role="region" aria-label="Selected incident evidence"><FileText size={16}/><div><strong>{evidence.kind} · {new Date(evidence.time).toISOString()}</strong><p>{evidence.detail}{evidence.span&&<> Search the trace for <code>{evidence.span==='bank'?'bank.authorize':'payments.authorize'}</code> to inspect the related span.</>}</p></div><button aria-label="Close incident evidence" onClick={()=>setEvidence(null)}><X size={14}/></button></div>}</Panel>
      </div>
    </div><footer className="incident-room-footer"><span>Concept • synthetic data · 10-second samples · source range {new Date(INCIDENT_START).toISOString().slice(11,16)}–{new Date(INCIDENT_END).toISOString().slice(11,16)} UTC</span><span>Context → aligned telemetry → trace → source evidence</span></footer>
  </main>;
}

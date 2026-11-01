import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { useMemo, useState, type CSSProperties } from 'react';
import { Activity, CircleCheck, CircleHelp, Clock3, Globe2, Server, ShieldCheck, X } from 'lucide-react';
import { registerLabCharts } from '../charts/register-lab-charts';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { ChartCursorProvider } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import type { QueryResult, Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import { buildInfrastructureLens, buildWebsiteLens, OPERATIONS_AS_OF, type OperationsKind, type OperationsPanel } from './operations-data';
import './OperationsLenses.css';

registerLabCharts();
export type OperationsLensEdit = (widget: Widget, result: QueryResult, apply: (next: Widget) => void) => void;

export function OperationsLenses({ kind, onEdit }: { kind: OperationsKind; onEdit?: OperationsLensEdit }) {
  const [minutes, setMinutes] = useState<60 | 180>(180), [notes, setNotes] = useState(false);
  const panels = useDashboardPanels(onEdit);
  const website = useMemo(() => buildWebsiteLens(minutes), [minutes]);
  const infrastructure = useMemo(buildInfrastructureLens, []);
  const isWebsite = kind === 'website';
  const axisTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const panel = (source: OperationsPanel, className = '', stat = false) => {
    const active = panels.current(source.widget);
    return <section className={`operations-panel ${className} ${stat ? 'operations-kpi' : ''}`} key={active.id} style={source.accent ? { '--operations-accent': source.accent } as CSSProperties : undefined}>
      <header><h2>{active.title}</h2><div className="operations-panel-actions"><details><summary aria-label={`About ${active.title}`}><CircleHelp size={13}/></summary><p>{source.caption}. Deterministic synthetic observations as of {new Date(OPERATIONS_AS_OF).toISOString().slice(0,16).replace('T',' ')} UTC. Presentation edits keep the same data.</p></details>{panels.actions(source)}</div></header>
      <div className="operations-panel-chart"><WidgetVisualization widget={active} result={source.result}/></div>
      <p className="operations-panel-caption">{source.caption}</p>
    </section>;
  };
  return <main className={`operations-lens operations-${kind}`}>
    <header className="operations-heading"><div><p>PAPRIKA / {isWebsite ? 'DIGITAL EXPERIENCE' : 'INFRASTRUCTURE'}</p><h1>{isWebsite ? 'Website overview' : 'Home infrastructure'}</h1><span>{isWebsite ? <Globe2 size={13}/> : <Server size={13}/>} {isWebsite ? 'app.paprika.example · production fixture' : 'homelab-west · 12 nodes · 2 uplinks'}<i/>Synthetic observations</span></div>
      <div className="operations-heading-tools"><div className="operations-time-meta"><span><Clock3 size={14}/>Snapshot · 30 Oct 2026 · 10:00 UTC</span><small>Chart axes: {axisTimezone} · exact inspection: UTC</small></div>{isWebsite ? <label>Window<select aria-label="Website query window" value={minutes} onChange={event => setMinutes(Number(event.target.value) as 60 | 180)}><option value={60}>Last 1 hour</option><option value={180}>Last 3 hours</option></select></label> : <span className="operations-range">Last 12 hours</span>}<button className="operations-guide-button" aria-expanded={notes} aria-label="Show lens data notes" onClick={() => setNotes(value => !value)}><CircleHelp size={16}/></button></div>
    </header>
    {notes && <aside className="operations-notes"><div><strong>One fixture, explicit scope</strong><p>{isWebsite ? 'The three headline event totals and every plot use the selected loaded window. Sign-ins, new accounts and sign-outs are separate event populations. Page-load bars are exclusive duration buckets, not cumulative percentiles.' : 'Both maps use independent camera state and exact location records. Probe risk is classified by RTT; blocked-source risk is classified by count. Capacity and network observations use the same fixed snapshot.'} Dragging a time-series chart changes only that chart window. Edit controls change local presentation.</p></div><button aria-label="Close lens notes" onClick={() => setNotes(false)}><X size={16}/></button></aside>}
    <ChartCursorProvider>
      {isWebsite ? <>
        <div className="operations-metrics operations-metrics-three">{website.summaries.map(source => panel(source, '', true))}</div>
        <div className="operations-three-plots">{panel(website.panels.memory)}{panel(website.panels.sessions)}{panel(website.panels.cpu)}</div>
        <div className="operations-two-plots">{panel(website.panels.requests, 'operations-request-panel')}{panel(website.panels.latency, 'operations-latency-panel')}</div>
        {panel(website.panels.transfer, 'operations-wide-plot')}
      </> : <>
        <div className="operations-map-row"><section className="operations-health"><header><ShieldCheck size={16}/><h2>Current health</h2></header><p>Latest observed status</p><ul>{infrastructure.health.map(item => <li key={item.name} data-state={item.state}><span className="operations-health-icon">{item.state === 'Healthy' ? <CircleCheck size={15}/> : <Activity size={15}/>}</span><div><strong>{item.name}</strong><small>{item.detail}</small></div><span className="operations-health-state">{item.state}</span></li>)}</ul><footer><i/>10 probe locations</footer></section>{panel(infrastructure.panels.blocked, 'operations-map-panel')}{panel(infrastructure.panels.latency, 'operations-map-panel')}</div>
        <div className="operations-metrics operations-metrics-six">{infrastructure.summaries.map(source => panel(source, '', true))}</div>
        <div className="operations-three-plots operations-host-plots">{panel(infrastructure.panels.cpu)}{panel(infrastructure.panels.memory)}{panel(infrastructure.panels.storage, 'operations-storage-panel')}</div>
        {panel(infrastructure.panels.network, 'operations-wide-plot')}
      </>}
    </ChartCursorProvider>
    <p className="operations-footnote">{isWebsite ? `${minutes} one-minute event buckets · requests and duration groups reconcile before rendering.` : '144 five-minute observations per series · all map locations and system values are synthetic.'} Hover or pin a sample for exact values. Use a panel’s Edit action to change its presentation.</p>
  </main>;
}

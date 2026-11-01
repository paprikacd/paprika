import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Box, Server, Layers } from 'lucide-react';
import type { EditLensWidget } from '../LensStudio';
import type { DrilldownContext } from '@insights/drilldown';
import { CHART_COLORS as C, DetailValues, DomainChartPanel, DomainHeader, MetricStrip } from '../../components/lab/DomainPrimitives';
import { Sparkline } from '../../components/lab/StudyPrimitives';
import { registerLabCharts } from '../../charts/register-lab-charts';
import { registerKubernetesCharts } from '../../charts/kubernetes/register';
import { fleetBack, fleetBreadcrumb, nodeFor, resourceSummary, resourceTimepoints, selectExisting, workloadSummary, type FleetEntity } from '../../charts/kubernetes/model';
import { fleetNumber } from '../../charts/kubernetes/PlacementChart';
import { FLEET_NAMESPACES, fleetTrend, kubernetesFixtures, kubernetesPanel, type FleetNamespace, type FleetPreset } from './fixtures';
import './kubernetes-lens.css';

registerLabCharts(); registerKubernetesCharts();
const statusTone = (entity: FleetEntity) => entity.status === 'Ready' || entity.status === 'Running' ? 'green' : entity.status === 'Pending' ? 'amber' : 'muted';

export function KubernetesFleetLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [namespace, setNamespace] = useState<FleetNamespace>('all'), [preset, setPreset] = useState<FleetPreset>('ready');
  const data = useMemo(() => kubernetesFixtures(namespace, preset), [namespace, preset]);
  const [requested, setRequested] = useState('node-au-17'), [selectedAt, setSelectedAt] = useState<number | null>(null), [search, setSearch] = useState('');
  const selectedId = selectExisting(data.entities, requested), selected = data.entities.find(e => e.id === selectedId), selectedNode = nodeFor(data.entities, selectedId);
  const nodes = data.entities.filter(e => e.kind === 'node'), pods = data.entities.filter(e => e.kind === 'pod'), pending = pods.filter(p => p.status === 'Pending'), cluster = resourceSummary(data.entities), current = resourceSummary(data.entities, selectedId);
  const chain = fleetBreadcrumb(data.entities, selectedId), children = data.entities.filter(e => selected ? e.parentId === selected.id : e.kind === 'node');
  const query = search.trim().toLowerCase(), matches = query ? data.entities.filter(e => `${e.name} ${e.namespace ?? ''}`.toLowerCase().includes(query)).slice(0, 15) : [];
  const selectedTrend = useMemo(() => {
    const panel = kubernetesPanel('kubernetes-resource-trend', `${selected?.name ?? 'Cluster'} · resource history`, fleetTrend(data.entities, selectedId), { showNetwork: false, showRequested: true, fill: true }, 'Same synthetic observations as cluster strips · 11:00–12:00 UTC');
    panel.widget.id = 'fleet-selected-resource-history'; return panel;
  }, [data, selectedId]);
  const workloads = useMemo(() => workloadSummary(data.entities).map(w => ({ ...w, history: resourceTimepoints(fleetTrend(data.entities.filter(e => e.kind === 'node' || e.workload === w.id)).records) })), [data]);
  const choose = (id: string) => { setRequested(selectExisting(data.entities, id)); setSearch(''); };
  const context = (value: DrilldownContext) => {
    if (value.labels?.entityId !== undefined) choose(value.labels.entityId);
    if (value.labels?.clearTime === 'true') setSelectedAt(null);
    else if (value.labels?.timestamp && Number.isFinite(Number(value.labels.timestamp))) setSelectedAt(Number(value.labels.timestamp));
  };
  const changeScope = (nextNamespace: FleetNamespace, nextPreset: FleetPreset) => { setNamespace(nextNamespace); setPreset(nextPreset); setRequested(''); setSelectedAt(null); setSearch(''); };
  const pendingCpu = pending.reduce((sum, pod) => sum + resourceSummary(data.entities, pod.id).cpuRequested, 0), pendingMemory = pending.reduce((sum, pod) => sum + resourceSummary(data.entities, pod.id).memoryRequested, 0);
  return <main className="domain-lens kubernetes-lens" data-domain-lens="kubernetes-fleet">
    <DomainHeader title="Kubernetes Fleet"><span>Cluster prod-au</span><label>Namespace <select aria-label="Kubernetes namespace" value={namespace} onChange={event => changeScope(event.target.value as FleetNamespace, preset)}>{FLEET_NAMESPACES.map(value => <option key={value} value={value}>{value === 'all' ? 'All namespaces' : value}</option>)}</select></label><label>Data <select aria-label="Kubernetes observation scenario" value={preset} onChange={event => changeScope(namespace, event.target.value as FleetPreset)}><option value="ready">Snapshot</option><option value="gaps">Additional missing node</option></select></label><span>29 Oct 2026 · 11:00–12:00 UTC</span></DomainHeader>
    <MetricStrip items={[
      { label: 'Nodes', value: nodes.length }, { label: 'Ready', value: `${nodes.filter(n => n.status === 'Ready').length} / ${nodes.length}`, tone: 'green' },
      { label: 'Pods', value: pods.length, detail: `${pods.filter(p => p.status === 'Unknown').length} with unknown state` }, { label: 'Pending', value: pending.length, tone: 'amber', detail: 'Outside scheduled totals' },
      { label: 'CPU requests', value: `${fleetNumber(cluster.cpuRequested / (cluster.cpuAllocatable || 1) * 100, 1)}%`, detail: `${fleetNumber(cluster.cpuRequested)} / ${fleetNumber(cluster.cpuAllocatable)} allocatable cores` },
    ]}/>
    <div className="kube-lens-grid"><div className="kube-main">
      <div className="kube-overview-grid"><DomainChartPanel panel={data.placement} onEdit={onEdit} selection={{ selectedId, selectionOwner: 'host' }} onContextChange={context}/><DomainChartPanel panel={data.throttling} onEdit={onEdit} selection={{ selectedNode }} onContextChange={context}/></div>
      <DomainChartPanel panel={data.trend} onEdit={onEdit} selection={{ selectedAt }} onContextChange={context}/>
      <section className="kube-workloads"><header><h2>Workloads requiring attention</h2><span>Observed usage · scheduled containers</span></header><div className="domain-table-scroll"><table className="domain-table"><thead><tr><th>Deployment</th><th>Namespace</th><th>Running / desired</th><th>Restarts</th><th>Pending / unknown</th><th>CPU · cores</th><th>Memory · GiB</th><th>State</th></tr></thead><tbody>{workloads.map(w => <tr key={w.id} data-selected={selected?.workload === w.id}>
        <td><button className="kube-text-button" onClick={() => choose(w.firstPod)}>{w.id}</button></td><td>{w.namespace}</td><td>{w.running} / {w.desired}</td><td>{w.restarts}</td><td>{w.pending} / {w.unknown}</td>
        <td><div className="kube-table-metric"><span>{fleetNumber(w.cpuUsed)}</span><Sparkline values={w.history.map(p => p.cpuUsed)} height={24} color={C.cyan} label={`${w.id} observed CPU trend, cores`}/></div></td><td><div className="kube-table-metric"><span>{fleetNumber(w.memoryUsed)}</span><Sparkline values={w.history.map(p => p.memoryUsed)} height={24} color={C.violet} label={`${w.id} observed memory trend, GiB`}/></div></td><td><span className="kube-status" data-tone={w.pending || w.unknown ? 'amber' : 'green'}>{w.pending ? 'Pending pods' : w.unknown ? 'Partial telemetry' : 'Running'}</span></td>
      </tr>)}</tbody></table></div></section>
    </div><aside className="kube-detail-dock" aria-label="Kubernetes entity details">
      <div className="kube-search"><label htmlFor="kube-entity-search">Search nodes, pods, containers</label><input id="kube-entity-search" className="domain-control" value={search} onChange={event => setSearch(event.target.value)} placeholder="Entity or namespace"/>{query && <div className="kube-search-results" aria-label="Entity search results">{matches.length ? matches.map(entity => <button key={entity.id} onClick={() => choose(entity.id)}><span>{entity.name}</span><small>{entity.kind} · {entity.nodeId ?? 'Unscheduled'}</small></button>) : <p>No matching entities</p>}</div>}</div>
      <section className="kube-entity-heading"><div><h2>{selected?.name ?? 'Cluster prod-au'}</h2>{selectedId && <button className="kube-back domain-control" onClick={() => choose(fleetBack(data.entities, selectedId))}><ArrowLeft size={13}/>Back to {selected?.kind === 'container' ? 'pod' : selected?.kind === 'pod' && selected.nodeId ? 'node' : 'cluster'}</button>}</div>
        <nav className="kube-breadcrumb" aria-label="Kubernetes drilldown"><button onClick={() => choose('')}>prod-au</button>{chain.map((entity, i) => <span key={entity.id}><ChevronRight size={12}/>{i === chain.length - 1 ? <strong aria-current="page">{entity.name}</strong> : <button onClick={() => choose(entity.id)}>{entity.name}</button>}</span>)}</nav>
        {selected ? <DetailValues items={[
          ['State', <span className="kube-status" data-tone={statusTone(selected)}>{selected.status}</span>], ['Zone', selected.zone ?? 'Unscheduled'], ['Namespace', selected.namespace ?? 'Scoped namespaces'], ['Measured containers', `${current.cpuUsed.count} / ${current.expected}`],
        ]}/> : <p className="domain-note">Select a node in the placement map, then drill into its pods and containers. Namespace filtering keeps all 48 physical node capacities visible.</p>}
      </section>
      <DomainChartPanel panel={data.resources} onEdit={onEdit} selection={{ selectedId }}/>
      <section className="kube-topology"><header><h2>{selected?.kind === 'container' ? 'Container evidence' : selected?.kind === 'pod' ? 'Containers in pod' : selected?.kind === 'node' ? 'Pods on node' : 'Cluster nodes'}</h2><span>{children.length ? `${children.length} direct children` : selected?.kind ?? 'Cluster'}</span></header>
        {children.length ? <div className="kube-child-list">{children.map(child => {
          const summary = resourceSummary(data.entities, child.id), Icon = child.kind === 'node' ? Server : child.kind === 'pod' ? Layers : Box;
          return <button key={child.id} className="kube-child" onClick={() => choose(child.id)} aria-label={`Inspect ${child.kind} ${child.name}`}><Icon size={15}/><span><strong>{child.name}</strong><small>{child.kind === 'node' ? child.zone : `${fleetNumber(summary.cpuUsed.value)} cores · ${fleetNumber(summary.memoryUsed.value)} GiB observed`}</small></span><span className="kube-status" data-tone={statusTone(child)}>{child.status}</span><ChevronRight size={13}/></button>;
        })}</div> : selected?.kind === 'container' ? <DetailValues items={[
          ['Container identity', selected.id], ['CPU request / limit', `${fleetNumber(selected.cpuRequest)} / ${fleetNumber(selected.cpuLimit)} cores`], ['Memory request / limit', `${fleetNumber(selected.memoryRequest)} / ${fleetNumber(selected.memoryLimit)} GiB`], ['Restarts in snapshot hour', selected.restarts], ['Ingress / egress', `${fleetNumber(selected.networkRx)} / ${fleetNumber(selected.networkTx)} Mb/s`], ['Observation', selected.reason ?? 'Synthetic container measurements available'],
        ]}/> : <p className="domain-note">No child entities in this namespace scope.</p>}
      </section>
      {pending.length > 0 && <section className="kube-pending"><header><h2>Why pending?</h2><span>{pending.length} unscheduled pods</span></header><p>{fleetNumber(pendingCpu)} CPU cores and {fleetNumber(pendingMemory)} GiB requested outside scheduled totals.</p>{[...new Set(pending.map(p => p.reason))].map(reason => <p key={reason}><span className="kube-status" data-tone="amber">{pending.filter(p => p.reason === reason).length}</span> {reason}</p>)}<button className="kube-text-button" onClick={() => choose(pending[0].id)}>Inspect a pending pod <ChevronRight size={12}/></button></section>}
      {selected && <DomainChartPanel panel={selectedTrend} onEdit={onEdit} selection={{ selectedAt }} onContextChange={context}/>} 
    </aside></div>
    <footer className="kube-lens-footer">Synthetic 48-node fleet · no live connection · all usage is observed container workload usage; operating-system overhead is excluded. Namespace filters affect workload totals and preserve node allocatable capacity.</footer>
  </main>;
}

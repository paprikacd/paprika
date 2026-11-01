import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Clock3, Layers3 } from 'lucide-react';
import type { DrilldownContext } from '../../vendor/paprika/ui/src/features/insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import { DomainChartPanel, DomainHeader, MetricStrip, DetailValues } from '../../components/lab/DomainPrimitives';
import { Panel } from '../../components/lab/StudyPrimitives';
import { applyBacklog, commitLag, distributedUtc, formatIndex, ownerAt, replicaState } from '../../charts/distributed/model';
import { ReplicaValues } from '../../charts/distributed/shared';
import { registerDistributedCharts } from '../../charts/distributed/register';
import { DISTRIBUTED_END, distributedEvents, distributedFixtures, distributedFleet, type DistributedFixture, type DistributedScenario } from './fixtures';
import './distributed-lens.css';

registerDistributedCharts();
type Depth = 'cluster' | 'shard' | 'replica';
type DetailTab = 'overview' | 'log' | 'network';

function EventEvidence({ data, selectedReplica, onSelect }: { data: DistributedFixture; selectedReplica: string; onSelect: (replica: string) => void }) {
  return <div className="domain-table-scroll"><table className="domain-table ds-events"><thead><tr><th>UTC</th><th>Replica</th><th>Applied index</th><th>Observation</th><th>State</th></tr></thead><tbody>{distributedEvents(data).map(event => <tr key={event.id} data-selected={selectedReplica === event.replicaId}><td>{distributedUtc(event.timestamp, true)}</td><td><button onClick={() => onSelect(event.replicaId)}>{event.replicaId}</button></td><td className="is-number">{formatIndex(event.index)}</td><td className="ds-event-message">{event.message}</td><td><span className="ds-status" data-state={event.state}>{event.state}</span></td></tr>)}</tbody></table></div>;
}

export function DistributedSystemsLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [scenario, setScenario] = useState<DistributedScenario>('degraded'), [shardId, setShardId] = useState('042'), [selectedReplica, setSelectedReplica] = useState('eu-2');
  const [timestamp, setTimestamp] = useState<number | undefined>(), [depth, setDepth] = useState<Depth>('shard'), [tab, setTab] = useState<DetailTab>('overview');
  const tabId = useId().replaceAll(':', ''), breadcrumb = useRef<HTMLElement>(null), previousDepth = useRef(depth);
  useEffect(() => { if (previousDepth.current !== depth) { previousDepth.current = depth; breadcrumb.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true }); } }, [depth]);
  const fleet = useMemo(() => distributedFleet(scenario), [scenario]), extra = useMemo(() => distributedFixtures(shardId, scenario), [shardId, scenario]);
  const data = fleet.find(item => item.shardId === shardId) ?? extra, node = data.snapshot.find(n => n.replicaId === selectedReplica), quorum = data.quorum;
  const leader = data.snapshot.find(n => n.role === 'leader'), histories = data.samples.filter(p => p.replicaId === selectedReplica), peerRows = data.peers.filter(p => p.fromReplica === selectedReplica);
  const selection = { selectedReplica }, scopeStart = data.samples[0]?.timestamp, ownership = data.ownership.find(p => p.shardId === shardId);
  const openShard = (id: string, navigate = true) => { setShardId(id); setSelectedReplica(''); setTimestamp(undefined); setTab('overview'); if (navigate || depth === 'replica') setDepth('shard'); };
  const openReplica = (id: string) => { setSelectedReplica(id); setDepth('replica'); setTab('overview'); };
  const context = (value: DrilldownContext) => {
    const labels = value.labels ?? {};
    if (labels.shardId && labels.shardId !== shardId) openShard(labels.shardId, labels.action === 'open-shard');
    if (labels.replicaId !== undefined) { setSelectedReplica(labels.replicaId); if (labels.timestamp) setTimestamp(Number(labels.timestamp)); }
    if (labels.action === 'open-replica') { setDepth('replica'); setTab('overview'); }
    else if (labels.action === 'open-shard') setDepth('shard');
  };
  const showCluster = () => { setDepth('cluster'); setTimestamp(undefined); };
  const chooseReplica = (id: string) => { setSelectedReplica(id); setTimestamp(undefined); if (!id && depth === 'replica') setDepth('shard'); };
  return <main className="domain-lens distributed-lens" data-domain-lens="distributed-systems" data-depth={depth}>
    <DomainHeader title="Distributed Systems" eyebrow="PAPRIKA / CONSENSUS & REPLICATION">
      <span><Layers3 size={14}/>ledger-prod</span>
      <label>Shard<select aria-label="Distributed shard" value={shardId} onChange={event => openShard(event.target.value)}>{data.ownership.map(path => <option key={path.id} value={path.shardId}>{path.shardId}</option>)}</select></label>
      <label>Scenario<select aria-label="Distributed scenario" value={scenario} onChange={event => { setScenario(event.target.value as DistributedScenario); setTimestamp(undefined); }}><option value="degraded">Lagging follower</option><option value="partition">Quorum loss</option><option value="gaps">Telemetry gap</option></select></label>
      <span><Clock3 size={14}/>{scopeStart ? distributedUtc(scopeStart) : '—'}–{distributedUtc(DISTRIBUTED_END)} UTC</span>
    </DomainHeader>
    <nav ref={breadcrumb} className="ds-breadcrumb" aria-label="Distributed investigation breadcrumb">
      <button onClick={showCluster} aria-current={depth === 'cluster' ? 'page' : undefined}>Clusters / ledger-prod</button>
      {depth !== 'cluster' && <><span>/</span><button onClick={() => setDepth('shard')} aria-current={depth === 'shard' ? 'page' : undefined}>shard-{shardId}</button></>}
      {depth === 'replica' && <><span>/</span><span aria-current="page" tabIndex={-1}>replica {selectedReplica}</span></>}
      <span className="ds-breadcrumb-scope">Observed fixture · 15s cadence · scenario affects shard 042</span>
      {depth !== 'cluster' && <button className="ds-back" onClick={() => depth === 'replica' ? setDepth('shard') : showCluster()}><ArrowLeft size={13}/>{depth === 'replica' ? 'Back to shard' : 'Back to cluster'}</button>}
    </nav>
    {depth === 'cluster' ? <>
      <MetricStrip items={[
        { label: 'Ownership cohort', value: 64, detail: 'Exclusive owner at each checkpoint' },
        { label: 'Focus shards', value: fleet.length, detail: '042, 043 and 044 · other shards can be opened' },
        { label: 'Majority reachable', value: `${fleet.filter(item => item.quorum.status === 'reachable').length} / ${fleet.length}`, detail: 'Focus shards; not a fleet-wide availability SLO', tone: 'green' },
        { label: 'Unknown voters', value: fleet.reduce((sum, item) => sum + item.quorum.unknown, 0), detail: 'Across the three focus shards', tone: 'amber' },
      ]}/>
      <Panel title="Shard overview" className="domain-panel ds-inventory" subtitle="Open a shard to inspect quorum, exact log progress and directed peer evidence.">
        <div className="domain-table-scroll"><table className="domain-table"><thead><tr><th>Shard</th><th>Leader</th><th>Term</th><th>Reachable voters</th><th>Required</th><th>Caught up to commit</th><th>Quorum</th><th>Investigation</th></tr></thead><tbody>{fleet.map(item => <tr key={item.shardId} data-selected={item.shardId === shardId}><td>shard-{item.shardId}</td><td>{item.leaderId}</td><td>{item.snapshot.find(n => n.role === 'leader')?.term ?? 'Unknown'}</td><td>{item.quorum.reachable} / {item.quorum.voters}</td><td>{item.quorum.required}</td><td>{item.quorum.caughtUp} / {item.snapshot.length}</td><td><span className="ds-status" data-state={item.quorum.status}>{item.quorum.status}</span></td><td><button onClick={() => openShard(item.shardId)}>Open shard {item.shardId}<ArrowUpRight size={12}/></button></td></tr>)}</tbody></table></div>
      </Panel>
      <div className="ds-lens-grid ds-overview-grid"><DomainChartPanel panel={data.movement} onEdit={onEdit} selection={{ selectedShard: shardId }} onContextChange={context}/><Panel title={`Selected shard ${shardId}`} className="domain-panel" subtitle="Ownership selection highlights a shard; opening it is a separate navigation action."><DetailValues items={[
        ['Leader', data.leaderId], ['Voting members', quorum.voters], ['Required majority', quorum.required], ['Known reachable', quorum.reachable], ['Latest owner', ownership ? ownerAt(ownership, 2) : 'Unknown'], ['Leader commit', formatIndex(leader?.commit)],
      ]}/><button className="ds-open-primary" onClick={() => setDepth('shard')}>Open shard {shardId}<ArrowUpRight size={14}/></button><EventEvidence data={data} selectedReplica="" onSelect={id => { setDepth('shard'); chooseReplica(id); }}/></Panel></div>
    </> : <>
      <MetricStrip items={[
        { label: 'Leader', value: data.leaderId, detail: `Shard ${shardId} · term ${leader?.term ?? 'unknown'}` },
        { label: 'Voting replicas', value: quorum.voters, detail: `${quorum.required} required for majority` },
        { label: 'Reachable voters', value: `${quorum.reachable} / ${quorum.voters}`, detail: quorum.status === 'reachable' ? 'Majority reachable' : quorum.status === 'unavailable' ? 'Majority unavailable' : 'Insufficient current observations', tone: quorum.status === 'reachable' ? 'green' : 'red' },
        { label: 'Selected apply backlog', value: node && applyBacklog(node) !== null ? `${formatIndex(applyBacklog(node))} ent` : 'Unknown', detail: node ? `${node.replicaId} · local commit minus applied` : 'Select a replica', tone: 'amber' },
        { label: 'Behind leader commit', value: node && commitLag(node) !== null ? `${formatIndex(commitLag(node))} ent` : 'Unknown', detail: node ? 'Entries · not a latency measurement' : 'Select a replica', tone: 'violet' },
      ]}/>
      <div className="ds-lens-grid"><DomainChartPanel panel={data.topology} onEdit={onEdit} selection={selection} onContextChange={context}/><DomainChartPanel panel={data.latency} onEdit={onEdit} selection={selection} onContextChange={context}/></div>
      <div className="ds-lens-grid ds-progress-row"><DomainChartPanel panel={data.progress} onEdit={onEdit} selection={{ ...selection, ...(timestamp === undefined ? {} : { selectedTimestamp: timestamp }) }} onContextChange={context}/>
        <Panel title={node ? `Replica ${node.replicaId}` : 'Replica evidence'} className="domain-panel ds-replica-detail" subtitle={node ? `${node.region} · ${replicaState(node)} · selected across all panels` : 'Select a topology node, peer cell or replication row.'} actions={node && depth !== 'replica' ? <button className="domain-edit" onClick={() => openReplica(node.replicaId)}>Open detail<ArrowUpRight size={12}/></button> : undefined}>
          {node ? <>
            <div className="ds-detail-tabs" role="tablist" aria-label="Replica evidence view" onKeyDown={event => { const tabs: DetailTab[] = ['overview', 'log', 'network']; if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setTab(next); document.getElementById(`${tabId}-tab-${next}`)?.focus(); }}>{(['overview', 'log', 'network'] as const).map(value => <button key={value} id={`${tabId}-tab-${value}`} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`${tabId}-panel-${value}`} onClick={() => setTab(value)}>{value === 'overview' ? 'Overview' : value === 'log' ? 'Log / apply' : 'Network'}</button>)}</div>
            <div role="tabpanel" id={`${tabId}-panel-${tab}`} aria-labelledby={`${tabId}-tab-${tab}`}>
              {tab === 'overview' ? <><ReplicaValues row={node}/><div className="ds-replica-summary"><strong data-state={replicaState(node)}>{replicaState(node)}</strong><p>{node.reachable !== true ? `No current log values. Last observation: ${node.observedAt ? distributedUtc(node.observedAt, true) + ' UTC' : 'unknown'}.` : commitLag(node) === 0 ? 'This replica has applied all entries in the supplied leader commit index.' : `${formatIndex(applyBacklog(node))} committed local entries await apply; ${formatIndex(commitLag(node))} entries separate this replica from the leader commit.`}</p></div></> : tab === 'log' ? <>
                <p className="domain-note">Last eight supplied observations · no values carried across missing telemetry.</p>
                <div className="domain-table-scroll"><table className="domain-table"><thead><tr><th>UTC</th><th>Received</th><th>Committed</th><th>Applied</th><th>Queue</th></tr></thead><tbody>{histories.slice(-8).map(sample => <tr key={sample.id} data-selected={sample.timestamp === timestamp}><td><button onClick={() => setTimestamp(sample.timestamp)}>{distributedUtc(sample.timestamp, true)}</button></td><td>{formatIndex(sample.received)}</td><td>{formatIndex(sample.commit)}</td><td>{formatIndex(sample.applied)}</td><td>{formatIndex(applyBacklog(sample))}</td></tr>)}</tbody></table></div>
              </> : <>
                <p className="domain-note">Directed observations originating at {node.replicaId} · {distributedUtc(DISTRIBUTED_END, true)} UTC.</p>
                <div className="domain-table-scroll"><table className="domain-table"><thead><tr><th>To</th><th>RTT · ms</th><th>Transfer · MB/s</th><th>State</th></tr></thead><tbody>{peerRows.map(peer => <tr key={peer.id}><td><button onClick={() => chooseReplica(peer.toReplica)}>{peer.toReplica}</button></td><td className="is-number">{peer.rtt === null ? 'Unknown' : peer.rtt}</td><td className="is-number">{peer.throughput === null ? 'Unknown' : peer.throughput.toFixed(1)}</td><td>{peer.status}</td></tr>)}</tbody></table></div>
              </>}
            </div>
            <div className="ds-replica-switch"><label>Replica<select aria-label="Selected replica" value={selectedReplica} onChange={event => chooseReplica(event.target.value)}>{data.snapshot.map(member => <option key={member.replicaId} value={member.replicaId}>{member.replicaId} · {member.role}</option>)}</select></label><button onClick={() => chooseReplica('')}>Clear selection</button></div>
          </> : <div className="ds-replica-choices">{data.snapshot.map(member => <button key={member.replicaId} onClick={() => chooseReplica(member.replicaId)}>{member.replicaId} · {replicaState(member)}</button>)}</div>}
        </Panel>
      </div>
      {depth === 'replica' && node && <Panel title={`Replica ${node.replicaId} — exact investigation`} className="domain-panel ds-deep-evidence" subtitle="Scoped navigation preserves shard, scenario, source interval and selected observation. Back returns to the shard overview."><DetailValues items={[
        ['Shard', `ledger-prod / ${shardId}`], ['Replica', `${node.replicaId} · ${node.address}`], ['Source interval', `${distributedUtc(data.samples[0].timestamp)}–${distributedUtc(DISTRIBUTED_END)} UTC`], ['Selected observation', timestamp === undefined ? 'Latest snapshot' : `${distributedUtc(timestamp, true)} UTC`],
      ]}/><EventEvidence data={data} selectedReplica={selectedReplica} onSelect={chooseReplica}/></Panel>}
      <div className="ds-lens-grid ds-bottom-row"><DomainChartPanel panel={data.movement} onEdit={onEdit} selection={{ selectedShard: shardId }} onContextChange={context}/><Panel title="Consistency evidence" className="domain-panel" subtitle="Supplied fixture events are investigation context; a healthy reachability count is not a proof of log commitment."><EventEvidence data={data} selectedReplica={selectedReplica} onSelect={chooseReplica}/></Panel></div>
    </>}
    <footer className="ds-lens-footer"><span>Deterministic synthetic telemetry · stable voting membership · no live cluster or consensus simulation</span><span>Log indices are entries · peer RTT is milliseconds · zoom changes only the replication plot window</span></footer>
  </main>;
}

export default DistributedSystemsLens;

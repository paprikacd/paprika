import { useId, useMemo, useRef } from 'react';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { commitLag, distributedUtc, formatIndex, quorumSummary, quorumTopologyConfig, replicaSamples, replicaSnapshots, replicaState } from './model';
import { DistributedEmpty, ReplicaDrillAction, ReplicaValues, Swatch, replicaColor, useReplicaSelection } from './shared';
import './distributed.css';

export function DistributedQuorumTopology(props: WidgetRendererProps) {
  const { widget, result, embedded } = props;
  const cfg = useMemo(() => quorumTopologyConfig.parse(widget.config ?? {}), [widget.config]);
  const samples = useMemo(() => replicaSamples(result.records), [result]), nodes = useMemo(() => replicaSnapshots(samples), [samples]);
  const selection = useReplicaSelection(props, cfg.selectedReplica), interactive = !embedded, inspect = interactive && widget.options?.showTooltip !== false;
  const inspection = useInspection(nodes, result, inspect, selection.selected, row => row.replicaId);
  const ref = useRef<HTMLDivElement>(null), measured = usePlotWidth(ref, 650);
  const uid = useId().replaceAll(':', ''), regions = [...new Set(nodes.map(n => n.region))], width = Math.max(550, measured, regions.length * 150 + 28), height = Math.max(300, ...regions.map(region => nodes.filter(n => n.region === region).length * 100 + 50));
  const lane = (width - 28) / Math.max(1, regions.length), leader = nodes.find(n => n.role === 'leader');
  const positions = new Map(nodes.map(node => { const members = nodes.filter(n => n.region === node.region), i = members.findIndex(n => n.replicaId === node.replicaId); return [node.replicaId, { x: 14 + lane * (regions.indexOf(node.region) + .5), y: members.length === 1 ? height / 2 + 5 : 80 + i * (height - 163) / (members.length - 1) }]; }));
  const quorum = quorumSummary(nodes), inspected = inspection.item;
  const choose = (id: string, target?: SVGElement) => {
    if (!interactive) return;
    const node = nodes.find(n => n.id === id)!;
    if (inspect) inspection.select(id, target);
    selection.choose(node.replicaId, node.shardId, node.timestamp);
  };
  if (!nodes.length) return <DistributedEmpty/>;
  return <div className="ds-chart" onKeyDown={inspection.onKeyDown} onPointerLeave={() => inspection.setHover(null)} data-distributed-topology>
    {widget.options?.showLegend !== false && <div className="domain-legend"><Swatch color={C.cyan}>Leader</Swatch><Swatch color={C.blue}>Follower</Swatch><Swatch color={C.amber}>Lagging</Swatch><Swatch color={C.muted}>Unavailable / unknown</Swatch></div>}
    <div className="ds-topology-layout" data-embedded={!!embedded}>
      <div ref={ref} className="ds-plot-scroll" role="region" aria-label="Replica topology; scroll horizontally on narrow panels" tabIndex={interactive ? 0 : undefined}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Shard ${nodes[0].shardId} replication topology. ${quorum.reachable} of ${quorum.voters} voters reachable; ${quorum.required} required.`}>
          <defs><marker id={`${uid}-arrow`} viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L7,3.5L0,7Z" fill={C.muted}/></marker></defs>
          {regions.map((region, i) => <g key={region}>
            {cfg.showRegions && <><rect x={14 + i * lane} y="35" width={lane - 12} height={height - 50} rx="3" className="ds-region"/><text x={22 + i * lane} y="20" className="ds-axis">{region.length > 16 ? `${region.slice(0, 14)}…` : region} · {nodes.filter(n => n.region === region).length}<title>{region}</title></text></>}
          </g>)}
          {leader && nodes.filter(n => n.replicaId !== leader.replicaId).map(node => {
            const a = positions.get(leader.replicaId)!, b = positions.get(node.replicaId)!, horizontal = Math.abs(b.x - a.x) > 15;
            const signX = Math.sign(b.x - a.x), signY = Math.sign(b.y - a.y);
            const x1 = a.x + (horizontal ? 61 * signX : 0), y1 = a.y + (horizontal ? 0 : signY > 0 ? 42 : -32), x2 = b.x - (horizontal ? 63 * signX : 0), y2 = b.y - (horizontal ? 0 : signY > 0 ? 34 : -44);
            const color = replicaColor(node), lag = commitLag(node), mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            return <g key={node.replicaId} pointerEvents="none"><path d={`M${x1},${y1}L${x2},${y2}`} fill="none" stroke={color} strokeWidth={node.replicaId === selection.selected ? 1.8 : 1.2} strokeDasharray={node.reachable === true ? undefined : '5 5'} markerEnd={`url(#${uid}-arrow)`}/>{cfg.showIndices && <g><rect x={mx - 24} y={my - 16} width="48" height="17" rx="2" fill="var(--gamma-bg)"/><text x={mx} y={my - 4} textAnchor="middle" className="ds-axis" style={{ fill: color }}>{lag === null ? '?' : `${lag} ent`}</text></g>}</g>;
          })}
          {nodes.map(node => {
            const p = positions.get(node.replicaId)!, color = replicaColor(node), selected = selection.selected === node.replicaId, active = inspected?.id === node.id;
            return <g key={node.id} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} aria-label={`Inspect replica ${node.replicaId}, ${node.role}, ${replicaState(node)}, applied index ${formatIndex(node.applied)}`} aria-pressed={interactive ? selected : undefined} onPointerEnter={() => inspection.setHover(node.id)} onFocus={() => inspection.setHover(node.id)} onBlur={() => inspection.setHover(null)} onClick={event => choose(node.id, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(node.id, event.currentTarget); } }}>
              <rect x={p.x - 60} y={p.y - 31} width="120" height="72" rx="5" fill="var(--gamma-bg)" stroke={selected || active ? C.cyan : color} strokeWidth={selected || active ? 1.8 : 1} strokeDasharray={node.reachable === true ? undefined : '4 4'}/>
              <circle cx={p.x - 40} cy={p.y - 6} r="11" fill={`color-mix(in srgb, ${color} 16%, var(--gamma-surface))`} stroke={color} strokeWidth="1.4"/>
              {node.role === 'leader' && <path d={`M${p.x - 46},${p.y - 9}l3,5l3,-7l3,7l3,-5l-1,10h-10Z`} fill="none" stroke={color} strokeWidth="1.1"/>}
              <text x={p.x - 22} y={p.y - 10} className="ds-value">{node.replicaId}</text>
              {cfg.showAddresses && <text x={p.x - 22} y={p.y + 7} className="ds-address">{node.address}</text>}
              <text x={p.x} y={p.y + 29} textAnchor="middle" className="ds-axis" style={{ fill: color }}>{node.role === 'leader' ? 'Leader' : replicaState(node)}</text>
            </g>;
          })}
        </svg>
      </div>
      {!embedded && <aside className="ds-topology-evidence">
        {inspect && inspected ? <DomainInspector title={`Replica ${inspected.replicaId}`} onClose={inspection.dismiss} pinned={!!inspection.pinned}><ReplicaValues row={inspected}/>{inspection.pinned && <ReplicaDrillAction row={inspected} onOpen={() => selection.choose(inspected.replicaId, inspected.shardId, inspected.timestamp, 'open-replica')}/>}</DomainInspector> : <div className="ds-quorum-summary" data-state={quorum.status}>
          <strong>{quorum.status === 'reachable' ? 'Majority reachable' : quorum.status === 'unavailable' ? 'Majority unavailable' : 'Quorum unknown'}</strong>
          <p>{quorum.reachable} of {quorum.voters} voters reachable. A majority requires {quorum.required}.</p>
          <DetailValues items={[
            ['Leader', leader?.replicaId ?? 'Unknown'], ['Term', formatIndex(leader?.term)], ['Reachable voters', `${quorum.reachable} / ${quorum.voters}`], ['Unavailable / unknown', `${quorum.unavailable} / ${quorum.unknown}`], ['Caught up to commit', `${quorum.caughtUp} / ${nodes.length}`], ['Snapshot', `${distributedUtc(nodes[0].timestamp, true)} UTC`],
          ]}/>
          <p>Reachability and commitment are separate evidence. Select a member for exact indices.</p>
        </div>}
      </aside>}
    </div>
    <p className="domain-note">{cfg.showIndices ? 'Edge labels: entries between follower applied index and supplied leader commit. ' : ''}Dashed members retain last-seen metadata; current indices stay unknown.</p>
  </div>;
}

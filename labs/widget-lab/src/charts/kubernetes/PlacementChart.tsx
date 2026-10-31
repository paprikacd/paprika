import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap } from 'd3-hierarchy';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { fleetRows, fleetSelectionAction, fleetSelectionId, nodeFor, placementConfig, resourceSummary, type FleetEntity } from './model';
import './kubernetes.css';

export const fleetNumber = (n: number | null, digits = 2) => n === null ? 'Unavailable' : n.toLocaleString('en-US', { maximumFractionDigits: digits });
export const fleetTime = (n: number) => new Date(n).toISOString().slice(11, 16);
export const namespaceColor = (namespace: string | null) => ({ payments: C.cyan, risk: C.violet, cache: C.mint, ingress: C.blue })[namespace ?? ''] ?? C.muted;
interface Tile { id: string; value?: number; children?: Tile[] }
function tiles(items: { id: string; value: number }[], width: number, height: number, gap: number) {
  const root = hierarchy<Tile>({ id: 'root', children: items }).sum(d => d.value ?? 0);
  return treemap<Tile>().size([Math.max(1, width), Math.max(1, height)]).paddingInner(gap).round(false)(root).leaves();
}

export function KubernetesPlacement({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const cfg = placementConfig.parse(widget.config ?? {}), entities = useMemo(() => fleetRows(result.records), [result]);
  const [localChoice, setLocalChoice] = useState<{ source: typeof result; request: string; id: string } | null>(null);
  const selectionId = fleetSelectionId(entities, cfg.selectedId, localChoice?.source === result && localChoice.request === cfg.selectedId ? localChoice.id : null, cfg.selectionOwner === 'host');
  useEffect(() => setLocalChoice(null), [result, cfg.selectedId, cfg.selectionOwner]);
  const nodes = entities.filter(e => e.kind === 'node'), pods = entities.filter(e => e.kind === 'pod' && e.nodeId !== null);
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 740), columns = width >= 520 ? 3 : width >= 370 ? 2 : 1;
  const zones = [...new Set(nodes.map(n => n.zone!))].sort(), gap = 9, zoneWidth = (width - gap * (columns - 1)) / columns, zoneHeight = 344, height = Math.ceil(zones.length / columns) * (zoneHeight + gap) - gap;
  const enabled = !embedded && widget.options?.showTooltip !== false, inspect = useInspection(entities, result, enabled, selectionId);
  const selectedNode = nodeFor(entities, selectionId), active = inspect.item, uid = `fleet-${useId().replaceAll(':', '')}`;
  const summaries = useMemo(() => new Map(entities.filter(e => e.kind !== 'container').map(entity => [entity.id, resourceSummary(entities, entity.id)])), [entities]);
  const capacityOf = (node: FleetEntity) => cfg.resource === 'cpu' ? node.cpuAllocatable! : node.memoryAllocatable!;
  const zoneCapacity = new Map(zones.map(zone => [zone, nodes.filter(node => node.zone === zone).reduce((n, node) => n + capacityOf(node), 0)]));
  const maxZoneCapacity = Math.max(1, ...zoneCapacity.values());
  function choose(id: string, target?: HTMLElement | SVGElement) {
    if (!enabled) return;
    const action = fleetSelectionAction(entities, id, cfg.selectionOwner); if (!action) return;
    setLocalChoice(action.localId === null ? null : { source: result, request: cfg.selectedId, id: action.localId });
    if (id) inspect.select(id, target); else inspect.dismiss();
    onContextChange?.(action.context);
  }
  const events = (entity: FleetEntity, keyboard: boolean) => ({ role: enabled ? 'button' as const : undefined, tabIndex: enabled && keyboard ? 0 : undefined, 'aria-label': `Inspect ${entity.kind} ${entity.name}`, 'aria-pressed': enabled ? selectionId === entity.id : undefined,
    onPointerEnter: () => { if (!inspect.pinned) inspect.setHover(entity.id); }, onPointerLeave: () => { if (!inspect.pinned) inspect.setHover(null); },
    onFocus: () => { if (!inspect.pinned) inspect.setHover(entity.id); }, onBlur: () => { if (!inspect.pinned) inspect.setHover(null); },
    onClick: (event: React.MouseEvent<SVGElement>) => { event.stopPropagation(); choose(entity.id, event.currentTarget); },
    onKeyDown: (event: React.KeyboardEvent<SVGElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(entity.id, event.currentTarget); } },
  });
  if (!nodes.length) return <div className="domain-empty">No cluster placement observations</div>;
  return <div ref={host} className="kube-chart kube-placement" onKeyDown={inspect.onKeyDown}>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={widget.title}>
      <defs><pattern id={`${uid}-unknown`} width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="var(--gamma-bg)"/><path d="M0 5 5 0" stroke={C.muted} strokeWidth="1"/></pattern></defs>
      {zones.map((zone, zi) => {
        const left = zi % columns * (zoneWidth + gap), top = Math.floor(zi / columns) * (zoneHeight + gap), group = nodes.filter(n => n.zone === zone);
        const usableHeight = (zoneHeight - 34) * (zoneCapacity.get(zone)! / maxZoneCapacity);
        const nodeTiles = tiles(group.map(node => ({ id: node.id, value: capacityOf(node) })), zoneWidth - 12, usableHeight, 5);
        return <g key={zone} transform={`translate(${left} ${top})`}><rect width={zoneWidth} height={usableHeight + 34} rx="3" fill="none" className="kube-grid"/><text x="7" y="18" className="kube-emphasis">{zone}</text><text x={zoneWidth - 7} y="18" textAnchor="end">{group.length} nodes</text>
          <g transform="translate(6 27)">{nodeTiles.map(tile => {
            const node = group.find(n => n.id === tile.data.id)!, summary = summaries.get(node.id)!, capacity = cfg.resource === 'cpu' ? node.cpuAllocatable! : node.memoryAllocatable!, request = cfg.resource === 'cpu' ? summary.cpuRequested : summary.memoryRequested;
            const nw = tile.x1 - tile.x0, nh = tile.y1 - tile.y0, available = node.status === 'Ready', pressure = request / capacity >= cfg.pressure, selected = selectedNode === node.id;
            const children = pods.filter(p => p.nodeId === node.id), childValues = children.map(p => { const s = summaries.get(p.id)!; return { id: p.id, value: cfg.resource === 'cpu' ? s.cpuRequested : s.memoryRequested }; });
            const slack = Math.max(0, capacity - request), inner = tiles([...childValues, { id: '__unrequested', value: slack }], nw - 6, nh - 22, 1.3);
            return <g key={node.id} transform={`translate(${tile.x0} ${tile.y0})`} data-kube-node={node.id}>
              <rect width={nw} height={nh} fill={available ? 'var(--gamma-surface)' : `url(#${uid}-unknown)`} stroke={selected ? C.cyan : pressure ? C.amber : 'var(--gamma-border)'} strokeWidth={selected || pressure ? 2 : 1} {...events(node, true)}/>
              {available && cfg.showPods && <g transform="translate(3 3)">{inner.map(cell => { const pod = children.find(p => p.id === cell.data.id), cw = cell.x1 - cell.x0, ch = cell.y1 - cell.y0; if (cw <= 0 || ch <= 0) return null;
                return pod ? <rect key={pod.id} x={cell.x0} y={cell.y0} width={cw} height={ch} fill={namespaceColor(pod.namespace)} fillOpacity={selectionId === pod.id ? .92 : .46} stroke={selectionId === pod.id || active?.id === pod.id ? C.orange : namespaceColor(pod.namespace)} strokeWidth=".7" {...events(pod, selected)}><title>{pod.name} · {fleetNumber(cell.value ?? 0)} {cfg.resource === 'cpu' ? 'requested cores' : 'requested GiB'}</title></rect> : <rect key="slack" x={cell.x0} y={cell.y0} width={cw} height={ch} fill="var(--gamma-bg)" pointerEvents="none"/>;
              })}</g>}
              <text x="3" y={nh - 5} className={selected ? 'kube-emphasis' : ''} pointerEvents="none">{nw > 100 ? node.name : `N · ${node.name.slice(-2)}`}</text>
            </g>;
          })}</g>
        </g>;
      })}
    </svg>
    {widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.cyan }}/>Selected node</span><span><i style={{ background: C.amber }}/>Requests ≥{Math.round(cfg.pressure * 100)}% allocatable</span><span>Hatch: unavailable · vacant: unrequested by scope</span></div>}
    {!embedded && <div className="kube-controls"><label>Inspect node <select className="domain-control" value={selectedNode} aria-label="Inspect Kubernetes node" disabled={!enabled} onChange={event => choose(event.target.value, event.currentTarget)}><option value="">Cluster overview</option>{nodes.map(n => <option key={n.id} value={n.id}>{n.name} · {n.status}</option>)}</select></label><span className="domain-note">Select a node, then a pod in the detail dock.</span></div>}
    {active && <DomainInspector title={`${active.kind} · ${active.name}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={(() => {
      const s = resourceSummary(entities, active.id); return [['State / namespace', `${active.status} · ${active.namespace ?? 'All scoped namespaces'}`], ['CPU request / observed', `${fleetNumber(s.cpuRequested)} / ${fleetNumber(s.cpuUsed.value)} cores`], ['Memory request / observed', `${fleetNumber(s.memoryRequested)} / ${fleetNumber(s.memoryUsed.value)} GiB`], ['Measured containers', `${s.cpuUsed.count} / ${s.expected}`], ['Allocatable CPU / memory', s.cpuAllocatable === null ? 'Capacity belongs to the node' : `${s.cpuAllocatable} cores / ${s.memoryAllocatable} GiB`]];
    })()}/></DomainInspector>}
  </div>;
}

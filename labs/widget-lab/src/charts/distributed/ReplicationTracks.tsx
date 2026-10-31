import { useId, useMemo, useRef, type PointerEvent } from 'react';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../../vendor/paprika/ui/src/features/insights/time-window-controls';
import { CHART_COLORS as C, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { commitLag, distributedUtc, formatIndex, nearestSample, replicaGroups, replicaSamples, replicaSnapshots, replicationTracksConfig, steppedPath, type ReplicaSample } from './model';
import { DistributedEmpty, ReplicaDrillAction, ReplicaValues, Swatch, replicaColor, svgPoint, useReplicaSelection } from './shared';
import './distributed.css';

export function DistributedReplicationTracks(props: WidgetRendererProps) {
  const { widget, result, embedded } = props, cfg = useMemo(() => replicationTracksConfig.parse(widget.config ?? {}), [widget.config]);
  const samples = useMemo(() => replicaSamples(result.records), [result]), groups = useMemo(() => replicaGroups(samples), [samples]), snapshot = useMemo(() => replicaSnapshots(samples), [samples]);
  const selection = useReplicaSelection(props, cfg.selectedReplica), interactive = !embedded, inspect = interactive && widget.options?.showTooltip !== false;
  const inspection = useInspection(samples, result, inspect, selection.selected, sample => sample.replicaId);
  const viewport = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), measured = usePlotWidth(viewport, 900), width = Math.max(620, measured), uid = useId().replaceAll(':', '');
  const extent = samples.length ? { start: Math.min(...samples.map(p => p.timestamp)), end: Math.max(...samples.map(p => p.timestamp)) } : null;
  const windowState = useChartTimeWindow(extent, result, 30000), window = windowState.window;
  const left = 140, right = 89, top = 34, rowHeight = 49, rowsBottom = top + groups.length * rowHeight;
  const lagTop = rowsBottom + 37, lagHeight = 73, height = cfg.showLag ? lagTop + lagHeight + 27 : rowsBottom + 26;
  const plotWidth = Math.max(1, width - left - right), x = (time: number) => left + (time - window.start) / (window.end - window.start) * plotWidth;
  const finiteIndices = samples.flatMap(p => [p.received, p.applied, p.leaderCommit]).filter((v): v is number => v !== null);
  const indexMin = Math.min(...finiteIndices), indexMax = Math.max(...finiteIndices), indexRange = Math.max(1, indexMax - indexMin);
  const indexY = (value: number, row: number) => top + row * rowHeight + 36 - (value - indexMin) / indexRange * 28;
  const maxLag = Math.max(40, ...samples.map(p => commitLag(p) ?? 0)), lagDomain = Math.ceil(maxLag / 50) * 50, lagY = (value: number) => lagTop + lagHeight - value / lagDomain * lagHeight;
  const selectedGroup = groups.find(g => g.id === selection.selected) ?? groups[0];
  const configuredObservation = selectedGroup ? nearestSample(selectedGroup.samples, cfg.selectedTimestamp ?? selectedGroup.samples.at(-1)!.timestamp) : undefined;
  const current = inspection.item, displayed = current ?? configuredObservation;
  const brush = useTimeWindowBrush({ enabled: interactive && windowState.enabled, revision: result, window,
    point: (clientX, clientY) => { if (!svg.current) return null; const p = svgPoint(svg.current, clientX, clientY), fraction = Math.max(0, Math.min(1, (p.x - left) / plotWidth)); return { x: left + fraction * plotWidth, y: p.y, timestamp: window.start + fraction * (window.end - window.start), inPlot: p.x >= left && p.x <= width - right && p.y >= top && p.y <= height - 25 }; },
    commit: windowState.commit, onStart: inspection.dismiss,
  });
  const choose = (sample: ReplicaSample, target?: SVGElement | HTMLElement) => {
    if (!interactive) return;
    if (inspect) inspection.select(sample.id, target);
    selection.choose(sample.replicaId, sample.shardId, sample.timestamp);
  };
  const atPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!inspect || brush.active) return undefined;
    const p = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (p.x < left || p.x > width - right || p.y < top || p.y > height - 25) return undefined;
    const group = p.y < rowsBottom ? groups[Math.floor((p.y - top) / rowHeight)] : selectedGroup;
    return group ? nearestSample(group.samples, window.start + (p.x - left) / plotWidth * (window.end - window.start)) : undefined;
  };
  const tickCount = width < 740 ? 4 : 6, ticks = Array.from({ length: tickCount }, (_, i) => window.start + i * (window.end - window.start) / (tickCount - 1));
  const leader = groups.find(g => g.samples.at(-1)?.role === 'leader'), termChanges = leader?.samples.filter((p, i, all) => i > 0 && p.term !== null && all[i - 1].term !== null && p.term !== all[i - 1].term) ?? [];
  if (!samples.length) return <DistributedEmpty/>;
  return <div className="ds-chart" onKeyDown={inspection.onKeyDown} onPointerLeave={() => inspection.setHover(null)} data-replication-tracks>
    <div className="ds-plot-context"><span>Shared index range {formatIndex(indexMin)}–{formatIndex(indexMax)}</span><span>Right column: current lag to leader commit</span></div>
    <div ref={viewport} className="ds-plot-scroll ds-measured-viewport" role="region" aria-label="Replication tracks; scroll horizontally for exact labels" tabIndex={interactive ? 0 : undefined}>
      <div className="ds-brush-host" style={{ width }} {...brush.handlers}>
        <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" tabIndex={inspect ? 0 : undefined} aria-label="Replication index tracks with common index scale. Drag horizontally to zoom this chart, or use exact UTC controls. Arrow keys inspect observations."
          onPointerMove={event => inspection.setHover(atPointer(event)?.id ?? null)}
          onClick={event => { const sample = atPointer(event as unknown as PointerEvent<SVGSVGElement>); if (sample) choose(sample, event.currentTarget); }}
          onKeyDown={event => {
            if (!inspect || !selectedGroup || event.target !== event.currentTarget) return;
            const currentIndex = Math.max(0, selectedGroup.samples.findIndex(p => p.id === displayed?.id));
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); choose(selectedGroup.samples[Math.max(0, Math.min(selectedGroup.samples.length - 1, currentIndex + (event.key === 'ArrowRight' ? 1 : -1)))], event.currentTarget); }
            else if ((event.key === 'Enter' || event.key === ' ') && displayed) { event.preventDefault(); choose(displayed, event.currentTarget); }
          }}>
          <defs><clipPath id={`${uid}-clip`}><rect x={left} y={top} width={plotWidth} height={height - top - 24}/></clipPath><pattern id={`${uid}-missing`} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(35)"><line x1="0" x2="0" y1="0" y2="5" stroke={C.muted} strokeWidth="1"/></pattern></defs>
          <text x="8" y="17" className="ds-axis">Replica / applied now</text><text x={width - right + 9} y="17" className="ds-axis">Lag · entries</text>
          {ticks.map((time, i) => <g key={time} pointerEvents="none"><line x1={x(time)} x2={x(time)} y1={top} y2={height - 25} className="ds-grid"/><text x={x(time)} y="17" textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="ds-axis">{distributedUtc(time)}</text><text x={x(time)} y={height - 5} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="ds-axis">{distributedUtc(time)}</text></g>)}
          {groups.map((group, row) => {
            const latest = snapshot.find(p => p.replicaId === group.id)!, y = top + row * rowHeight, active = selection.selected === group.id;
            return <g key={group.id}>
              <rect x="1" y={y} width={width - 2} height={rowHeight} fill={active ? `color-mix(in srgb, ${C.cyan} 7%, transparent)` : 'transparent'} stroke={active ? C.cyan : 'var(--gamma-border)'} strokeWidth={active ? 1 : .5} pointerEvents="none"/>
              <g role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} aria-label={`Inspect ${group.id}; current applied ${formatIndex(latest.applied)}; ${commitLag(latest) === null ? 'current lag unknown' : `${commitLag(latest)} entries behind leader commit`}`} onFocus={() => inspection.setHover(latest.id)} onBlur={() => inspection.setHover(null)} onClick={event => { event.stopPropagation(); choose(latest, event.currentTarget); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(latest, event.currentTarget); } }}>
                <rect x="0" y={y} width={left - 5} height={rowHeight} fill="transparent"/>
                <circle cx="11" cy={y + 15} r="4" fill={replicaColor(latest)}/><text x="22" y={y + 19} className="ds-value">{group.id}</text><text x="22" y={y + 36} className="ds-axis">{formatIndex(latest.applied)}</text>
              </g>
              <text x={width - right + 9} y={y + 23} className="ds-axis" style={{ fill: replicaColor(latest) }}>{formatIndex(commitLag(latest))}</text>
              <g clipPath={`url(#${uid}-clip)`} pointerEvents="none">
                {group.samples.filter(p => p.received === null).map(p => <rect key={p.id} x={x(p.timestamp) - 2} y={y + 3} width="4" height={rowHeight - 6} fill={`url(#${uid}-missing)`}/>)}
                {cfg.showReceived && <path d={steppedPath(group.samples.map(p => ({ timestamp: p.timestamp, value: p.received })), x, value => indexY(value, row))} fill="none" stroke={C.cyan} strokeWidth="1.5"/>}
                <path d={steppedPath(group.samples.map(p => ({ timestamp: p.timestamp, value: p.applied })), x, value => indexY(value, row))} fill="none" stroke={C.violet} strokeWidth="1.5"/>
                {cfg.showCommitted && <path d={steppedPath(group.samples.map(p => ({ timestamp: p.timestamp, value: p.leaderCommit })), x, value => indexY(value, row))} fill="none" stroke={C.muted} strokeDasharray="4 3" strokeWidth="1"/>}
              </g>
            </g>;
          })}
          {cfg.showLag && <g>
            <text x="8" y={lagTop - 12} className="ds-axis">Behind leader commit · entries</text>
            {[0, lagDomain / 2, lagDomain].map(value => <g key={value}><line x1={left} x2={width - right} y1={lagY(value)} y2={lagY(value)} className="ds-grid"/><text x={left - 8} y={lagY(value) + 4} textAnchor="end" className="ds-axis">{value}</text></g>)}
            <g clipPath={`url(#${uid}-clip)`} pointerEvents="none">{groups.map(group => <path key={group.id} d={steppedPath(group.samples.map(p => ({ timestamp: p.timestamp, value: commitLag(p) })), x, lagY)} fill="none" stroke={replicaColor(snapshot.find(n => n.replicaId === group.id)!)} strokeWidth={selection.selected === group.id ? 2 : 1.2} opacity={!selection.selected || selection.selected === group.id ? 1 : .5}/>)}</g>
          </g>}
          <g clipPath={`url(#${uid}-clip)`} pointerEvents="none">
            {termChanges.map(p => <g key={p.id}><line x1={x(p.timestamp)} x2={x(p.timestamp)} y1={top} y2={height - 25} stroke={C.red} strokeDasharray="4 4"/><text x={x(p.timestamp) + 5} y={top + 12} className="ds-axis" style={{ fill: C.red }}>Term {p.term}</text></g>)}
            {displayed && <g><line x1={x(displayed.timestamp)} x2={x(displayed.timestamp)} y1={top} y2={height - 25} stroke={C.cyan} strokeDasharray="2 4"/>{displayed.applied !== null && <circle cx={x(displayed.timestamp)} cy={indexY(displayed.applied, groups.findIndex(g => g.id === displayed.replicaId))} r="3.5" fill={C.violet} stroke="var(--gamma-ink)"/>}</g>}
          </g>
          {brush.preview && <rect pointerEvents="none" x={Math.min(brush.preview.x1, brush.preview.x2)} y={top} width={Math.abs(brush.preview.x2 - brush.preview.x1)} height={height - top - 25} fill={C.cyan} fillOpacity=".13" stroke={C.cyan}/>}
        </svg>
      </div>
    </div>
    {!embedded && <TimeWindowControls state={windowState} compact description="This is a local plot window. The snapshot columns and shard quorum retain their full source scope."/>}
    {!embedded && inspect && selectedGroup && <label className="ds-observation-slider">Exact observation<input type="range" min="0" max={selectedGroup.samples.length - 1} step="1" aria-label="Replication observation" value={Math.max(0, selectedGroup.samples.findIndex(p => p.id === displayed?.id))} onChange={event => choose(selectedGroup.samples[Number(event.target.value)], event.currentTarget)}/><span>{displayed ? distributedUtc(displayed.timestamp, true) : '—'} UTC</span></label>}
    {widget.options?.showLegend !== false && <div className="domain-legend">{cfg.showReceived && <Swatch color={C.cyan}>Received</Swatch>}<Swatch color={C.violet}>Applied</Swatch>{cfg.showCommitted && <span>┄ Leader commit</span>}<Swatch color={C.red}>Observed term change</Swatch><span>Hatching: no current observation</span></div>}
    {inspect && current && <DomainInspector title={`${current.replicaId} · ${distributedUtc(current.timestamp, true)} UTC`} onClose={inspection.dismiss} pinned={!!inspection.pinned}>
      <ReplicaValues row={current}/>{inspection.pinned && <ReplicaDrillAction row={current} onOpen={() => selection.choose(current.replicaId, current.shardId, current.timestamp, 'open-replica')}/>}
    </DomainInspector>}
  </div>;
}

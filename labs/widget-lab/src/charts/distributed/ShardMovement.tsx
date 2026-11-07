import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WidgetRendererProps } from '@insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { distributedUtc, ownerAt, ownershipGeometry, ownershipPaths, ownershipTransfers, shardMovementConfig, UNKNOWN_OWNER, type OwnershipPath } from './model';
import { DistributedEmpty, Swatch, ownerColor } from './shared';
import './distributed.css';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import hatchStyles from '@insights/plot-hatch.module.css';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

export function DistributedShardMovement(props: WidgetRendererProps) {
  const { widget, result, embedded, onContextChange } = props, cfg = useMemo(() => shardMovementConfig.parse(widget.config ?? {}), [widget.config]);
  const paths = useMemo(() => ownershipPaths(result.records), [result]);
  const [selected, setSelected] = useState(cfg.selectedShard ?? '');
  useEffect(() => { setSelected(cfg.selectedShard ?? ''); }, [cfg.selectedShard, result]);
  const interactive = !embedded, inspect = interactive && widget.options?.showTooltip !== false;
  const inspection = useInspection(paths, result, inspect, selected, path => path.shardId);
  const viewport = useRef<HTMLDivElement>(null), measured = usePlotWidth(viewport, 650), width = Math.max(480, measured), height = 290;
  const entering = useChartEntrance({ disabled: embedded, anchor: viewport });
  const uid = useId().replaceAll(':', ''), top = 36, bottom = 31, plotHeight = height - top - bottom, barWidth = 26, left = 96, right = 76;
  const xs = [left, (left + width - right) / 2, width - right], geometry = ownershipGeometry(paths, plotHeight);
  const targets = useRef(new Map<string, SVGGElement>());
  const position = (path: OwnershipPath, stage: 0 | 1 | 2) => top + (geometry.stages[stage].find(group => group.owner === ownerAt(path, stage))?.members.find(member => member.id === path.id)?.y ?? 0);
  const choose = (path: OwnershipPath, target?: SVGElement | HTMLElement) => {
    if (!interactive) return;
    if (inspect) inspection.select(path.id, target);
    setSelected(path.shardId); onContextChange?.({ series: path.shardId, labels: { shardId: path.shardId, action: 'select-shard' } });
  };
  const current = inspection.item, selectedPath = paths.find(p => p.shardId === selected);
  const moves = paths.flatMap(ownershipTransfers), unknown = paths.filter(p => [p.owner0, p.owner1, p.owner2].includes(null)).length;
  if (!paths.length) return <DistributedEmpty/>;
  return <div className="ds-chart" onKeyDown={inspection.onKeyDown} data-shard-movement>
    <div className="ds-plot-context"><span>{paths.length} shards · exclusive ownership</span><span>{moves.length} confirmed transfers{unknown ? ` · ${unknown} incomplete paths` : ''}</span></div>
    <div ref={viewport} className="ds-plot-scroll ds-measured-viewport" data-chart-entering={entering || undefined} role="region" aria-label="Ownership flows; scroll horizontally on narrow panels" tabIndex={interactive ? 0 : undefined}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Shard ownership at three exact UTC checkpoints. Width represents shard count. Arrow keys move between shard paths; Enter selects.">
        <PlotHatchDefs id={uid}/>
        {([0, 1, 2] as const).map(stage => <text key={stage} x={xs[stage] + barWidth / 2} y="17" textAnchor="middle" className="ds-axis">{distributedUtc([paths[0].t0, paths[0].t1, paths[0].t2][stage])} UTC</text>)}
        <g className={chartEntrance.revealMarks}>{[...paths].sort((a, b) => Number(a.shardId === selected || a.id === current?.id) - Number(b.shardId === selected || b.id === current?.id)).map(path => {
          const active = path.shardId === selected || path.id === current?.id, stable = path.owner0 === path.owner1 && path.owner1 === path.owner2;
          const color = active ? C.cyan : ownerColor(ownerAt(path, 0));
          return <g key={path.id} className="ds-shard-flow" data-active={active} ref={node => { if (node) targets.current.set(path.id, node); else targets.current.delete(path.id); }} role={interactive ? 'button' : undefined} tabIndex={interactive && (selectedPath?.id === path.id || !selectedPath && path.id === paths[0].id) ? 0 : interactive ? -1 : undefined} aria-label={`Inspect shard ${path.shardId}: ${ownerAt(path, 0)}, then ${ownerAt(path, 1)}, then ${ownerAt(path, 2)}`} aria-pressed={interactive ? path.shardId === selected : undefined} onPointerEnter={() => inspection.setHover(path.id)} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(path.id)} onBlur={() => inspection.setHover(null)} onClick={event => choose(path, event.currentTarget)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(path, event.currentTarget); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = paths.findIndex(p => p.id === path.id), next = paths[Math.max(0, Math.min(paths.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]; targets.current.get(next.id)?.focus(); }
          }}>
            {([0, 1] as const).map(stage => {
              const x1 = xs[stage] + barWidth, x2 = xs[stage + 1], y1 = position(path, stage), y2 = position(path, stage + 1 as 1 | 2), bend = (x2 - x1) * .45;
              const d = `M${x1},${y1}C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}V${y2 + geometry.unit}C${x2 - bend},${y2 + geometry.unit} ${x1 + bend},${y1 + geometry.unit} ${x1},${y1 + geometry.unit}Z`;
              return <g key={stage}><path d={d} fill={ownerAt(path, stage) === UNKNOWN_OWNER || ownerAt(path, stage + 1 as 1 | 2) === UNKNOWN_OWNER ? plotHatchFill(uid) : color} fillOpacity={active ? .9 : !cfg.showStable && stable ? 0 : .25} stroke={active ? C.cyan : 'none'} strokeWidth={active ? .7 : 0}/>{interactive && <path d={`M${x1},${y1 + geometry.unit / 2}C${x1 + bend},${y1 + geometry.unit / 2} ${x2 - bend},${y2 + geometry.unit / 2} ${x2},${y2 + geometry.unit / 2}`} fill="none" stroke="transparent" strokeWidth="5"/>}</g>;
            })}
          </g>;
        })}</g>
        <g className={chartEntrance.revealMarks}>{geometry.stages.map((groups, stage) => groups.map(group => <g key={`${stage}-${group.owner}`} pointerEvents="none">
          <rect x={xs[stage]} y={top + group.y} width={barWidth} height={group.height} fill={group.owner === UNKNOWN_OWNER ? plotHatchFill(uid) : ownerColor(group.owner)} opacity=".8"/>
          {stage === 0 && <text x={xs[stage] - 9} y={top + group.y + Math.max(13, group.height / 2)} textAnchor="end" className="ds-axis">{group.owner}</text>}
          {cfg.showValues && group.height > 0 && <text x={xs[stage] + barWidth + 6} y={top + group.y + Math.max(13, group.height / 2)} className="ds-value">{group.members.length}</text>}
        </g>))}</g>
        {([0, 1, 2] as const).map(stage => <text key={stage} x={xs[stage] + barWidth / 2} y={height - 7} textAnchor="middle" className="ds-axis">Total {paths.length}</text>)}
      </svg>
    </div>
    {!embedded && <div className="ds-movement-controls"><label>Inspect shard<select aria-label="Inspect ownership path" value={selected} onChange={event => { const path = paths.find(p => p.shardId === event.target.value); if (path) choose(path, event.currentTarget); }}><option value="">Choose a shard</option>{paths.map(path => <option key={path.id} value={path.shardId}>Shard {path.shardId}</option>)}</select></label>{selectedPath && <span>{ownerAt(selectedPath, 0)} → {ownerAt(selectedPath, 1)} → {ownerAt(selectedPath, 2)}</span>}</div>}
    {widget.options?.showLegend !== false && <div className="domain-legend"><Swatch color={C.cyan}>Selected shard</Swatch>{geometry.owners.map(owner => <Swatch key={owner} color={ownerColor(owner)}>{owner}</Swatch>)}{!cfg.showStable && <span>Stable ownership paths hidden; totals retain all shards</span>}</div>}
    {inspect && current && <DomainInspector title={`Shard ${current.shardId} ownership`} onClose={inspection.dismiss} pinned={!!inspection.pinned}>
      <DetailValues items={[
        [`${distributedUtc(current.t0)} UTC`, ownerAt(current, 0)], [`${distributedUtc(current.t1)} UTC`, ownerAt(current, 1)], [`${distributedUtc(current.t2)} UTC`, ownerAt(current, 2)],
        ['Confirmed transfers', ownershipTransfers(current).length], ['Coverage', [current.owner0, current.owner1, current.owner2].some(owner => owner === null) ? 'One or more owner observations unknown' : 'All three ownership observations present'],
      ]}/>
      {ownershipTransfers(current).map(move => <p key={move.id} className="domain-note">{move.from} → {move.to} · {distributedUtc(move.start, true)}–{distributedUtc(move.end, true)} UTC · {Math.round((move.end - move.start) / 1000)} seconds</p>)}
      {inspection.pinned && <button className="ds-action" onClick={() => onContextChange?.({ series: current.shardId, labels: { shardId: current.shardId, action: 'open-shard' } })}>Open shard {current.shardId} detail →</button>}
    </DomainInspector>}
  </div>;
}

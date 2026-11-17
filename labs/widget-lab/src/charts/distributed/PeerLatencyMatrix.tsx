import { useMemo, useRef } from 'react';
import type { WidgetRendererProps } from '@insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection } from '../../components/lab/DomainPrimitives';
import { distributedUtc, peerCells, peerLatencyConfig } from './model';
import { DENSITY_GRADIENT, densityStep, DistributedEmpty, ReplicaDrillAction, Swatch, useReplicaSelection } from './shared';
import './distributed.css';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import hatchStyles from '@insights/plot-hatch.module.css';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

export function DistributedPeerLatency(props: WidgetRendererProps) {
  const { widget, result, embedded } = props, cfg = useMemo(() => peerLatencyConfig.parse(widget.config ?? {}), [widget.config]);
  const root = useRef<HTMLDivElement>(null), entering = useChartEntrance({ disabled: embedded, anchor: root });
  const cells = useMemo(() => peerCells(result.records), [result]), ids = [...new Set(cells.flatMap(p => [p.fromReplica, p.toReplica]))];
  const selection = useReplicaSelection(props, cfg.selectedReplica), interactive = !embedded, inspect = interactive && widget.options?.showTooltip !== false;
  const inspection = useInspection(cells, result, inspect, selection.selected, cell => cell.toReplica);
  const max = Math.max(1, ...cells.map(p => p[cfg.metric] ?? 0)), unit = cfg.metric === 'rtt' ? 'ms' : 'MB/s';
  const intensity = (value: number | null) => { const step = densityStep(value, max); return step === null ? undefined : `inset 0 -4px 0 var(--gamma-density-${step})`; };
  const choose = (id: string, target?: HTMLElement) => { if (!interactive) return; const cell = cells.find(p => p.id === id)!; if (inspect) inspection.select(id, target); selection.choose(cell.toReplica, cell.shardId, cell.timestamp); };
  const cell = inspection.item, reverse = cell ? cells.find(p => p.fromReplica === cell.toReplica && p.toReplica === cell.fromReplica) : undefined;
  if (!cells.length) return <DistributedEmpty/>;
  return <div className="ds-chart" ref={root} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown} onPointerLeave={() => inspection.setHover(null)} data-peer-matrix>
    <div className="ds-plot-context"><span>From ↓ / To →</span><span>{distributedUtc(cells[0].timestamp, true)} UTC · {unit}</span></div>
    <div className="domain-table-scroll" role="region" aria-label="Directed peer matrix; scroll to see all replicas" tabIndex={interactive ? 0 : undefined}>
      <table className={`ds-peer-table ${chartEntrance.revealMarks}`}><caption className="ds-sr-only">Directed peer {cfg.metric === 'rtt' ? 'round-trip latency in milliseconds' : 'transfer rate in megabytes per second'}. Diagonal cells are not measured. Unavailable and unknown are separate from zero.</caption>
        <thead><tr><th scope="col">Replica</th>{ids.map(id => <th key={id} scope="col" data-selected={selection.selected === id} data-inspected={cell?.toReplica === id}>{id}</th>)}</tr></thead>
        <tbody>{ids.map(from => <tr key={from}><th scope="row" data-selected={selection.selected === from} data-inspected={cell?.fromReplica === from}>{from}</th>{ids.map(to => {
          if (from === to) return <td key={to} className="ds-peer-self"><span aria-label="Same replica; no peer measurement">—</span></td>;
          const datum = cells.find(p => p.fromReplica === from && p.toReplica === to), value = datum?.[cfg.metric] ?? null;
          const color = cfg.metric === 'rtt' && value !== null && value >= cfg.warnAboveMs ? 'var(--gamma-warning)' : 'var(--gamma-ink)';
          const label = !datum || datum.status === 'unknown' ? 'Unknown' : datum.status === 'unavailable' ? 'Unavailable' : value === null ? 'Unknown' : `${value.toFixed(cfg.metric === 'rtt' ? 0 : 1)} ${unit}`;
          const content = cfg.showValues ? value === null ? datum?.status === 'unavailable' ? '×' : '?' : value.toFixed(cfg.metric === 'rtt' ? 0 : 1) : value === null ? '?' : '·';
          return <td key={to} className={value === null ? hatchStyles.hatch : undefined} data-related={!!cell && (cell.fromReplica === from || cell.toReplica === to)}>{datum ? embedded ? <span className="ds-peer-value" data-missing={value === null} style={{ color, boxShadow: intensity(value) }}>{content}</span> : <button className="ds-peer-value" data-missing={value === null} data-active={cell?.id === datum.id} aria-label={`Inspect ${from} to ${to}: ${label}`} aria-pressed={inspection.pinned === datum.id} style={{ color: value === null ? C.muted : color, boxShadow: intensity(value) }} onPointerEnter={() => inspection.setHover(datum.id)} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(datum.id)} onBlur={() => inspection.setHover(null)} onClick={event => choose(datum.id, event.currentTarget)}>{content}</button> : <span className="ds-peer-value" data-missing="true">?</span>}</td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    {widget.options?.showLegend !== false && <div className="domain-legend"><Swatch color={DENSITY_GRADIENT}>Measured {unit}, shaded by value</Swatch>{cfg.metric === 'rtt' && <Swatch color={C.amber}>≥ {cfg.warnAboveMs} ms</Swatch>}<span>× Unavailable</span><span>? Unknown</span></div>}
    {inspect && cell && <DomainInspector title={`${cell.fromReplica} → ${cell.toReplica}`} onClose={inspection.dismiss} pinned={!!inspection.pinned}>
      <DetailValues items={[
        ['Observation', `${distributedUtc(cell.timestamp, true)} UTC`], ['Reachability', cell.status], ['Round-trip latency', cell.rtt === null ? cell.status === 'unavailable' ? 'Unavailable' : 'Unknown' : `${cell.rtt} ms`], ['Transfer rate', cell.throughput === null ? 'Unknown' : `${cell.throughput.toFixed(1)} MB/s`], ['Reverse observation', reverse?.rtt === null || reverse?.rtt === undefined ? 'Unknown' : `${reverse.rtt} ms`], ['Scope', `Shard ${cell.shardId} · directed pair`],
      ]}/>
      {inspection.pinned && <ReplicaDrillAction row={{ replicaId: cell.toReplica }} onOpen={() => selection.choose(cell.toReplica, cell.shardId, cell.timestamp, 'open-replica')}/>}
    </DomainInspector>}
  </div>;
}

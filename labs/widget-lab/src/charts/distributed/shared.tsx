import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { CHART_COLORS as C, DetailValues } from '../../components/lab/DomainPrimitives';
import { applyBacklog, commitLag, distributedUtc, formatIndex, replicaState, type ReplicaSample, type ReplicaSnapshot } from './model';

export const replicaColor = (row: ReplicaSample) => row.reachable !== true ? C.muted : row.role === 'leader' ? C.cyan : replicaState(row) === 'Lagging' ? C.amber : C.blue;
export const ownerColor = (owner: string) => ({ 'us-east': C.blue, 'eu-west': C.violet, 'ap-southeast': C.mint }[owner] ?? C.muted);
export function DistributedEmpty() { return <div className="domain-empty">No distributed-system observations in this result.</div>; }
export function Swatch({ color, children }: { color: string; children: ReactNode }) { return <span><i style={{ background: color }}/>{children}</span>; }
export function useReplicaSelection(props: WidgetRendererProps, configured?: string) {
  const [selected, setSelected] = useState(configured ?? '');
  useEffect(() => { setSelected(configured ?? ''); }, [configured, props.result]);
  const choose = (replicaId: string, shardId: string, timestamp?: number, action?: string) => {
    setSelected(replicaId);
    props.onContextChange?.({ series: replicaId, labels: { replicaId, shardId, ...(timestamp === undefined ? {} : { timestamp: String(timestamp) }), ...(action ? { action } : {}) } });
  };
  return { selected, choose };
}
export function ReplicaValues({ row }: { row: ReplicaSample | ReplicaSnapshot }) {
  const lastKnown = 'lastKnown' in row ? row.lastKnown : undefined;
  return <DetailValues items={[
    ['State', replicaState(row)], ['Role / term', `${row.role} / ${row.term ?? 'Unknown'}`],
    ['Region / address', <>{row.region}<br/>{row.address}</>], ['Observed at', row.observedAt === null ? 'Unknown' : `${distributedUtc(row.observedAt, true)} UTC`],
    ['Received index', formatIndex(row.received)], ['Local commit', formatIndex(row.commit)],
    ['Applied index', formatIndex(row.applied)], ['Apply backlog', `${formatIndex(applyBacklog(row))}${applyBacklog(row) === null ? '' : ' entries'}`],
    ['Behind leader commit', `${formatIndex(commitLag(row))}${commitLag(row) === null ? '' : ' entries'}`], ['Leader commit', formatIndex(row.leaderCommit)],
    ...(row.received === null && lastKnown ? [['Last known applied', `${formatIndex(lastKnown.applied)} at ${distributedUtc(lastKnown.timestamp, true)} UTC`] as [string, ReactNode]] : []),
  ]}/>;
}
export function ReplicaDrillAction({ row, onOpen }: { row: Pick<ReplicaSample, 'replicaId'>; onOpen: () => void }) {
  return <button className="ds-action" onClick={onOpen}>Open {row.replicaId} detail<ArrowUpRight size={13}/></button>;
}
export function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const matrix = svg.getScreenCTM();
  return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
}
/** The 24-step density ramp step for a value against the family maximum. Zero, unknown and non-positive values take no step, so the caller draws the empty fill. */
export function densityStep(value: number | null, max: number): number | null {
  if (value === null || value <= 0 || max <= 0) return null;
  return Math.min(23, Math.max(0, Math.round(Math.min(1, value / max) * 23)));
}
/** Gamma's 24-step density ramp as a left-to-right gradient (legend keys). */
export const DENSITY_GRADIENT = `linear-gradient(90deg,${Array.from({ length: 24 }, (_, i) => `var(--gamma-density-${i})`).join(',')})`;

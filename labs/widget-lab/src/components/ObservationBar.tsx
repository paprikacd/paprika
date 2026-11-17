import { Pin, MousePointer2 } from 'lucide-react';
import { useChartCursor } from '@insights/chart-cursor';
import type { AggregatePoint } from '../data/telemetry';
import { clockTime, latency, rate, percentage } from '../format';

export function ObservationBar({ timeline }: { timeline: readonly AggregatePoint[] }) {
  const cursor = useChartCursor();
  const observed = cursor ? timeline.find(point => point.timestampMs === cursor.timestamp) : undefined;
  return <div className="observation-bar" data-observation={observed ? 'selected' : 'none'}>
    <span className="observation-label">{cursor?.pinned ? <Pin size={14} /> : <MousePointer2 size={14} />} {cursor?.pinned ? 'Pinned observation' : observed ? 'Observation' : 'Inspect a moment'}</span>
    {observed ? <>
      <time dateTime={new Date(observed.timestampMs).toISOString()}>{clockTime(observed.timestampMs)}</time>
      <span>p95 <strong>{latency(observed.p95Ms)}{observed.p95Ms !== null && ' ms'}</strong></span>
      <span>Requests <strong>{rate(observed.requestRate)}{observed.requestRate !== null && '/s'}</strong></span>
      <span>Errors <strong>{percentage(observed.errorRatio)}</strong></span>
      {!observed.complete && <span className="text-warning">Incomplete observation</span>}
      <span className="observation-help">Escape to dismiss</span>
    </> : <span className="observation-help">Hover or use arrow keys in a chart. Click or Enter to pin; Escape to dismiss.</span>}
  </div>;
}

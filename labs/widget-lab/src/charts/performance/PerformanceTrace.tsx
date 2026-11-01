import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { scaleLinear } from 'd3-scale';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { useChartTimeWindow, useTimeWindowBrush } from '../../vendor/paprika/ui/src/features/insights/time-window-controls';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { performanceTrace, performanceTraceConfig, type PerformanceSpan } from './model';
import { performanceNumber as fmt } from './PerformanceDensity';
import './performance.css';

export const performanceSpanColor = (id: string) => ({ queue: C.amber, database: C.orange, serialize: C.cyan, payment: C.violet, inventory: C.blue, pricing: C.blue }[id] ?? C.blue);
export function PerformanceTraceWaterfall({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = performanceTraceConfig.parse(widget.config ?? {});
  const data = useMemo(() => result.records ? performanceTrace(result.records) : null, [result.records]);
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), width = usePlotWidth(host, 950), uid = useId().replaceAll(':', '');
  const spans = data?.spans ?? [], enabled = !embedded && widget.options?.showTooltip !== false;
  const inspection = useInspection(spans, result, enabled, config.selectedSpan), selected = inspection.item ?? spans.find(span => span.id === config.selectedSpan);
  const duration = data?.duration ?? 0, extent = spans.length ? { start: 0, end: duration } : null;
  const view = useChartTimeWindow(extent, result, Math.max(.1, duration / 100));
  const [draft, setDraft] = useState({ start: 0, end: duration }), [windowError, setWindowError] = useState('');
  useEffect(() => { setDraft(view.window); setWindowError(''); }, [view.window.start, view.window.end]);
  const left = width < 500 ? 126 : 218, right = width - 14, top = 34, height = top + spans.length * config.rowHeight + 14;
  const x = scaleLinear().domain([view.window.start, view.window.end]).range([left, right]);
  const point = (clientX: number, clientY: number) => { const transform = svg.current?.getScreenCTM(); if (!transform) return null; const p = new DOMPoint(clientX, clientY).matrixTransform(transform.inverse()); return { x: p.x, y: p.y, timestamp: x.invert(Math.max(left, Math.min(right, p.x))), inPlot: p.x >= left && p.x <= right && p.y >= top && p.y <= height - 14 }; };
  const brush = useTimeWindowBrush({ enabled: !embedded && view.enabled, revision: result, window: view.window, point, commit: view.commit, onStart: inspection.dismiss });
  const pick = (span: PerformanceSpan, target: SVGElement) => { if (!enabled) return; inspection.select(span.id, target); onContextChange?.({ series: span.operation, value: span.duration, labels: { action: 'span', spanId: span.id, traceId: span.traceId, functionName: span.functionName ?? '', service: span.service } }); };
  return <div ref={host} className="performance-chart performance-trace" onKeyDown={inspection.onKeyDown}>
    {!spans.length ? <div className="domain-empty">No request trace spans.</div> : <>
      <div className="performance-chart-key"><div className="domain-legend"><span><i style={{ background: C.cyan }}/>Selected span</span><span><i style={{ background: C.blue }}/>Related span</span><span><i style={{ background: C.muted }}/>Nested work</span></div><strong>{fmt(duration)} ms elapsed</strong></div>
      {!embedded && <div className="performance-toolbar"><button disabled={!selected} onClick={() => { if (selected) view.commit({ start: selected.start, end: selected.end }); }}>Focus selected span</button><button disabled={!view.canUndo} onClick={view.undo}>Undo zoom</button><button disabled={!view.zoomed} onClick={view.reset}>Fit trace</button><span>Drag within timeline to zoom</span></div>}
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Request span waterfall, real millisecond offsets from request start" {...brush.handlers}>
        <defs><clipPath id={`${uid}-trace`}><rect x={left} y={top - 8} width={Math.max(1, right - left)} height={height - top + 8}/></clipPath><clipPath id={`${uid}-labels`}><rect x="0" y={top - 8} width={left - 7} height={height - top + 8}/></clipPath></defs>
        {x.ticks(width < 450 ? 3 : 7).map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={top - 9} y2={height - 14} stroke="var(--gamma-chart-grid)"/><text x={x(tick)} y="17" textAnchor="middle" fill={C.muted}>{fmt(tick, 0)}</text></g>)}
        <text x="0" y="17" fill={C.muted}>Span · offset in ms</text>
        {spans.map((span, index) => {
          const y = top + index * config.rowHeight, active = selected?.id === span.id, base = performanceSpanColor(span.id), parent = spans.find(item => item.id === span.parentId);
          return <g key={span.id} className="performance-trace-row" data-active={active} role={enabled ? 'button' : undefined} tabIndex={enabled ? 0 : undefined} aria-label={`${span.operation}, ${fmt(span.duration)} milliseconds, starts ${fmt(span.start)} milliseconds`} aria-pressed={enabled ? inspection.pinned === span.id : undefined} onPointerEnter={() => { if (!brush.active) inspection.setHover(span.id); }} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(span.id)} onBlur={() => inspection.setHover(null)} onClick={event => pick(span, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(span, event.currentTarget); } }}>
            <rect className="performance-trace-hit" x="0" y={y - 4} width={width} height={config.rowHeight} fill={active ? 'color-mix(in srgb, var(--gamma-chart-1) 6%, transparent)' : 'transparent'}/>
            <line x1="0" x2={width} y1={y + config.rowHeight - 5} y2={y + config.rowHeight - 5} stroke="var(--gamma-chart-grid)"/>
            <g clipPath={`url(#${uid}-labels)`}><text x={span.depth * 12 + 4} y={y + 12} fill={active ? C.cyan : 'var(--gamma-ink)'}>{span.depth ? '↳ ' : '› '}{span.operation}{config.showService && width > 760 ? ` (${span.service})` : ''}</text></g>
            <g clipPath={`url(#${uid}-trace)`}>
              {parent && <path d={`M${x(parent.start)},${y - config.rowHeight + 14}V${y + 7}H${x(span.start)}`} fill="none" stroke={C.muted} strokeWidth=".8" opacity=".55"/>}
              <rect className="performance-span-mark" x={x(span.start)} y={y} width={Math.max(1, x(span.end) - x(span.start))} height={config.rowHeight - 11} rx="1" fill={base} fillOpacity={span.phase || !span.parentId ? .86 : .48} stroke={active ? C.cyan : 'none'} strokeWidth="3"/>
              {active && <rect x={x(span.start) + 1.5} y={y + 1.5} width={Math.max(0, x(span.end) - x(span.start) - 3)} height={config.rowHeight - 14} fill="none" stroke="var(--gamma-ink)" strokeWidth="1"/>}
              {width > 500 && <text x={Math.min(right - 5, x(span.end) + 6)} y={y + 12} textAnchor={x(span.end) + 57 > right ? 'end' : 'start'} fill={active ? C.cyan : C.muted}>{fmt(span.duration)} ms</text>}
            </g>
          </g>;
        })}
        {brush.preview && <rect x={Math.min(brush.preview.x1, brush.preview.x2)} y={top - 8} width={Math.abs(brush.preview.x2 - brush.preview.x1)} height={height - top - 6} fill={C.cyan} fillOpacity=".13" stroke={C.cyan} pointerEvents="none"/>}
      </svg>
      {!embedded && <div className="performance-toolbar performance-window-inputs"><label>From ms<input aria-label="Trace window start milliseconds" type="number" min="0" max={duration} step=".1" value={draft.start} onChange={event => setDraft({ ...draft, start: Number(event.target.value) })}/></label><label>To ms<input aria-label="Trace window end milliseconds" type="number" min="0" max={duration} step=".1" value={draft.end} onChange={event => setDraft({ ...draft, end: Number(event.target.value) })}/></label><button onClick={() => { if (!Number.isFinite(draft.start) || !Number.isFinite(draft.end) || draft.start < 0 || draft.end > duration || draft.start >= draft.end) { setWindowError('Choose an increasing interval inside this request.'); return; } view.commit(draft); setWindowError(''); }}>Set window</button>{windowError && <span role="alert">{windowError}</span>}</div>}
      {inspection.item && <DomainInspector title={inspection.item.operation} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Elapsed span", `${fmt(inspection.item.duration)} ms`], ['Offset', `${fmt(inspection.item.start)}–${fmt(inspection.item.end)} ms`], ['Service', inspection.item.service], ['Parent', inspection.item.parentId ?? 'Request root'], ['Phase accounting', inspection.item.phase ? 'Non-overlapping supplied phase' : 'Inclusive / nested span']]}/>{inspection.item.functionName && onContextChange && <button className="performance-action" onClick={() => onContextChange({ series: inspection.item!.functionName!, value: inspection.item!.duration, labels: { action: 'function', spanId: inspection.item!.id, functionName: inspection.item!.functionName! } })}>Inspect related CPU function →</button>}</DomainInspector>}
      <p className="domain-note">One synthetic request. Nested spans overlap and are not added to request latency. Supplied non-overlapping phases account for {fmt(data?.accounted)} of {fmt(duration)} ms.</p>
    </>}
  </div>;
}

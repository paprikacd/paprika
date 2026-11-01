import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { area, line } from 'd3-shape';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../../renderer-extensions/time-window-controls';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { describeQuantile, latencyDensity, performanceDensityConfig, performanceObservations, stepDensityCell } from './model';
import './performance.css';

export const performanceNumber = (value: number | null | undefined, digits = 1) => value == null ? 'Unknown' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
export const performanceClock = (timestamp: number) => new Date(timestamp).toISOString().slice(11, 16);
export function PerformanceLatencyDensity({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = performanceDensityConfig.parse(widget.config ?? {});
  const observations = useMemo(() => result.records ? performanceObservations(result.records, config) : [], [result.records, config.latencyField, config.timeField]);
  const data = useMemo(() => latencyDensity(observations, config), [observations, config.bins, config.timeBuckets, config.build]);
  const box = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), width = usePlotWidth(box, 850), uid = useId().replaceAll(':', '');
  const enabled = !embedded && widget.options?.showTooltip !== false;
  type Quantile = 'p50' | 'p95' | 'p99';
  type QuantileEmphasis = { source: typeof result; scope: string; key: Quantile };
  const emphasisScope = `${config.build}:${config.showQuantiles}:${widget.options?.showLegend !== false}:${!!embedded}`;
  const [hoverEmphasis, setHoverEmphasis] = useState<QuantileEmphasis | null>(null), [pinnedEmphasis, setPinnedEmphasis] = useState<QuantileEmphasis | null>(null);
  // Mask obsolete emphasis during the replacement render, before effect cleanup.
  const hoverQuantile = hoverEmphasis?.source === result && hoverEmphasis.scope === emphasisScope ? hoverEmphasis.key : null;
  const pinnedQuantile = pinnedEmphasis?.source === result && pinnedEmphasis.scope === emphasisScope ? pinnedEmphasis.key : null;
  const setHoverQuantile = (key: Quantile | null) => setHoverEmphasis(key === null ? null : { source: result, scope: emphasisScope, key });
  const setPinnedQuantile = (key: Quantile | null) => setPinnedEmphasis(key === null ? null : { source: result, scope: emphasisScope, key });
  const highlightedQuantile = pinnedQuantile ?? hoverQuantile;
  useEffect(() => { setHoverEmphasis(null); setPinnedEmphasis(null); }, [result, emphasisScope]);
  const inspection = useInspection(data.cells, result, enabled, `${config.build}:${config.bins}:${config.timeBuckets}`);
  const view = useChartTimeWindow(data.extent, result, 120000);
  const x = scaleLinear().domain([view.window.start, view.window.end]).range([44, width - 12]);
  const y = scaleLog().domain([1, data.maximum]).range([171, 17]);
  const point = (clientX: number, clientY: number) => {
    const transform = svg.current?.getScreenCTM(); if (!transform) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(transform.inverse());
    return { x: p.x, y: p.y, timestamp: x.invert(Math.max(44, Math.min(width - 12, p.x))), inPlot: p.x >= 44 && p.x <= width - 12 && p.y >= 17 && p.y <= 171 };
  };
  const brush = useTimeWindowBrush({ enabled: !embedded && view.enabled, revision: result, window: view.window, point, commit: view.commit, onStart: inspection.dismiss });
  const cells = data.cells.filter(cell => cell.end > view.window.start && cell.start < view.window.end), maxCount = Math.max(1, ...cells.map(cell => cell.count));
  const active = inspection.item, bucket = active && data.buckets[active.bucket];
  const representative = active && observations.find(row => row.version === config.build && row.timestamp >= active.start && row.timestamp < active.end && row.latency !== null && row.latency >= active.lower && (row.latency < active.upper || active.index === config.bins - 1 && row.latency <= active.upper));
  const pin = (id: string, target?: SVGElement) => { if (enabled) inspection.select(id, target); };
  const distributionX = scaleLog().domain([1, data.maximum]).range([44, width - 12]);
  const totals = { before: data.before.reduce((sum, row) => sum + row.count, 0), after: data.after.reduce((sum, row) => sum + row.count, 0) };
  const maxShare = Math.max(1, ...data.before.map(row => row.count / Math.max(1, totals.before) * 100), ...data.after.map(row => row.count / Math.max(1, totals.after) * 100));
  const distributionY = scaleLinear().domain([0, maxShare * 1.12]).nice(3).range([77, 9]);
  const histLine = (build: 'before' | 'after') => line<typeof data.before[number]>().x(row => distributionX(Math.max(1, Math.sqrt(Math.max(1, row.lower) * row.upper)))).y(row => distributionY(row.count / Math.max(1, totals[build]) * 100))(data[build]) ?? '';
  const histArea = (build: 'before' | 'after') => area<typeof data.before[number]>().x(row => distributionX(Math.max(1, Math.sqrt(Math.max(1, row.lower) * row.upper)))).y0(distributionY(0)).y1(row => distributionY(row.count / Math.max(1, totals[build]) * 100))(data[build]) ?? '';
  return <div ref={box} className="performance-chart performance-density" data-highlighted-quantile={highlightedQuantile ?? undefined} onKeyDown={event => {
    inspection.onKeyDown(event);
    if (!event.defaultPrevented && event.key === 'Escape' && highlightedQuantile) {
      event.preventDefault(); event.stopPropagation(); setPinnedQuantile(null); setHoverQuantile(null);
    }
  }}>
    {!observations.length ? <div className="domain-empty">No request observations.</div> : <>
      <div className="performance-chart-key">{config.showQuantiles && widget.options?.showLegend !== false && <div className="domain-legend performance-quantile-legend" role="group" aria-label="Latency quantiles">{([['p50', C.cyan], ['p95', C.violet], ['p99', C.orange]] as const).map(([key, color]) => embedded ? <span key={key}><i style={{ background: color }}/>{key}</span> : <button key={key} type="button" aria-label={`Emphasize ${key} latency`} aria-pressed={pinnedQuantile === key} data-active={highlightedQuantile === key} data-muted={!!highlightedQuantile && highlightedQuantile !== key} onPointerEnter={() => setHoverQuantile(key)} onPointerLeave={() => setHoverQuantile(null)} onFocus={() => setHoverQuantile(key)} onBlur={() => setHoverQuantile(null)} onClick={() => setPinnedQuantile(pinnedQuantile === key ? null : key)} onKeyDown={event => { if (event.key === 'Escape' && highlightedQuantile) { event.preventDefault(); event.stopPropagation(); setPinnedQuantile(null); setHoverQuantile(null); } }}><i style={{ background: color }}/>{key}</button>)}</div>}<span>{config.build === 'after' ? 'Candidate' : 'Baseline'} · count per cell <i className="performance-density-ramp"/> 0–{maxCount}</span></div>
      <svg ref={svg} viewBox={`0 0 ${width} 204`} role="group" aria-label="Request latency heatmap, logarithmic milliseconds. Arrow keys inspect; Enter pins; drag to zoom time." tabIndex={enabled ? 0 : undefined} {...brush.handlers} onFocus={() => { if (!inspection.pinned) inspection.setHover(cells.find(cell => cell.count)?.id ?? null); }} onBlur={() => inspection.setHover(null)} onKeyDown={event => {
        if (!enabled || !cells.length) return;
        const visible = [...new Set(cells.map(cell => cell.bucket))];
        const step = stepDensityCell(visible, config.bins, active ? { bucket: active.bucket, index: active.index } : null, event.key);
        if (step) {
          event.preventDefault();
          const next = cells.find(cell => cell.bucket === step.bucket && cell.index === step.index);
          if (next) { if (inspection.pinned) pin(next.id, event.currentTarget); else inspection.setHover(next.id); }
        }
        if (event.key === 'Enter' && active) { event.preventDefault(); pin(active.id, event.currentTarget); }
      }}>
        <defs><clipPath id={`${uid}-heat`}><rect x="44" y="17" width={Math.max(1, width - 56)} height="154"/></clipPath><pattern id={`${uid}-missing`} width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0,6L6,0" stroke={C.muted} strokeWidth=".7"/></pattern></defs>
        {[1, 10, 100, 1000, 10000, 100000].filter(value => value <= data.maximum).map(value => <g key={value}><line x1="44" x2={width - 12} y1={y(value)} y2={y(value)} stroke="var(--gamma-chart-grid)"/><text x="38" y={y(value) + 4} textAnchor="end" fill={C.muted}>{value === 1 ? '≤1' : performanceNumber(value, 0)}</text></g>)}
        {x.ticks(width < 450 ? 3 : 6).map(timestamp => <text key={timestamp} x={x(timestamp)} y="190" textAnchor="middle" fill={C.muted}>{performanceClock(timestamp)}</text>)}
        <text x="44" y="12" fill={C.muted}>Latency · ms (log)</text>
        <g clipPath={`url(#${uid}-heat)`}>
          {data.buckets.filter(item => item.missing).map(item => <rect key={item.id} x={x(item.start)} y="17" width={Math.max(0, x(item.end) - x(item.start))} height="154" fill={`url(#${uid}-missing)`} opacity=".35"/>)}
          {cells.map(cell => <rect key={cell.id} className="performance-density-cell" data-active={active?.id === cell.id} role={enabled ? 'button' : undefined} tabIndex={enabled ? -1 : undefined} aria-label={`${performanceClock(cell.start)}, ${performanceNumber(cell.lower)}–${performanceNumber(cell.upper)} milliseconds, ${cell.count} observed requests`} aria-pressed={enabled ? inspection.pinned === cell.id : undefined} x={x(cell.start)} y={y(cell.upper)} width={Math.max(.5, x(cell.end) - x(cell.start) - .4)} height={Math.max(.4, y(Math.max(1, cell.lower)) - y(cell.upper) - .25)} fill={cell.count ? `color-mix(in srgb, ${C.cyan} ${18 + Math.log1p(cell.count) / Math.log1p(maxCount) * 82}%, var(--gamma-chart-6))` : 'var(--gamma-surface-2)'} fillOpacity={cell.count ? .86 : .45} stroke={active?.id === cell.id ? 'var(--gamma-ink)' : 'none'} strokeWidth="1.5" onPointerEnter={() => { if (!brush.active) inspection.setHover(cell.id); }} onPointerLeave={() => inspection.setHover(null)} onClick={event => pin(cell.id, event.currentTarget)}/>)}
          {active && <line x1={x((active.start + active.end) / 2)} x2={x((active.start + active.end) / 2)} y1="17" y2="171" stroke="var(--gamma-ink)" strokeOpacity=".55" strokeDasharray="3 3" pointerEvents="none"/>}
          {config.showQuantiles && ([['p50', C.cyan], ['p95', C.violet], ['p99', C.orange]] as const).map(([key, color]) => <g key={key} className="performance-quantile" data-muted={!!highlightedQuantile && highlightedQuantile !== key} pointerEvents="none"><path d={line<typeof data.buckets[number]>().defined(item => item[key] !== null).x(item => x((item.start + item.end) / 2)).y(item => y(Math.max(1, item[key]!)))(data.buckets) ?? ''} fill="none" stroke={color} strokeWidth={highlightedQuantile === key ? 2.3 : key === 'p99' ? 1.9 : 1.5} strokeDasharray={key === 'p99' ? undefined : key === 'p50' ? '5 3' : '2 3'}/>{bucket && bucket[key] !== null && <g><circle cx={x((bucket.start + bucket.end) / 2)} cy={y(Math.max(1, bucket[key]!))} r="5.5" fill="none" stroke={color} strokeOpacity=".65"/><circle cx={x((bucket.start + bucket.end) / 2)} cy={y(Math.max(1, bucket[key]!))} r="3" fill={color} stroke="var(--gamma-bg)" strokeWidth="1.4"/></g>}</g>)}
          {brush.preview && <rect x={Math.min(brush.preview.x1, brush.preview.x2)} y="17" width={Math.abs(brush.preview.x2 - brush.preview.x1)} height="154" fill={C.cyan} fillOpacity=".12" stroke={C.cyan} pointerEvents="none"/>}
        </g>
      </svg>
      {!embedded && <TimeWindowControls state={view} compact/>}
      <div className="performance-subheading"><strong>Build distributions</strong><span><i style={{ background: C.cyan }}/> Baseline · n={totals.before}</span><span><i style={{ background: C.violet }}/> Candidate · n={totals.after}</span></div>
      <svg viewBox={`0 0 ${width} 108`} role="img" aria-label="Baseline and candidate latency distribution, percent of observed requests per logarithmic bin">
        {distributionY.ticks(3).map(value => <g key={value}><line x1="44" x2={width - 12} y1={distributionY(value)} y2={distributionY(value)} stroke="var(--gamma-chart-grid)"/><text x="37" y={distributionY(value) + 4} textAnchor="end" fill={C.muted}>{performanceNumber(value, 0)}%</text></g>)}
        {(['before', 'after'] as const).map(build => <g key={build}><path d={histArea(build)} fill={build === 'before' ? C.cyan : C.violet} fillOpacity=".11"/><path d={histLine(build)} fill="none" stroke={build === 'before' ? C.cyan : C.violet} strokeWidth="1.6"/></g>)}
        {[1, 10, 100, 1000, 10000, 100000].filter(value => value <= data.maximum).map(value => <text key={value} x={distributionX(value)} y="96" textAnchor={value === 1 ? 'start' : value === data.maximum ? 'end' : 'middle'} fill={C.muted}>{performanceNumber(value, 0)} ms</text>)}
      </svg>
      {active && bucket && <DomainInspector title={`${performanceClock(active.start)}–${performanceClock(active.end)} UTC · ${config.build === 'after' ? 'Candidate' : 'Baseline'}`} pinned={!!inspection.pinned} onClose={inspection.dismiss}>
        <DetailValues items={[["Latency bin", `${performanceNumber(active.lower)}–${performanceNumber(active.upper)} ms`], ['Observed in bin', `${active.count} / ${active.total} requests`], ['Missing latency in interval', active.missing], ['Interval p99', describeQuantile(bucket.p99, bucket.quantileBasis.p99, bucket.count)]]}/>
        {representative && onContextChange && <button className="performance-action" onClick={() => onContextChange({ series: representative.route, value: representative.latency, labels: { action: 'trace', request: representative.pair, build: representative.version } })}>Open representative request · {representative.pair} →</button>}
      </DomainInspector>}
      <p className="domain-note">Counts retain raw requests; quantiles are empirical, and an interval with fewer than 1/(1−q) samples reports its maximum. Distribution shares use each build’s observed denominator. Time zoom is local; full-window build distributions stay fixed.</p>
    </>}
  </div>;
}

import { useMemo, useRef } from 'react';
import { scaleLinear } from 'd3-scale';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { pairedEvidenceConfig, pairedPerformance, performanceObservations } from './model';
import { performanceNumber as fmt } from './PerformanceDensity';
import './performance.css';

export function PerformancePairedEvidence({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = pairedEvidenceConfig.parse(widget.config ?? {}), data = useMemo(() => result.records ? pairedPerformance(performanceObservations(result.records)) : [], [result.records]);
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 500), enabled = !embedded && widget.options?.showTooltip !== false;
  const inspection = useInspection(data, result, enabled), active = inspection.item;
  return <div ref={host} className="performance-chart performance-evidence" onKeyDown={inspection.onKeyDown}>
    {!data.length ? <div className="domain-empty">No matched build observations.</div> : <>
      <div className="domain-legend"><span><i style={{ background: C.blue }}/>Baseline v2.8.1</span><span><i style={{ background: C.violet }}/>Candidate v2.8.2</span><span>Mean{config.showIntervals ? ' ± 95% interval' : ''}</span></div>
      {data.map(metric => {
        const max = Math.max(1, metric.before?.upper ?? metric.before?.mean ?? 0, metric.after?.upper ?? metric.after?.mean ?? 0), min = Math.min(0, metric.before?.lower ?? 0, metric.after?.lower ?? 0);
        const x = scaleLinear().domain([min, max * 1.12]).nice(4).range([12, width - 20]);
        const interval = (item: NonNullable<typeof metric.before>) => item.lower === null ? 'Interval unavailable · n < 2' : `${fmt(item.lower)}–${fmt(item.upper)}`;
        return <section key={metric.id} className="performance-evidence-row" data-selected={active?.id === metric.id}>
          <div className="performance-evidence-title"><strong>{metric.label} <small>({metric.unit})</small></strong>{config.showRelativeChange && <b style={{ color: (metric.relativeChange ?? 0) > 0 ? C.orange : C.mint }}>{metric.relativeChange === null ? 'Unknown' : `${metric.relativeChange > 0 ? '+' : ''}${fmt(metric.relativeChange, 0)}%`}</b>}</div>
          <div className="performance-evidence-values"><span>n={metric.count} complete pairs{metric.missing ? ` · ${metric.missing} missing` : ''}</span><span style={{ color: C.blue }}>{fmt(metric.before?.mean)} <span aria-hidden="true">→</span> <b style={{ color: C.violet }}>{fmt(metric.after?.mean)}</b></span></div>
          {!metric.before || !metric.after ? <p className="domain-note">No complete paired observations for this metric.</p> : <svg viewBox={`0 0 ${width} 67`} role="button" tabIndex={enabled ? 0 : undefined} aria-label={`${metric.label}, baseline ${fmt(metric.before.mean)}, candidate ${fmt(metric.after.mean)} ${metric.unit}, ${metric.count} complete pairs`} onPointerEnter={() => inspection.setHover(metric.id)} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(metric.id)} onBlur={() => inspection.setHover(null)} onClick={event => { if (enabled) inspection.select(metric.id, event.currentTarget); }} onKeyDown={event => { if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); inspection.select(metric.id, event.currentTarget); } }}>
            {x.ticks(width < 350 ? 3 : 5).map(value => <g key={value}><line x1={x(value)} x2={x(value)} y1="3" y2="44" stroke="var(--gamma-chart-grid)"/><text x={x(value)} y="61" textAnchor="middle" fill={C.muted}>{fmt(value, 0)}</text></g>)}
            {([['before', C.blue, 15], ['after', C.violet, 35]] as const).map(([build, color, y]) => {
              const item = metric[build]!;
              return <g key={build}><title>{build}: mean {fmt(item.mean)}, 95% interval {interval(item)} {metric.unit}</title>{config.showIntervals && item.lower !== null && item.upper !== null && <><line x1={x(item.lower)} x2={x(item.upper)} y1={y} y2={y} stroke={color} strokeWidth="2"/><path d={`M${x(item.lower)},${y - 4}V${y + 4}M${x(item.upper)},${y - 4}V${y + 4}`} stroke={color}/></>}<circle cx={x(item.mean)} cy={y} r="4" fill={color} stroke="var(--gamma-ink)" strokeWidth=".8"/></g>;
            })}
          </svg>}
        </section>;
      })}
      {active && <DomainInspector title={active.label} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Complete matched pairs", `${active.count} / ${active.totalPairs}`], ['Baseline mean', `${fmt(active.before?.mean)} ${active.unit}`], ['Candidate mean', `${fmt(active.after?.mean)} ${active.unit}`], ['Paired mean difference', `${fmt(active.delta?.mean)} ${active.unit}`], ['95% difference interval', active.delta?.lower == null ? 'Unavailable · fewer than 2 pairs' : `${fmt(active.delta.lower)}–${fmt(active.delta.upper)} ${active.unit}`]]}/>{onContextChange && <button className="performance-action" onClick={() => onContextChange({ series: active.label, value: active.delta?.mean ?? null, labels: { action: 'profile', metric: active.id } })}>Inspect aggregate CPU comparison →</button>}</DomainInspector>}
      <p className="domain-note">Each metric excludes incomplete pairs. Intervals use 1.96 × standard error; difference intervals use within-pair differences. Synthetic comparison supports investigation, not causal attribution.</p>
    </>}
  </div>;
}

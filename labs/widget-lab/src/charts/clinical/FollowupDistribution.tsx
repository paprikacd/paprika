import { useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { scaleLinear } from 'd3-scale';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { followupConfig, followupDistribution, survivalConfig, survivalObservations, type FollowupBin } from './model';
import './clinical.css';

const number = (value: number, digits = 2) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const interval = (bin: FollowupBin) => `${number(bin.start)}–${bin.upperInclusive ? '' : '<'}${number(bin.end)} months`;

export function FollowupDistribution(props: WidgetRendererProps) {
  const c = followupConfig.parse(props.widget.config ?? {}), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 760);
  const observations = useMemo(() => props.result.records ? survivalObservations(props.result.records, survivalConfig.parse({ id: c.id, arm: c.arm, duration: c.duration, event: c.event })) : [], [props.result.records, c.id, c.arm, c.duration, c.event]);
  const data = useMemo(() => followupDistribution(observations, c.binWidthMonths), [observations, c.binWidthMonths]);
  const selectedParticipant = observations.find(row => row.id === c.selectedId);
  const participantBin = data.bins.find(bin => bin.participants.includes(c.selectedId));
  const interactive = !props.embedded && props.widget.options?.showTooltip !== false;
  const inspection = useInspection(data.bins, data, interactive, participantBin?.id);
  const left = c.measure === 'percent' ? 49 : 43, right = 14, top = 22, bottom = 196, height = 244;
  const value = (count: number) => c.measure === 'percent' && data.population ? count / data.population * 100 : count;
  const maxValue = Math.max(1, ...data.bins.map(bin => value(c.arrangement === 'stacked' ? bin.count : Math.max(bin.events, bin.censored))));
  const y = scaleLinear().domain([0, maxValue]).nice(4).range([bottom, top]);
  const end = data.bins.at(-1)?.end ?? c.binWidthMonths;
  const x = scaleLinear().domain([0, end]).range([left, width - right]);
  const columnWidth = (width - left - right) / Math.max(1, data.bins.length), pad = Math.min(6, columnWidth * .18);
  const ticks = y.ticks(4).filter(tick => c.measure === 'percent' || Number.isInteger(tick));
  const tickStride = Math.max(1, Math.ceil(data.bins.length / (width < 440 ? 4 : 8)));
  const xTicks = data.bins.filter((_, index) => index % tickStride === 0).map(bin => bin.start).concat(end);
  const select = (bin: FollowupBin, target?: HTMLElement | SVGElement) => {
    inspection.select(bin.id, target);
    props.onContextChange?.({ value: bin.count, labels: { followupStart: String(bin.start), followupEnd: String(bin.end), upperInclusive: String(bin.upperInclusive), participants: String(bin.count), population: String(data.population) } });
  };
  const keyDown = (event: KeyboardEvent<SVGGElement>, bin: FollowupBin) => {
    if (!interactive) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(bin, event.currentTarget); }
    else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const marks = [...(ref.current?.querySelectorAll<SVGGElement>('[data-followup-bin]') ?? [])];
      const index = marks.indexOf(event.currentTarget), next = event.key === 'Home' ? 0 : event.key === 'End' ? marks.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1);
      event.preventDefault(); marks[Math.max(0, Math.min(marks.length - 1, next))]?.focus();
    } else inspection.onKeyDown(event);
  };
  if (!observations.length) return <div className="domain-empty">No follow-up endpoint observations</div>;
  return <div className="clinical-chart clinical-followup" ref={ref} onKeyDown={inspection.onKeyDown}>
    <div className="clinical-followup-summary"><span><strong>{data.population}</strong> participants</span><span>{data.events} observed endpoints</span><span>{data.censored} right-censored</span></div>
    <svg width={width} height={height} role="group" aria-label={`${props.widget.title}, endpoint and censor counts by observed follow-up duration`}>
      {ticks.map(tick => <g key={tick}>{props.widget.options?.showGrid !== false && <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="clinical-grid"/>}<text x={left - 8} y={y(tick) + 4} textAnchor="end">{number(tick, 1)}{c.measure === 'percent' ? '%' : ''}</text></g>)}
      <text x={left} y={12}>{c.measure === 'percent' ? 'Share of entire selected cohort' : 'Participants'}</text>
      {data.bins.map(bin => {
        const bx = x(bin.start) + pad / 2, barWidth = Math.max(1, x(bin.end) - x(bin.start) - pad);
        const active = inspection.item?.id === bin.id, participant = participantBin?.id === bin.id;
        const label = `${interval(bin)}: ${bin.events} observed endpoints, ${bin.censored} right-censored; ${bin.count} of ${data.population} participants`;
        return <g key={bin.id} data-followup-bin={bin.id} data-clinical-mark role={interactive ? 'button' : 'img'} tabIndex={interactive ? 0 : undefined} aria-label={label} aria-pressed={interactive ? inspection.pinned === bin.id : undefined}
          onPointerEnter={() => inspection.setHover(bin.id)} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(bin.id)} onBlur={() => inspection.setHover(null)}
          onClick={(event: MouseEvent<SVGGElement>) => { if (interactive) select(bin, event.currentTarget); }} onKeyDown={event => keyDown(event, bin)}>
          <rect x={x(bin.start)} y={top - 6} width={columnWidth} height={bottom - top + 6} fill={active ? 'color-mix(in srgb, var(--gamma-chart-1) 8%, transparent)' : 'transparent'} stroke={active ? C.cyan : 'transparent'}/>
          {c.arrangement === 'stacked' ? <>
            <rect x={bx} y={y(value(bin.events))} width={barWidth} height={bottom - y(value(bin.events))} fill={C.violet} opacity={.9}/>
            <rect x={bx} y={y(value(bin.count))} width={barWidth} height={y(value(bin.events)) - y(value(bin.count))} fill={C.muted} opacity={.52}/>
            {c.showValues && columnWidth > 34 && bin.count > 0 && <text x={bx + barWidth / 2} y={y(value(bin.count)) - 6} textAnchor="middle" className="clinical-strong">{c.measure === 'percent' ? `${number(value(bin.count), 1)}%` : bin.count}</text>}
          </> : <>
            {[{ count: bin.events, color: C.violet, opacity: .9 }, { count: bin.censored, color: C.muted, opacity: .6 }].map((series, index) => <g key={index}><rect x={bx + index * barWidth / 2} y={y(value(series.count))} width={Math.max(.5, barWidth / 2 - 1)} height={bottom - y(value(series.count))} fill={series.color} opacity={series.opacity}/>{c.showValues && columnWidth > 70 && series.count > 0 && <text x={bx + (index + .5) * barWidth / 2} y={y(value(series.count)) - 6} textAnchor="middle">{c.measure === 'percent' ? `${number(value(series.count), 1)}%` : series.count}</text>}</g>)}
          </>}
          {participant && !props.embedded && <path d={`M${x(selectedParticipant!.duration)},${bottom + 1}l-4,7h8Z`} fill={C.cyan} stroke="var(--gamma-ink)" strokeWidth={.6}/>}
          <title>{label}</title>
        </g>;
      })}
      <line x1={left} x2={width - right} y1={bottom} y2={bottom} className="clinical-axis"/>
      {xTicks.map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={bottom} y2={bottom + 4} className="clinical-axis"/><text x={x(tick)} y={bottom + 21} textAnchor="middle">{number(tick, 2)}</text></g>)}
      <text x={(left + width - right) / 2} y={height - 3} textAnchor="middle">Observed follow-up duration (months)</text>
    </svg>
    {props.widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.violet }}/>Observed endpoint</span><span><i style={{ background: C.muted, opacity: .6 }}/>Right-censored</span>{selectedParticipant && !props.embedded && <span><i className="clinical-followup-marker"/>{selectedParticipant.id} · {number(selectedParticipant.duration)} months</span>}</div>}
    {interactive && c.showControls && <div className="clinical-chart-controls clinical-followup-controls"><label>Inspect interval <select className="domain-control" aria-label="Follow-up interval" value={inspection.pinned ?? ''} onChange={event => { const bin = data.bins.find(row => row.id === event.target.value); if (bin) select(bin, event.currentTarget); else inspection.dismiss(); }}><option value="">Select an interval</option>{data.bins.map(bin => <option key={bin.id} value={bin.id}>{interval(bin)} · {bin.count} participants</option>)}</select></label>{inspection.pinned && <button className="domain-control" onClick={inspection.dismiss}>Clear interval</button>}</div>}
    <p className="clinical-note">Each participant appears once at their last observed month. Intervals include the left boundary; the final interval also includes its right boundary.</p>
    {inspection.item && <DomainInspector title={`Follow-up ${interval(inspection.item)}`} pinned={!!inspection.pinned} onClose={inspection.dismiss}>
      <DetailValues items={[["Participants", `${inspection.item.count} / ${data.population}`], ["Share of cohort", `${number(inspection.item.count / data.population * 100, 2)}%`], ["Observed endpoints", inspection.item.events], ["Right-censored", inspection.item.censored]]}/>
      <div className="domain-table-scroll clinical-followup-arms"><table className="domain-table"><caption>Study arm breakdown</caption><thead><tr><th>Arm</th><th>Events</th><th>Censored</th><th>Total</th></tr></thead><tbody>{inspection.item.arms.map(arm => <tr key={arm.arm}><td>{arm.arm}</td><td className="is-number">{arm.events}</td><td className="is-number">{arm.censored}</td><td className="is-number">{arm.count}</td></tr>)}</tbody></table></div>
    </DomainInspector>}
  </div>;
}

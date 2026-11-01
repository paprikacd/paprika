import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { area, curveStepAfter, line } from 'd3-shape';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import type { DrilldownContext } from '@insights/drilldown';
import {
  CLINICAL_VISITS, VISIT_LABELS, completenessConfig, forestConfig, hazardEstimates,
  kaplanMeier, responseConfig, responseObservations, survivalAt, survivalConfig,
  survivalObservations, swimmerConfig, swimmerObservations, visitParticipants,
  type SurvivalStep, type VisitState,
} from './model';
import './clinical.css';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import hatchStyles from '@insights/plot-hatch.module.css';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

const fmt = (value: number | null, precision = 2) => value === null ? 'Not assessed' : value.toLocaleString('en-US', { maximumFractionDigits: precision });
const armColor = (arm: string) => arm === 'Arm A' ? C.cyan : arm === 'Arm B' ? C.violet : 'var(--gamma-chart-5)';
const enabled = (props: WidgetRendererProps) => !props.embedded && props.widget.options?.showTooltip !== false;
type Inspection<T extends { id: string }> = ReturnType<typeof useInspection<T>>;
function mark<T extends { id: string }>(inspection: Inspection<T>, id: string, label: string, interactive: boolean, context: DrilldownContext, onContext?: WidgetRendererProps['onContextChange']) {
  const select = (target: SVGElement) => { inspection.select(id, target); onContext?.(context); };
  return {
    role: interactive ? 'button' : 'img', tabIndex: interactive ? 0 : undefined,
    'aria-label': label, 'aria-pressed': interactive ? inspection.pinned === id : undefined,
    'data-clinical-mark': true,
    onPointerEnter: () => inspection.setHover(id), onPointerLeave: () => inspection.setHover(null),
    onFocus: () => inspection.setHover(id), onBlur: () => inspection.setHover(null),
    onClick: (event: MouseEvent<SVGElement>) => { if (interactive) select(event.currentTarget); },
    onKeyDown: (event: KeyboardEvent<SVGElement>) => {
      if (!interactive) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event.currentTarget); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        const marks = [...(event.currentTarget.closest('.clinical-chart')?.querySelectorAll<SVGElement>('[data-clinical-mark]') ?? [])];
        const index = marks.indexOf(event.currentTarget), direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        event.preventDefault(); marks[event.key === 'Home' ? 0 : event.key === 'End' ? marks.length - 1 : Math.max(0, Math.min(marks.length - 1, index + direction))]?.focus();
      } else inspection.onKeyDown(event);
    },
  };
}
const visitName: Record<VisitState, string> = { observed: 'Observed visit', missing: 'Missed scheduled visit', 'post-event': 'After observed endpoint', 'after-censor': 'Beyond observed follow-up' };
function Empty({ children }: { children: string }) { return <div className="domain-empty">{children}</div>; }

export function SurvivalKM(props: WidgetRendererProps) {
  const c = survivalConfig.parse(props.widget.config ?? {}), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 760);
  const entering = useChartEntrance({ disabled: props.embedded, anchor: ref });
  const observations = useMemo(() => props.result.records ? survivalObservations(props.result.records, c) : [], [props.result.records, c.id, c.arm, c.duration, c.event]);
  const curves = useMemo(() => kaplanMeier(observations), [observations]);
  const maxTime = Math.max(1, ...observations.map(row => row.duration));
  const points = useMemo(() => [...new Set([0, ...observations.map(row => row.duration)])].sort((a, b) => a - b).map(time => ({ id: `month:${time}`, time })), [observations]);
  const [month, setMonth] = useState(c.selectedMonth), [controlRevision, setControlRevision] = useState(0);
  const inspection = useInspection(points, props.result.records, enabled(props), `${c.selectedMonth}:${controlRevision}`);
  useEffect(() => setMonth(c.selectedMonth), [c.selectedMonth, props.result.records]);
  const selectedMonth = Math.min(maxTime, inspection.item?.time ?? month);
  const margins = { left: 50, right: 14, top: 15 }, bottom = 215, x = scaleLinear().domain([0, maxTime]).range([margins.left, width - margins.right]), y = scaleLinear().domain([0, 1]).range([bottom, margins.top]);
  const tickCount = width < 450 ? 4 : 7, ticks = Array.from({ length: tickCount }, (_, i) => maxTime * i / (tickCount - 1));
  const summaries = curves.map(curve => ({ curve, point: survivalAt(curve, selectedMonth) }));
  const selectMonth = (time: number) => { const next = Math.max(0, Math.min(maxTime, time)); setMonth(next); props.onContextChange?.({ value: next, labels: { month: String(next) } }); };
  if (!observations.length) return <Empty>No endpoint observations</Empty>;
  return <div className="clinical-chart clinical-survival" ref={ref} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown}>
    {!props.embedded && c.showControls && <div className="clinical-chart-controls"><label>Inspect month <input aria-label="Survival inspection month" type="number" min={0} max={maxTime} step={.25} value={month} onChange={event => { const next = Number(event.target.value); if (Number.isFinite(next)) { setControlRevision(value => value + 1); selectMonth(next); } }}/></label><button className="domain-control" onClick={() => { setControlRevision(value => value + 1); selectMonth(Math.min(12, maxTime)); }}>Reset inspection</button></div>}
    <svg width={width} height={262} role="group" aria-label={`${props.widget.title}, probability by months since randomisation`}>
      {props.widget.options?.showGrid !== false && [0, .2, .4, .6, .8, 1].map(value => <line key={value} x1={margins.left} x2={width - margins.right} y1={y(value)} y2={y(value)} className="clinical-grid"/>)}
      {[0, .2, .4, .6, .8, 1].map(value => <text key={value} x={margins.left - 8} y={y(value) + 4} textAnchor="end">{value.toFixed(1)}</text>)}
      {ticks.map(time => <g key={time}>{props.widget.options?.showGrid !== false && <line x1={x(time)} x2={x(time)} y1={margins.top} y2={bottom} className="clinical-grid"/>}<text x={x(time)} y={bottom + 21} textAnchor="middle">{fmt(time, 1)}</text></g>)}
      <text x={15} y={bottom / 2} transform={`rotate(-90 15 ${bottom / 2})`} textAnchor="middle">Event-free probability</text>
      <text x={(margins.left + width - margins.right) / 2} y={257} textAnchor="middle">Months since randomisation</text>
      <g className={chartEntrance.revealMarks}>{curves.map(curve => <g key={curve.arm}>
        {c.showConfidence && <path d={area<SurvivalStep>().x(step => x(step.time)).y0(step => y(step.lower)).y1(step => y(step.upper)).curve(curveStepAfter)(curve.steps) ?? ''} fill={armColor(curve.arm)} opacity={.15}/>}
        <path d={line<SurvivalStep>().x(step => x(step.time)).y(step => y(step.survival)).curve(curveStepAfter)(curve.steps) ?? ''} fill="none" stroke={armColor(curve.arm)} strokeWidth={1.8}/>
        {c.showCensors && curve.steps.filter(step => step.censored > 0).map(step => <path key={step.time} d={`M${x(step.time) - 3},${y(step.survival)}h6M${x(step.time)},${y(step.survival) - 3}v6`} stroke={armColor(curve.arm)} strokeWidth={1.2}/>)}
      </g>)}</g>
      {!props.embedded && <line x1={x(selectedMonth)} x2={x(selectedMonth)} y1={margins.top} y2={bottom} className="clinical-selected-rule"/>}
      {!props.embedded && summaries.filter(row => row.point.available).map(({ curve, point }) => <circle key={curve.arm} cx={x(selectedMonth)} cy={y(point.survival)} r={4} fill={armColor(curve.arm)} stroke="var(--gamma-ink)" strokeWidth={1.6}/>)}
      {points.map((point, index) => {
        const previous = points[index - 1]?.time ?? point.time, next = points[index + 1]?.time ?? point.time;
        const begin = index === 0 ? margins.left : x((previous + point.time) / 2), end = index === points.length - 1 ? width - margins.right : x((point.time + next) / 2);
        const label = `Month ${point.time}: ${curves.map(curve => { const value = survivalAt(curve, point.time); return `${curve.arm} ${value.available ? fmt(value.survival * 100, 1) + '% event-free' : 'outside follow-up'}, ${value.risk} at risk`; }).join('; ')}`;
        return <rect key={point.id} x={begin} y={margins.top} width={Math.max(1, end - begin)} height={bottom - margins.top} fill="transparent" {...mark(inspection, point.id, label, enabled(props), { value: point.time, labels: { month: String(point.time) } }, () => selectMonth(point.time))}><title>{label}</title></rect>;
      })}
    </svg>
    {props.widget.options?.showLegend !== false && <div className="domain-legend">{curves.map(curve => <span key={curve.arm}><i style={{ background: armColor(curve.arm) }}/>{curve.arm} · n={curve.size}</span>)}{c.showCensors && <span>+ Censored</span>}{c.showConfidence && <span>95% pointwise CI</span>}</div>}
    {c.showRiskTable && <svg width={width} height={44 + curves.length * 22} aria-label="Number at risk immediately before each labelled month" role="img"><text x={3} y={14} className="clinical-strong">Number at risk</text>{ticks.map(time => <text key={time} x={x(time)} y={33} textAnchor="middle">{fmt(time, 1)}</text>)}{curves.map((curve, index) => <g key={curve.arm}><text x={3} y={55 + index * 22} fill={armColor(curve.arm)}>{curve.arm.replace('Arm ', '')}</text>{ticks.map(time => <text key={time} x={x(time)} y={55 + index * 22} textAnchor="middle">{survivalAt(curve, time).risk}</text>)}</g>)}</svg>}
    {!props.embedded && <div className="clinical-km-readout" aria-live="polite"><strong>Month {fmt(selectedMonth)}</strong>{summaries.map(({ curve, point }) => <span key={curve.arm}><i style={{ background: armColor(curve.arm) }}/>{curve.arm} <b>{point.available ? fmt(point.survival * 100, 1) + '%' : 'No follow-up'}</b><small>{point.risk} at risk{c.showConfidence && point.available ? ` · CI ${fmt(point.lower * 100, 1)}–${fmt(point.upper * 100, 1)}%` : ''}</small></span>)}</div>}
  </div>;
}

export function HazardForest(props: WidgetRendererProps) {
  const c = forestConfig.parse(props.widget.config ?? {}), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 530);
  const entering = useChartEntrance({ disabled: props.embedded, anchor: ref });
  const rows = useMemo(() => props.result.records ? hazardEstimates(props.result.records, c) : [], [props.result.records, c.id, c.label, c.estimate, c.lower, c.upper, c.samples]);
  const inspection = useInspection(rows, props.result.records, enabled(props), c.selectedId), compact = width < 470;
  const left = compact ? 102 : 126, right = c.showValues && !compact ? 105 : 18, height = rows.length * 43 + 72;
  const min = Math.min(.25, ...rows.map(row => row.lower)), max = Math.max(2, ...rows.map(row => row.upper)), x = scaleLog().domain([min, max]).range([left, width - right]);
  if (!rows.length) return <Empty>No subgroup estimates</Empty>;
  return <div className="clinical-chart" ref={ref} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown}>
    <svg width={width} height={height} role="group" aria-label={`${props.widget.title}, hazard ratios on a logarithmic scale`}>
      <text x={4} y={15}>Subgroup{c.showSampleCounts ? ' (n)' : ''}</text>{c.showValues && !compact && <text x={width - 3} y={15} textAnchor="end">HR [95% CI]</text>}
      <line x1={x(1)} x2={x(1)} y1={24} y2={height - 45} className="clinical-selected-rule"/>
      <g className={chartEntrance.revealMarks}>{rows.map((row, index) => {
        const cy = 42 + index * 43, selected = row.id === c.selectedId || row.id === inspection.item?.id;
        return <g key={row.id} {...mark(inspection, row.id, `${row.label}, hazard ratio ${row.estimate}, 95% interval ${row.lower} to ${row.upper}, ${row.samples} participants`, enabled(props), { series: row.label, value: row.estimate, labels: { population: row.id } }, props.onContextChange)}>
          <rect x={1} y={cy - 17} width={width - 2} height={40} fill={selected ? 'color-mix(in srgb, var(--gamma-chart-1) 9%, transparent)' : 'transparent'} stroke={selected ? C.cyan : 'transparent'}/>
          <text x={5} y={cy - 1}>{row.label}</text>{c.showSampleCounts && <text x={5} y={cy + 14} className="clinical-muted">n={row.samples}</text>}
          <line x1={x(row.lower)} x2={x(row.upper)} y1={cy} y2={cy} stroke="var(--gamma-ink)" strokeWidth={1.3}/><path d={`M${x(row.lower)},${cy - 4}v8M${x(row.upper)},${cy - 4}v8`} stroke="var(--gamma-ink)"/>
          {row.id === 'all' ? <path d={`M${x(row.estimate) - 8},${cy}l8,-7l8,7l-8,7Z`} fill={C.cyan}/> : <rect x={x(row.estimate) - 5} y={cy - 5} width={10} height={10} fill={C.cyan} stroke={selected ? 'var(--gamma-ink)' : 'none'}/>}
          {c.showValues && !compact && <text x={width - 3} y={cy + 4} textAnchor="end">{row.estimate.toFixed(2)} [{row.lower.toFixed(2)}, {row.upper.toFixed(2)}]</text>}
        </g>;
      })}</g>
      {[.125, .25, .5, 1, 2, 4, 8].filter(tick => tick >= min && tick <= max).map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={height - 44} y2={height - 39} className="clinical-axis"/><text x={x(tick)} y={height - 22} textAnchor="middle">{tick.toFixed(tick < 1 ? 2 : 1)}</text></g>)}
      <line x1={left} x2={width - right} y1={height - 44} y2={height - 44} className="clinical-axis"/><text x={(left + width - right) / 2} y={height - 3} textAnchor="middle">Hazard ratio · log scale</text>
    </svg>
    <p className="clinical-note">Supplied exploratory estimates · reference HR = 1</p>
    {inspection.item && <DomainInspector title={inspection.item.label} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Hazard ratio", fmt(inspection.item.estimate)], ["95% interval", `${fmt(inspection.item.lower)}–${fmt(inspection.item.upper)}`], ["Participants", inspection.item.samples], ["Source", 'Synthetic supplied model estimate']]}/></DomainInspector>}
  </div>;
}

export function ResponseWaterfall(props: WidgetRendererProps) {
  const c = responseConfig.parse(props.widget.config ?? {}), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 760);
  const entering = useChartEntrance({ disabled: props.embedded, anchor: ref });
  const all = useMemo(() => props.result.records ? responseObservations(props.result.records, c) : [], [props.result.records, c.id, c.arm, c.value, c.month, c.sort]);
  const rows = all.filter(row => row.value !== null), inspection = useInspection(rows, props.result.records, enabled(props), c.selectedId);
  const bottom = 169, left = 47, right = 12, y = scaleLinear().domain([Math.min(-100, ...rows.map(row => row.value!), ...(c.showThreshold ? [c.threshold] : [])), Math.max(40, ...rows.map(row => row.value!), ...(c.showThreshold ? [c.threshold] : []))]).range([bottom, 13]);
  const barWidth = (width - left - right) / Math.max(1, rows.length), zero = y(0);
  if (!all.length) return <Empty>No participant response records</Empty>;
  if (!rows.length) return <Empty>No assessed responses in this population; unassessed values remain missing.</Empty>;
  return <div className="clinical-chart" ref={ref} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown}>
    <svg width={width} height={207} role="group" aria-label={`${props.widget.title}, change from baseline in percent`}>
      {y.ticks(6).map(value => <g key={value}>{props.widget.options?.showGrid !== false && <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="clinical-grid"/>}<text x={left - 7} y={y(value) + 4} textAnchor="end">{fmt(value, 0)}</text></g>)}
      <text x={13} y={86} transform="rotate(-90 13 86)" textAnchor="middle">Change from baseline (%)</text>
      <line x1={left} x2={width - right} y1={zero} y2={zero} className="clinical-axis"/>
      <g className={chartEntrance.revealMarks}>{rows.map((row, index) => { const selected = row.id === c.selectedId || row.id === inspection.item?.id, x = left + index * barWidth + .5; return <g key={row.id} {...mark(inspection, row.id, `${row.id}, ${row.arm}, ${row.value}% change at month ${row.month}`, enabled(props), { series: row.id, value: row.value, labels: { participant: row.id, arm: row.arm, month: String(row.month) } }, props.onContextChange)}><rect x={x} y={Math.min(zero, y(row.value!))} width={Math.max(.5, barWidth - 1.1)} height={Math.max(.7, Math.abs(y(row.value!) - zero))} fill={row.value! <= 0 ? C.cyan : C.violet} opacity={selected ? 1 : .82} stroke={selected ? 'var(--gamma-ink)' : 'none'} strokeWidth={selected ? 1.5 : 0}/><rect x={x} y={13} width={Math.max(.5, barWidth - .7)} height={bottom - 13} fill="transparent"/>{selected && width > 600 && <text x={Math.max(left + 20, Math.min(width - right - 25, x + barWidth / 2))} y={bottom + 18} textAnchor="middle">{row.id}</text>}</g>; })}</g>
      {c.showThreshold && <g pointerEvents="none"><line x1={left} x2={width - right} y1={y(c.threshold)} y2={y(c.threshold)} stroke={C.amber} strokeDasharray="5 4"/><text x={left + 6} y={y(c.threshold) + (c.threshold < 0 ? 15 : -6)} fill={C.amber}>Protocol threshold {c.threshold}%</text></g>}
      <text x={(left + width - right) / 2} y={203} textAnchor="middle">{rows.length} assessed participants · {c.sort === 'response' ? 'ordered by observed response' : 'participant identity order'}</text>
    </svg>
    {props.widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.cyan }}/>Decrease</span><span><i style={{ background: C.violet }}/>Increase</span><span>{all.length - rows.length} unassessed / missing of {all.length}</span></div>}
    {inspection.item && <DomainInspector title={inspection.item.id} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Study arm", inspection.item.arm], ["Observed change", `${fmt(inspection.item.value, 1)}%`], ["Assessment", `Month ${inspection.item.month}`], ["Population", `${rows.length} assessed / ${all.length} records`]]}/></DomainInspector>}
  </div>;
}

export function VisitCompleteness(props: WidgetRendererProps) {
  const c = completenessConfig.parse(props.widget.config ?? {}), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 760), uid = useId().replaceAll(':', '');
  const entering = useChartEntrance({ disabled: props.embedded, anchor: ref });
  const rows = useMemo(() => props.result.records ? visitParticipants(props.result.records, c) : [], [props.result.records, c.id, c.arm, c.visitPrefix]);
  const [page, setPage] = useState(0), selectedIndex = rows.findIndex(row => row.id === c.selectedId);
  useEffect(() => { if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / c.pageSize)); else setPage(0); }, [c.selectedId, selectedIndex, c.pageSize, props.result.records]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / c.pageSize) - 1)), start = currentPage * c.pageSize, visible = rows.slice(start, start + c.pageSize);
  const cells = useMemo(() => rows.flatMap(row => row.visits.map((state, visit) => ({ id: `${row.id}:${visit}`, participant: row.id, arm: row.arm, state, visit }))), [rows]);
  const inspection = useInspection(cells, props.result.records, enabled(props), c.selectedId, cell => cell.participant), left = width < 420 ? 79 : 104, cellWidth = (width - left - 9) / 7, top = 27, rowHeight = 23, height = top + visible.length * rowHeight + 5;
  if (!rows.length) return <Empty>No visit records</Empty>;
  return <div className="clinical-chart" ref={ref} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown}>
    <svg width={width} height={height} role="group" aria-label={`${props.widget.title}, scheduled visit coverage`}>
      <PlotHatchDefs id={uid}/>
      <text x={4} y={17}>Participant</text>{VISIT_LABELS.map((label, index) => <text key={label} x={left + (index + .5) * cellWidth} y={17} textAnchor="middle">{width < 420 && index === 0 ? 'M0' : label}</text>)}
      {visible.map((row, index) => <g key={row.id}>
        <rect x={1} y={top + index * rowHeight} width={width - 2} height={rowHeight} fill={row.id === c.selectedId ? 'color-mix(in srgb,var(--gamma-chart-1) 8%,transparent)' : 'transparent'} stroke={row.id === c.selectedId ? C.cyan : 'transparent'}/>
        <text x={4} y={top + index * rowHeight + 16} fill={armColor(row.arm)}>{row.id}</text>{width >= 420 && <text x={76} y={top + index * rowHeight + 16} fill={armColor(row.arm)}>{row.arm.replace('Arm ', '')}</text>}
        <g className={chartEntrance.revealMarks}>{row.visits.map((state, visit) => { const cx = left + (visit + .5) * cellWidth, cy = top + index * rowHeight + 11.5, id = `${row.id}:${visit}`; return <g key={visit} {...mark(inspection, id, `${row.id}, ${VISIT_LABELS[visit]}, ${visitName[state]}`, enabled(props), { series: row.id, value: CLINICAL_VISITS[visit], labels: { participant: row.id, arm: row.arm, visit: VISIT_LABELS[visit], state } }, props.onContextChange)}><rect x={cx - cellWidth / 2} y={cy - 11} width={cellWidth - 1} height={22} fill={state === 'missing' ? plotHatchFill(uid) : 'transparent'} stroke={inspection.item?.id === id ? 'var(--gamma-ink)' : 'var(--gamma-border)'}/>{state === 'observed' && <circle cx={cx} cy={cy} r={4} fill={C.cyan}/>}{state === 'after-censor' && <circle cx={cx} cy={cy} r={4} fill="none" stroke="var(--gamma-muted)"/>}{state === 'post-event' && <path d={`M${cx - 3},${cy - 3}l6,6M${cx + 3},${cy - 3}l-6,6`} stroke={C.amber}/>}</g>; })}</g>
      </g>)}
    </svg>
    {rows.length > c.pageSize && <div className="clinical-pagination"><span>Participants {start + 1}–{Math.min(rows.length, start + c.pageSize)} of {rows.length}</span>{!props.embedded && c.showControls && <><button className="domain-control" aria-label="Previous participant page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button className="domain-control" aria-label="Next participant page" disabled={start + c.pageSize >= rows.length} onClick={() => setPage(currentPage + 1)}>Next</button></>}</div>}
    {props.widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.cyan }}/>Observed</span><span><i className={`${hatchStyles.hatch} ${hatchStyles.swatch}`}/>Missed visit</span><span style={{ color: C.amber }}>× Post-event</span><span>○ After censor</span></div>}
    {inspection.item && <DomainInspector title={`${inspection.item.participant} · ${VISIT_LABELS[inspection.item.visit]}`} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Study arm", inspection.item.arm], ["Month", CLINICAL_VISITS[inspection.item.visit]], ["Coverage", visitName[inspection.item.state]]]}/></DomainInspector>}
  </div>;
}

export function ParticipantSwimmer(props: WidgetRendererProps) {
  const c = swimmerConfig.parse(props.widget.config ?? {}), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 520);
  const entering = useChartEntrance({ disabled: props.embedded, anchor: ref });
  const rows = useMemo(() => props.result.records ? swimmerObservations(props.result.records, c) : [], [props.result.records, c.id, c.arm, c.duration, c.event, c.treatmentEnd, c.visitPrefix]);
  const inspection = useInspection(rows, props.result.records, enabled(props), c.selectedId);
  const selected = rows.find(row => row.id === c.selectedId), visible = [selected, ...rows.filter(row => row.id !== selected?.id)].filter(row => !!row).slice(0, c.maxRows);
  const max = Math.max(1, ...rows.map(row => row.duration)), single = c.maxRows === 1, left = single ? 20 : 72, right = 18, top = 23, rowHeight = single ? 69 : 29, height = top + visible.length * rowHeight + 38, x = scaleLinear().domain([0, max]).range([left, width - right]);
  const active = inspection.item ?? selected ?? visible[0];
  if (!rows.length || !active) return <Empty>No participant follow-up records</Empty>;
  return <div className="clinical-chart" ref={ref} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown}>
    {single && <div className="clinical-participant-summary"><strong style={{ color: armColor(active.arm) }}>{active.id} · {active.arm}</strong><span>Observed follow-up <b>{fmt(active.duration)} months</b></span><span>Endpoint <b>{active.event ? 'Event observed' : 'Right-censored'}</b></span></div>}
    <svg width={width} height={height} role="group" aria-label={`${props.widget.title}, observed treatment and follow-up intervals`}>
      {(width < 400 ? [0, 6, 12, 18] : [0, 3, 6, 9, 12, 15, 18]).filter(time => time <= max).map(time => <g key={time}><line x1={x(time)} x2={x(time)} y1={top - 11} y2={height - 33} className="clinical-grid"/><text x={x(time)} y={height - 15} textAnchor="middle">{time}</text></g>)}
      <g className={chartEntrance.revealMarks}>{visible.map((row, index) => { const cy = top + rowHeight * index + rowHeight / 2; return <g key={row.id} {...mark(inspection, row.id, `${row.id}, ${row.arm}, observed follow-up ${row.duration} months, ${row.event ? 'event' : 'censored'}`, enabled(props), { series: row.id, value: row.duration, labels: { participant: row.id, arm: row.arm } }, props.onContextChange)}>
        {!single && <text x={2} y={cy + 4}>{row.id}</text>}
        <rect x={left} y={cy - 13} width={width - left - right} height={26} fill="transparent"/>
        <line x1={x(0)} x2={x(row.duration)} y1={cy} y2={cy} stroke={armColor(row.arm)} strokeWidth={1.5}/>
        <rect x={x(0)} y={cy - 6} width={x(row.treatmentEnd) - x(0)} height={12} fill={armColor(row.arm)} opacity={.65}/>
        {c.showVisits && row.visits.map((state, index) => state === 'observed' ? <circle key={index} cx={x(CLINICAL_VISITS[index])} cy={cy} r={3} fill={armColor(row.arm)} stroke="var(--gamma-ink)"/> : state === 'missing' ? <circle key={index} cx={x(CLINICAL_VISITS[index])} cy={cy} r={3} fill="var(--gamma-bg)" stroke={C.amber}/> : null)}
        {row.event ? <path d={`M${x(row.duration)},${cy - 6}l5,10h-10Z`} fill={C.red}/> : <path d={`M${x(row.duration) - 5},${cy}h10M${x(row.duration)},${cy - 5}v10`} stroke="var(--gamma-ink)" strokeWidth={1.6}/>}
        {c.showValues && !single && <text x={Math.min(width - 6, x(row.duration) + 8)} y={cy + 4} textAnchor={x(row.duration) > width - 65 ? 'end' : 'start'}>{fmt(row.duration, 1)}m</text>}
      </g>; })}</g>
      <text x={(left + width - right) / 2} y={height - 1} textAnchor="middle">Months since randomisation</text>
    </svg>
    {props.widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.cyan }}/>Treatment</span><span>● Observed visit</span><span>○ Missed visit</span><span style={{ color: C.red }}>▲ Event</span><span>+ Censored</span></div>}
    {single && <div className="domain-table-scroll clinical-visit-table"><table className="domain-table"><caption>Observed history · {active.id}</caption><thead><tr><th>Visit</th><th>Month</th><th>Evidence</th></tr></thead><tbody>{active.visits.map((state, index) => <tr key={index}><td>{VISIT_LABELS[index]}</td><td>{CLINICAL_VISITS[index]}</td><td className={state === 'missing' ? 'clinical-warning' : ''}>{visitName[state]}</td></tr>)}<tr><td>Follow-up end</td><td>{active.duration}</td><td>{active.event ? 'Endpoint observed' : 'Censored observation'}</td></tr></tbody></table></div>}
    {!single && inspection.item && <DomainInspector title={inspection.item.id} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Study arm", inspection.item.arm], ["Follow-up", `${fmt(inspection.item.duration)} months`], ["Treatment end", `${fmt(inspection.item.treatmentEnd)} months`], ["Endpoint", inspection.item.event ? 'Observed event' : 'Right-censored']]}/></DomainInspector>}
    {!single && <p className="clinical-note">Showing {visible.length} of {rows.length} participant histories. Exact complete records are available in the editor data view.</p>}
  </div>;
}

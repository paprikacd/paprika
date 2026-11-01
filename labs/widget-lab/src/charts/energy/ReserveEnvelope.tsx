import { useId, useMemo, useRef, type KeyboardEvent } from 'react';
import { scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { reserveEnvelopeConfig, reserveEnvelopePoints, reserveExtent, type ReservePoint } from './reserve-model';
import './energy.css';

const clock = (time: number) => new Date(time).toISOString().slice(11, 16);
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
const format = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString('en-US', { maximumFractionDigits: 1 });
const power = (value: number | null) => value === null ? 'Unknown' : `${format(value)} MW`;

export function ReserveEnvelope({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const c = useMemo(() => reserveEnvelopeConfig.parse(widget.config ?? {}), [widget.config]);
  const points = useMemo(() => result.records ? reserveEnvelopePoints(result.records, c) : [], [result.records, c.timeField, c.capacityField, c.observedField, c.medianField, c.low68Field, c.high68Field, c.low95Field, c.high95Field]);
  const ref = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), width = usePlotWidth(ref, 740), uid = useId().replaceAll(':', '');
  const enabled = !embedded && widget.options?.showTooltip !== false;
  const inspect = useInspection(points, points, enabled, c.selectedTime === undefined ? undefined : String(c.selectedTime));
  const controlledPoint = points.find(point => point.timestamp === c.selectedTime), active = inspect.item ?? controlledPoint;
  const first = points[0]?.timestamp ?? 0, last = points.at(-1)?.timestamp ?? first;
  const domain: [number, number] = first === last ? [first - 150_000, last + 150_000] : [first, last];
  const left = 54, right = 14, top = 25, bottom = 222, height = 270;
  const x = scaleLinear().domain(domain).range([left, width - right]), y = scaleLinear().domain(reserveExtent(points, c.threshold)).nice(4).range([bottom, top]);
  const tickCount = width < 420 ? 4 : 6, ticks = Array.from({ length: tickCount }, (_, index) => domain[0] + index / (tickCount - 1) * (domain[1] - domain[0]));
  const path = (key: 'observedReserve' | 'medianReserve') => line<ReservePoint>().defined(point => point[key] !== null).x(point => x(point.timestamp)).y(point => y(point[key]!))(points) ?? '';
  const band = (lower: 'low68' | 'low95', upper: 'high68' | 'high95') => area<ReservePoint>().defined(point => point[lower] !== null && point[upper] !== null).x(point => x(point.timestamp)).y0(point => y(point[lower]!)).y1(point => y(point[upper]!))(points) ?? '';
  const label = (point: ReservePoint) => `${date(point.timestamp)} ${clock(point.timestamp)} UTC · ${point.observedReserve !== null ? `observed reserve ${power(point.observedReserve)}` : point.medianReserve !== null ? `forecast reserve ${power(point.medianReserve)}` : 'reserve unknown'}`;
  const nearest = (time: number) => points.reduce<ReservePoint | undefined>((chosen, point) => !chosen || Math.abs(point.timestamp - time) < Math.abs(chosen.timestamp - time) ? point : chosen, undefined);
  const choose = (point: ReservePoint, target?: HTMLElement | SVGElement) => {
    if (!enabled) return;
    inspect.select(point.id, target);
    onContextChange?.({ series: point.observedReserve !== null ? 'Observed reserve' : point.medianReserve !== null ? 'Forecast reserve' : 'Reserve unavailable', value: point.observedReserve ?? point.medianReserve, labels: { timestamp: point.id, kind: point.observedReserve !== null ? 'observation' : point.medianReserve !== null ? 'forecast' : 'unknown', unit: 'MW' } });
  };
  const inspectPointer = (clientX: number, clientY: number, pin: boolean) => {
    if (!enabled || inspect.pinned && !pin) return;
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return;
    const location = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    if (location.x < left || location.x > width - right || location.y < top || location.y > bottom) { if (!pin) inspect.setHover(null); return; }
    const point = nearest(x.invert(location.x));
    if (point) { if (pin) choose(point, svg.current!); else inspect.setHover(point.id); }
  };
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!enabled) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = points.findIndex(point => point.id === active?.id);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : index < 0 ? 0 : Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
      if (inspect.pinned) choose(points[next], event.currentTarget); else inspect.setHover(points[next].id);
    } else if ((event.key === 'Enter' || event.key === ' ') && active) { event.preventDefault(); choose(active, event.currentTarget); }
    else inspect.onKeyDown(event);
  };
  if (!points.length) return <div className="domain-empty">No reserve observations</div>;
  return <div className="energy-chart reserve-envelope" ref={ref} onKeyDown={inspect.onKeyDown}>
    <div className="energy-reserve-heading"><span>Available capacity − required supply</span><span>{date(first)}{date(first) !== date(last) ? ` – ${date(last)}` : ''} · UTC</span></div>
    <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${widget.title}. Reserve in MW. Arrow keys inspect exact observations; Enter pins.`} tabIndex={enabled ? 0 : undefined}
      onFocus={() => { if (enabled && !inspect.item) inspect.setHover((controlledPoint ?? points[0]).id); }} onBlur={() => inspect.setHover(null)} onKeyDown={keyDown}
      onPointerMove={event => inspectPointer(event.clientX, event.clientY, false)} onPointerLeave={() => inspect.setHover(null)} onClick={event => inspectPointer(event.clientX, event.clientY, true)}>
      <defs><clipPath id={`${uid}-clip`}><rect x={left} y={top} width={Math.max(1, width - left - right)} height={bottom - top}/></clipPath><pattern id={`${uid}-gap`} width={7} height={7} patternUnits="userSpaceOnUse"><path d="M0 7 7 0" stroke="var(--gamma-muted)" strokeWidth={.7}/></pattern></defs>
      <text x={left} y={13} fill="var(--gamma-muted)">Reserve (MW)</text>
      {y.ticks(4).map(value => <g key={value}>{widget.options?.showGrid !== false && <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--gamma-border)" strokeWidth={.7}/>}<text x={left - 9} y={y(value) + 4} textAnchor="end" fill="var(--gamma-muted)">{format(value)}</text></g>)}
      {ticks.map((time, index) => <g key={time}>{widget.options?.showGrid !== false && <line x1={x(time)} x2={x(time)} y1={top} y2={bottom} stroke="var(--gamma-border)" strokeWidth={.5}/>}<text x={x(time)} y={bottom + 22} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} fill="var(--gamma-muted)">{clock(time)}</text></g>)}
      <g clipPath={`url(#${uid}-clip)`}>
        <rect x={left} y={y(c.threshold)} width={width - left - right} height={Math.max(0, bottom - y(c.threshold))} fill={C.amber} fillOpacity={.04}/>
        {points.filter(point => point.observedReserve === null && point.medianReserve === null).map(point => {
          const index = points.indexOf(point), before = points[index - 1]?.timestamp ?? point.timestamp, after = points[index + 1]?.timestamp ?? point.timestamp;
          const start = index ? (before + point.timestamp) / 2 : domain[0], end = index < points.length - 1 ? (point.timestamp + after) / 2 : domain[1];
          return <rect key={point.id} x={x(start)} y={top} width={Math.max(1, x(end) - x(start))} height={bottom - top} fill={`url(#${uid}-gap)`} opacity={.25}/>;
        })}
        {c.show95 && <path d={band('low95', 'high95')} fill={C.blue} fillOpacity={.2}/>}
        {c.show68 && <path d={band('low68', 'high68')} fill={C.violet} fillOpacity={.23}/>}
        <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="var(--gamma-muted)" strokeWidth={1}/>
        <line x1={left} x2={width - right} y1={y(c.threshold)} y2={y(c.threshold)} stroke={C.amber} strokeWidth={1.2} strokeDasharray="5 4"/>
        <path d={path('observedReserve')} fill="none" stroke={C.cyan} strokeWidth={1.9}/>
        <path d={path('medianReserve')} fill="none" stroke={C.violet} strokeWidth={1.9} strokeDasharray="5 4"/>
        {(['observedReserve', 'medianReserve'] as const).flatMap((key, series) => points.filter((point, index) => point[key] !== null && (points[index - 1]?.[key] ?? null) === null && (points[index + 1]?.[key] ?? null) === null).map(point => <circle key={`${key}:${point.id}`} cx={x(point.timestamp)} cy={y(point[key]!)} r={2.5} fill={series === 0 ? C.cyan : C.violet}/>))}
        {active && !embedded && <><line x1={x(active.timestamp)} x2={x(active.timestamp)} y1={top} y2={bottom} stroke="var(--gamma-ink)" strokeDasharray="3 4"/>{[active.observedReserve, active.medianReserve].map((value, index) => value !== null ? <circle key={index} cx={x(active.timestamp)} cy={y(value)} r={3.8} fill={index === 0 ? C.cyan : C.violet} stroke="var(--gamma-ink)" strokeWidth={1.2}/> : null)}</>}
      </g>
      <text x={width - right - 4} y={Math.max(top + 12, Math.min(bottom - 4, y(c.threshold) - 7))} textAnchor="end" fill={C.amber}>Reference {format(c.threshold)} MW</text>
      <text x={(left + width - right) / 2} y={height - 3} textAnchor="middle" fill="var(--gamma-muted)">Observation / forecast time · UTC</text>
    </svg>
    {widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.cyan }}/>Observed reserve</span><span><i style={{ background: C.violet }}/>Forecast median</span>{c.show68 && points.some(point => point.low68 !== null) && <span><i style={{ background: C.violet, opacity: .5 }}/>68% range</span>}{c.show95 && points.some(point => point.low95 !== null) && <span><i style={{ background: C.blue, opacity: .5 }}/>95% range</span>}<span><i className="energy-hatch"/>Unknown reserve</span></div>}
    {enabled && c.showControls && <div className="energy-reserve-controls"><label>Inspect time <select className="domain-control" aria-label="Reserve inspection time" value={active?.id ?? ''} onChange={event => { const point = points.find(point => point.id === event.target.value); if (point) choose(point, event.currentTarget); }}><option value="" disabled>Select observation</option>{points.map(point => <option key={point.id} value={point.id}>{clock(point.timestamp)} UTC · {point.observedReserve !== null ? 'observed' : point.medianReserve !== null ? 'forecast' : 'unknown'}</option>)}</select></label>{inspect.pinned && <button className="domain-control" onClick={inspect.dismiss}>Clear inspection</button>}</div>}
    {active && !embedded && <div className="energy-reserve-readout"><span>{clock(active.timestamp)} UTC</span><strong>{power(active.observedReserve ?? active.medianReserve)}</strong><span>{active.observedReserve !== null ? 'Observed headroom' : active.medianReserve !== null ? 'Forecast median headroom' : 'Headroom unavailable'}</span></div>}
    {inspect.item && <DomainInspector title={label(inspect.item)} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Available capacity', power(inspect.item.capacity)], ['Observed required supply', power(inspect.item.observedDemand)], ['Forecast required supply', power(inspect.item.medianDemand)],
      ['Observed reserve', power(inspect.item.observedReserve)], ['Median forecast reserve', power(inspect.item.medianReserve)],
      ['68% reserve interval', inspect.item.low68 === null ? 'Not supplied / unknown' : `${format(inspect.item.low68)} to ${format(inspect.item.high68)} MW`],
      ['95% reserve interval', inspect.item.low95 === null ? 'Not supplied / unknown' : `${format(inspect.item.low95)} to ${format(inspect.item.high95)} MW`],
      ['Reference threshold', `${format(c.threshold)} MW`],
    ]}/><p className="domain-note">Each reserve bound subtracts the opposite demand bound from the supplied capacity.</p></DomainInspector>}
  </div>;
}

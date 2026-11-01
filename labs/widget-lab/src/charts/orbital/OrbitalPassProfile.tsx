import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { nearestAt, orbitalDuration, orbitalUtc } from './model';
import { passProfileConfig, passProfilePoints, profilePasses, profileSignalPath, qualifyProfile, type PassProfilePoint } from './pass-profile-model';
import './orbital.css';

const value = (n: number | null, decimals = 1) => n === null ? 'Unknown' : n.toLocaleString('en-US', { maximumFractionDigits: decimals });

export function OrbitalPassProfile(props: WidgetRendererProps) {
  const { widget, result, embedded, onContextChange } = props;
  const cfg = useMemo(() => passProfileConfig.parse(widget.config ?? {}), [widget.config]);
  const points = useMemo(() => passProfilePoints(result.records, cfg), [result, cfg]);
  const passes = useMemo(() => profilePasses(points), [points]);
  const [selectedId, setSelectedId] = useState(cfg.selectedPass ?? passes[0]?.id ?? '');
  const [timestamp, setTimestamp] = useState(cfg.selectedTimestamp);
  const inspectionEnabled = !embedded && widget.options?.showTooltip !== false;
  const svg = useRef<SVGSVGElement>(null), container = useRef<HTMLDivElement>(null), width = usePlotWidth(container, 720);
  const source = useRef(result), uid = useId().replaceAll(':', '');
  useEffect(() => { setSelectedId(cfg.selectedPass ?? passes[0]?.id ?? ''); }, [cfg.selectedPass, passes[0]?.id]);
  useEffect(() => { setTimestamp(cfg.selectedTimestamp); }, [cfg.selectedTimestamp]);
  useEffect(() => {
    if (source.current !== result) { source.current = result; setTimestamp(undefined); setSelectedId(cfg.selectedPass ?? passes[0]?.id ?? ''); }
  }, [result, cfg.selectedPass, passes]);
  const active = passes.find(pass => pass.id === selectedId);
  const inspection = useInspection(points, result, inspectionEnabled, selectedId, point => point.passId);
  const current = active ? inspection.item?.passId === active.id ? inspection.item : timestamp === undefined ? undefined : nearestAt(active.samples, timestamp) : undefined;
  const qualified = useMemo(() => active ? qualifyProfile(active, cfg) : null, [active, cfg]);
  const selectPass = (id: string) => { inspection.dismiss(); setSelectedId(id); setTimestamp(undefined); onContextChange?.({ series: id, labels: { passId: id, timestamp: '' } }); };
  const selectSample = (sample: PassProfilePoint) => {
    setTimestamp(sample.timestamp); inspection.select(sample.id, svg.current ?? undefined);
    onContextChange?.({ series: sample.passId, labels: { passId: sample.passId, timestamp: String(sample.timestamp) } });
  };
  const clearSample = () => { inspection.dismiss(); setTimestamp(undefined); onContextChange?.({ series: selectedId, labels: { passId: selectedId, timestamp: '' } }); };
  const picker = !embedded && inspectionEnabled && cfg.showPassPicker && <label className="orbital-pass-picker">Contact<select aria-label="Select pass profile" value={selectedId} onChange={event => selectPass(event.target.value)}><option value="">Choose a pass</option>{passes.map(pass => <option key={pass.id} value={pass.id}>{pass.satellite} · {pass.station} · {orbitalUtc(pass.start)}</option>)}</select></label>;
  if (!points.length) return <div className="orbital-empty">No orbital observations in this result.</div>;
  if (!active || !qualified) return <div className="orbital-chart" ref={container}><div className="orbital-empty">Select a contact to compare its elevation, margin and transfer opportunity.</div>{picker}</div>;
  const left = width < 360 ? 41 : 48, right = 17, plotWidth = Math.max(1, width - left - right), laneHeight = 70, laneGap = 38, firstTop = 29;
  const lastBottom = firstTop + 2 * (laneHeight + laneGap) + laneHeight, height = lastBottom + 31;
  const x = (t: number) => left + (t - active.start) / (active.end - active.start) * plotWidth;
  const finiteMargins = active.samples.flatMap(sample => sample.margin === null ? [] : [sample.margin]);
  const marginMin = Math.floor(Math.min(0, cfg.minimumMargin, ...finiteMargins) / 5) * 5;
  const marginMax = Math.max(marginMin + 5, Math.ceil(Math.max(0, cfg.minimumMargin, ...finiteMargins) / 5) * 5);
  const rateMax = Math.max(10, Math.ceil(Math.max(0, ...active.samples.flatMap(sample => sample.throughput === null ? [] : [sample.throughput])) / 10) * 10);
  const lanes = [
    { field: 'elevation' as const, label: 'Elevation', unit: '°', color: C.cyan, min: 0, max: 90, threshold: cfg.minimumElevation, ticks: [0, 45, 90] },
    { field: 'margin' as const, label: 'Link margin', unit: 'dB', color: C.violet, min: marginMin, max: marginMax, threshold: cfg.minimumMargin, ticks: [marginMin, (marginMin + marginMax) / 2, marginMax] },
    { field: 'throughput' as const, label: 'Throughput', unit: 'Mbps', color: C.mint, min: 0, max: rateMax, threshold: null, ticks: [0, rateMax / 2, rateMax] },
  ];
  const tickCount = width < 420 ? 3 : width < 650 ? 4 : 6;
  const ticks = Array.from({ length: tickCount }, (_, i) => active.start + i * (active.end - active.start) / (tickCount - 1));
  const onPointer = (event: PointerEvent<SVGSVGElement>, pin = false) => {
    if (!inspectionEnabled) return;
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (point.x < left || point.x > width - right || point.y < firstTop || point.y > lastBottom) { inspection.setHover(null); return; }
    const sample = nearestAt(active.samples, active.start + (point.x - left) / plotWidth * (active.end - active.start));
    if (sample) { if (pin) selectSample(sample); else inspection.setHover(sample.id); }
  };
  const currentIndex = current ? active.samples.findIndex(sample => sample.id === current.id) : -1;
  const sampleStatus = !current ? '' : current.margin === null ? 'Unknown · margin unavailable' : current.elevation >= cfg.minimumElevation && current.margin >= cfg.minimumMargin ? current.throughput === null ? 'Meets thresholds · rate unknown' : 'Meets planning thresholds' : 'Outside planning thresholds';
  return <div className="orbital-chart orbital-profile" ref={container} data-orbital-pass-profile onKeyDown={event => { if (event.key === 'Escape' && (current || inspection.hover || inspection.pinned)) { event.preventDefault(); event.stopPropagation(); clearSample(); } }}>
    <div className="orbital-plot-context"><strong>{active.satellite} / {active.station}</strong><span>{orbitalUtc(active.start, true)}–{orbitalUtc(active.end, true)} UTC</span></div>
    <dl className="orbital-profile-summary">
      <div><dt>Qualifying duration</dt><dd>{qualified.totalQualifiedMs === null ? 'Unknown total' : orbitalDuration(qualified.totalQualifiedMs)}</dd>{qualified.totalQualifiedMs === null && <small>{orbitalDuration(qualified.qualifiedMs)} known contribution</small>}</div>
      <div><dt>Qualifying transfer</dt><dd>{qualified.totalVolumeMB === null ? 'Unknown total' : `${value(qualified.totalVolumeMB)} MB`}</dd>{qualified.totalVolumeMB === null && <small>{value(qualified.knownVolumeMB)} MB known contribution</small>}</div>
      <div><dt>Signal coverage</dt><dd>{value(qualified.coverage * 100)}%</dd><small>{qualified.unknownMs ? `${orbitalDuration(qualified.unknownMs)} unresolved` : `${active.samples.length} timed samples`}</small></div>
    </dl>
    <svg ref={svg} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={inspectionEnabled ? 0 : undefined} aria-label="Contact profile with aligned elevation, link margin and throughput. Arrow keys inspect observations; Enter pins; Escape clears." onPointerMove={onPointer} onPointerLeave={() => inspection.setHover(null)} onClick={event => onPointer(event as unknown as PointerEvent<SVGSVGElement>, true)} onKeyDown={event => {
      if (!inspectionEnabled) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? active.samples.length - 1 : Math.max(0, Math.min(active.samples.length - 1, currentIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
        if (inspection.pinned) selectSample(active.samples[index]); else inspection.setHover(active.samples[index].id);
      } else if ((event.key === 'Enter' || event.key === ' ') && current) { event.preventDefault(); event.stopPropagation(); selectSample(current); }
    }} onBlur={() => inspection.setHover(null)}>
      <defs><pattern id={`${uid}-missing`} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(35)"><line x1="0" x2="0" y1="0" y2="7" stroke={C.muted} strokeWidth="1"/></pattern></defs>
      {lanes.map((lane, index) => {
        const top = firstTop + index * (laneHeight + laneGap), y = (n: number) => top + laneHeight - (n - lane.min) / (lane.max - lane.min) * laneHeight;
        return <g key={lane.field}>
          <text x={left} y={top - 11} className="orbital-profile-lane-label">{lane.label} · {lane.unit}</text>
          {cfg.showThresholds && lane.threshold !== null && <text x={width - right} y={top - 11} textAnchor="end" className="orbital-axis">≥ {value(lane.threshold)} {lane.unit}</text>}
          {cfg.showEligibleWindows && qualified.windows.map(window => <rect key={window.start} x={x(window.start)} y={top} width={x(window.end) - x(window.start)} height={laneHeight} fill={C.mint} fillOpacity=".085"/>)}
          {qualified.unknown.map(interval => <rect key={interval.start} x={x(interval.start)} y={top} width={x(interval.end) - x(interval.start)} height={laneHeight} fill={`url(#${uid}-missing)`} opacity=".35"/>)}
          {ticks.map(t => <line key={t} x1={x(t)} x2={x(t)} y1={top} y2={top + laneHeight} className="orbital-grid"/>)}
          {lane.ticks.map(tick => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="orbital-grid"/><text x={left - 8} y={y(tick) + 4} textAnchor="end" className="orbital-axis">{value(tick)}</text></g>)}
          {cfg.showThresholds && lane.threshold !== null && <line x1={left} x2={width - right} y1={y(lane.threshold)} y2={y(lane.threshold)} stroke={C.amber} strokeDasharray="4 4" strokeOpacity=".8"/>}
          <path d={profileSignalPath(active.samples, lane.field, cfg.maxGapSeconds * 1000, x, y)} fill="none" stroke={lane.color} strokeWidth="1.8"/>
          {cfg.showSampleMarkers && active.samples.filter(sample => sample[lane.field] !== null).map(sample => <circle key={sample.id} cx={x(sample.timestamp)} cy={y(sample[lane.field]!)} r="2" fill={lane.color}/>)}
          {current && <g pointerEvents="none"><line x1={x(current.timestamp)} x2={x(current.timestamp)} y1={top} y2={top + laneHeight} stroke="var(--gamma-ink)" strokeOpacity=".75" strokeDasharray="2 3"/>{current[lane.field] !== null && <circle cx={x(current.timestamp)} cy={y(current[lane.field]!)} r="4" fill="var(--gamma-surface)" stroke={lane.color} strokeWidth="2"/>}</g>}
        </g>;
      })}
      {ticks.map((tick, index) => <text key={tick} x={x(tick)} y={height - 9} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="orbital-axis">{orbitalUtc(tick, width >= 650)}</text>)}
    </svg>
    {!embedded && inspectionEnabled && <div className="orbital-profile-sample-controls"><button aria-label="Previous profile observation" disabled={currentIndex === 0} onClick={() => selectSample(active.samples[Math.max(0, currentIndex - 1)])}><ChevronLeft size={16}/></button><label>Observation<input type="range" min="0" max={active.samples.length - 1} step="1" value={Math.max(0, currentIndex)} aria-label="Contact profile observation" onChange={event => selectSample(active.samples[Number(event.target.value)])}/></label><button aria-label="Next profile observation" disabled={currentIndex === active.samples.length - 1} onClick={() => selectSample(active.samples[Math.min(active.samples.length - 1, currentIndex + 1)])}><ChevronRight size={16}/></button><output>{current ? `${orbitalUtc(current.timestamp, true)} UTC` : 'Choose a sample'}</output></div>}
    {picker}
    {widget.options?.showLegend !== false && <div className="orbital-legend">{cfg.showEligibleWindows && <span><i style={{ background: C.mint, borderRadius: 1 }}/>Qualifying interval</span>}<span><i className="orbital-profile-unknown-swatch"/>Unresolved signal interval</span><span>Linear between samples · gaps &gt; {cfg.maxGapSeconds}s stay unknown</span></div>}
    {inspectionEnabled && current && <DomainInspector title={`${current.satellite} · ${orbitalUtc(current.timestamp, true)} UTC`} onClose={clearSample} pinned={!!inspection.pinned || timestamp !== undefined}><DetailValues items={[
      ['Elevation', `${value(current.elevation, 2)}°`], ['Link margin', current.margin === null ? 'Unknown' : `${value(current.margin, 2)} dB`], ['Throughput', current.throughput === null ? 'Unknown' : `${value(current.throughput, 2)} Mbps`], ['Planning eligibility', sampleStatus],
      ['Thresholds', `Elevation ≥ ${cfg.minimumElevation}° · margin ≥ ${cfg.minimumMargin} dB`], ['Source observation', current.id],
    ]}/></DomainInspector>}
  </div>;
}

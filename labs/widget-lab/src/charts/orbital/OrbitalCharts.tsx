import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { WidgetRendererProps } from '@insights/widget-registry';
import { worldLandPath } from '@insights/plugins/world-land';
import { useChartTimeWindow, useTimeWindowBrush } from '@insights/chart-window-controls';
import { LabWindowControls } from '../../renderer-extensions/lab-window-controls';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { constrainGeoView, geoToScreen, geoWheelView, INITIAL_GEO_VIEW, panGeoBy, pinchGeo, zoomGeoAt, type GeoPoint, type GeoViewport } from '../geo/geo-viewport';
import { fitEquirectangular } from '../spatial/model';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';
import { budgetSteps, budgetTerms, budgetTotal, contactTimelineConfig, groundPoints, groundTrackConfig, groupByPass, isObstructed, linkBudgetConfig, nearestAt, orbitalDuration, orbitalUtc, skyPoints, skyPosition, skyplotConfig, splitDateline, summarizePasses, type OrbitalPass } from './model';
import './orbital.css';
import { usePassSelection } from './usePassSelection';

const satelliteColor = (satellite: string) => ({ 'AST-07': C.cyan, 'AST-03': C.violet, 'AST-11': C.mint, 'AST-05': C.blue, 'AST-08': C.amber, 'AST-12': C.orange }[satellite] ?? C.cyan);
const stationColor = (station: string) => ({ Hobart: C.cyan, Perth: C.violet, Svalbard: C.mint, Alaska: C.amber }[station] ?? C.muted);
const number = (n: number | null, places = 1) => n === null ? 'Unknown' : n.toLocaleString('en-US', { maximumFractionDigits: places, minimumFractionDigits: places });
const path = (points: { x: number; y: number }[]) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
function localPoint(svg: SVGSVGElement, clientX: number, clientY: number) { const matrix = svg.getScreenCTM(); return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : { x: 0, y: 0 }; }
function Empty({ children = 'No orbital observations in this result.' }: { children?: string }) { return <div className="orbital-empty">{children}</div>; }
function Swatch({ color, children }: { color: string; children: React.ReactNode }) { return <span><i style={{ background: color }}/>{children}</span>; }

function PassPicker({ passes, selected, onSelect, label = 'Inspect orbital pass' }: { passes: { id: string; satellite: string; station: string }[]; selected: string; onSelect: (id: string, target?: HTMLSelectElement) => void; label?: string }) {
  return <label className="orbital-pass-picker">Pass<select aria-label={label} value={selected} onChange={e => onSelect(e.target.value, e.currentTarget)}><option value="">Choose a pass</option>{passes.map(p => <option key={p.id} value={p.id}>{p.satellite} · {p.station} · {p.id.slice(-2)}</option>)}</select></label>;
}

export function OrbitalGroundTrack(props: WidgetRendererProps) {
  const { widget, result, embedded } = props;
  const cfg = useMemo(() => groundTrackConfig.parse(widget.config ?? {}), [widget.config]);
  const points = useMemo(() => groundPoints(result.records), [result]);
  const groups = useMemo(() => groupByPass(points), [points]);
  const choices = useMemo(() => groups.map(g => ({ ...g.points[0], id: g.id, mid: (g.points[0].acquisition + g.points[0].loss) / 2 })), [groups]);
  const selection = usePassSelection(props, cfg.selectedPass, cfg.selectedTimestamp), inspect = !embedded && widget.options?.showTooltip !== false;
  const inspection = useInspection(choices, result, inspect, selection.selected);
  const inspected = inspection.item, linked = choices.find(p => p.id === selection.selected);
  const activeId = inspected?.id ?? selection.selected, active = choices.find(p => p.id === activeId);
  const activePoints = groups.find(g => g.id === activeId)?.points ?? [];
  const marker = active ? nearestAt(activePoints, inspected ? inspected.mid : selection.timestamp ?? active.mid) : undefined;
  const plot = useRef<HTMLDivElement>(null), width = usePlotWidth(plot, 650), height = Math.max(180, Math.round(width / 2)), svg = useRef<SVGSVGElement>(null);
  const entering = useChartEntrance({ disabled: embedded, anchor: plot });
  const [view, setView] = useState(INITIAL_GEO_VIEW), viewRef = useRef<GeoViewport>(view), [touch, setTouch] = useState(false);
  const uid = useId().replaceAll(':', ''), extent = { width, height }, projection = fitEquirectangular({ west: -180, east: 180, north: 90, south: -90 }, width, height);
  const dragging = useRef<{ id: number; start: GeoPoint; view: GeoViewport; passId: string | null; moved: boolean } | null>(null);
  const touches = useRef(new Map<number, GeoPoint>()), pinch = useRef<{ view: GeoViewport; points: [GeoPoint, GeoPoint] } | null>(null);
  const update = (candidate: GeoViewport) => { viewRef.current = constrainGeoView(candidate, extent); setView(viewRef.current); };
  const clear = inspection.dismiss;
  const choose = (id: string, target?: HTMLElement | SVGElement) => { if (!inspect) return; const p = choices.find(row => row.id === id); if (!p) { selection.choose(''); inspection.dismiss(); return; } inspection.select(p.id, target ?? svg.current ?? undefined); selection.choose(id, p.mid); };
  useEffect(() => { update(viewRef.current); }, [width, height]);
  useEffect(() => {
    const element = svg.current; if (!element || embedded) return;
    const wheel = (event: WheelEvent) => { const p = localPoint(element, event.clientX, event.clientY); const next = geoWheelView(viewRef.current, event, p, extent); if (next) { event.preventDefault(); update(next); } };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, [width, height, embedded]);
  const cancel = (id?: number) => { if (id !== undefined) touches.current.delete(id); else touches.current.clear(); dragging.current = null; pinch.current = null; };
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (embedded || event.button !== 0 || event.pointerType === 'touch' && !touch) return;
    const p = localPoint(event.currentTarget, event.clientX, event.clientY); touches.current.set(event.pointerId, p); event.currentTarget.setPointerCapture(event.pointerId);
    if (touches.current.size === 2) { pinch.current = { view: viewRef.current, points: [...touches.current.values()] as [GeoPoint, GeoPoint] }; dragging.current = null; return; }
    dragging.current = { id: event.pointerId, start: p, view: viewRef.current, passId: (event.target as Element).closest('[data-pass-id]')?.getAttribute('data-pass-id') ?? null, moved: false };
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const p = localPoint(event.currentTarget, event.clientX, event.clientY); if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, p);
    if (pinch.current && touches.current.size === 2) { update(pinchGeo(pinch.current.view, pinch.current.points, [...touches.current.values()] as [GeoPoint, GeoPoint], extent)); return; }
    const drag = dragging.current; if (!drag || drag.id !== event.pointerId) return;
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
    if (drag.moved) { inspection.setHover(null); update(panGeoBy(drag.view, { x: p.x - drag.start.x, y: p.y - drag.start.y }, extent)); }
  };
  const up = (event: PointerEvent<SVGSVGElement>) => { const drag = dragging.current; cancel(event.pointerId); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (drag && !drag.moved && drag.passId) choose(drag.passId, event.currentTarget); };
  const zoom = (factor: number) => update(zoomGeoAt(viewRef.current, factor, { x: width / 2, y: height / 2 }, extent));
  const project = (lon: number, lat: number) => geoToScreen(projection.project(lon, lat), view);
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    if (embedded) return;
    if (event.key === 'Escape' && (inspection.item || dragging.current || pinch.current)) { event.preventDefault(); event.stopPropagation(); cancel(); clear(); return; }
    if (event.target !== event.currentTarget) return;
    const directions: Record<string, GeoPoint> = { ArrowLeft: { x: 45, y: 0 }, ArrowRight: { x: -45, y: 0 }, ArrowUp: { x: 0, y: 45 }, ArrowDown: { x: 0, y: -45 } };
    if (directions[event.key]) { event.preventDefault(); update(panGeoBy(viewRef.current, directions[event.key], extent)); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.4); }
    else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.4); }
    else if (event.key === 'Home') { event.preventDefault(); update(INITIAL_GEO_VIEW); }
  };
  if (!points.length) return <Empty/>;
  const stations = [...new Map(choices.map(p => [p.station, p])).values()];
  return <div className="orbital-chart" data-orbital-map data-map-zoom={view.k} onPointerLeave={() => inspection.setHover(null)} onKeyDown={event => { if (event.key === 'Escape' && (inspection.item || dragging.current || pinch.current)) { event.preventDefault(); event.stopPropagation(); cancel(); clear(); } }}>
    <div className="orbital-map-layout">
      <div className="orbital-map-main" ref={plot} data-chart-entering={entering || undefined}>
        <svg ref={svg} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Orbital ground tracks. Scroll to zoom, arrows pan, plus or minus zoom, Home resets." tabIndex={embedded ? undefined : 0} onKeyDown={key} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={e => cancel(e.pointerId)} onLostPointerCapture={e => cancel(e.pointerId)} style={{ touchAction: touch ? 'none' : 'pan-y' }}>
          <defs><clipPath id={`${uid}-world`}><rect width={width} height={height}/></clipPath></defs>
          <rect className="orbital-ocean" width={width} height={height}/>
          <g clipPath={`url(#${uid}-world)`}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <path d={worldLandPath} transform={projection.landTransform} className="orbital-land" vectorEffect="non-scaling-stroke"/>
              {cfg.showGraticule && [-120, -60, 0, 60, 120].map(lon => { const p = projection.project(lon, 90); return <line key={lon} x1={p.x} x2={p.x} y1="0" y2={height} className="orbital-grid" vectorEffect="non-scaling-stroke"/>; })}
              {cfg.showGraticule && [-60, -30, 0, 30, 60].map(lat => { const p = projection.project(0, lat); return <line key={lat} x1="0" x2={width} y1={p.y} y2={p.y} className="orbital-grid" vectorEffect="non-scaling-stroke"/>; })}
            </g>
            <g className={chartEntrance.revealMarks}>{[...groups].sort((a, b) => Number(a.id === activeId) - Number(b.id === activeId)).map(group => <g key={group.id} data-pass-id={group.id} role={inspect ? 'button' : undefined} tabIndex={inspect ? 0 : undefined} aria-label={`Inspect ground track ${group.points[0].satellite} at ${group.points[0].station}`} aria-pressed={inspect ? selection.selected === group.id : undefined} opacity={!activeId || group.id === activeId ? 1 : .33} onFocus={() => inspection.setHover(group.id)} onBlur={() => inspection.setHover(null)} onPointerEnter={() => { if (!dragging.current) inspection.setHover(group.id); }} onPointerLeave={() => inspection.setHover(null)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(group.id, event.currentTarget); } }}>
              {group.points.slice(1).map((p, i) => splitDateline([group.points[i], p]).map((segment, j) => <g key={`${p.id}-${j}`}><path d={path(segment.map(v => project(v.longitude, v.latitude)))} fill="none" stroke={cfg.showEclipse && p.eclipse ? C.muted : satelliteColor(p.satellite)} strokeWidth={group.id === activeId ? 2 : 1.1} strokeDasharray={cfg.showEclipse && p.eclipse ? '2 4' : p.phase === 'predicted' ? '5 4' : undefined}/>{inspect && <path d={path(segment.map(v => project(v.longitude, v.latitude)))} fill="none" stroke="transparent" strokeWidth="15"/>}</g>))}
            </g>)}</g>
            {stations.map(p => { const position = project(p.stationLon, p.stationLat); return <g key={p.station} pointerEvents="none"><circle cx={position.x} cy={position.y} r="4" fill={stationColor(p.station)} stroke="var(--gamma-surface)" strokeWidth="1.5"/>{cfg.showLabels && <text x={Math.min(width - 60, position.x + 8)} y={Math.max(14, position.y - 7)} className="orbital-map-label">{p.station}</text>}</g>; })}
            {marker && <g pointerEvents="none" transform={`translate(${project(marker.longitude, marker.latitude).x} ${project(marker.longitude, marker.latitude).y})`}><circle r="9" fill="none" stroke={C.cyan} strokeWidth="1"/><path d="M0,-5L5,0L0,5L-5,0Z" fill={C.cyan} stroke="var(--gamma-ink)" strokeWidth="1"/></g>}
          </g>
          {cfg.showGraticule && [-120, -60, 0, 60, 120].map(lon => <text key={lon} x={project(lon, 0).x} y={height - 6} textAnchor="middle" className="orbital-axis">{Math.abs(lon)}°{lon < 0 ? 'W' : lon > 0 ? 'E' : ''}</text>)}
        </svg>
        {!embedded && <div className="orbital-map-tools"><button aria-label="Zoom in orbital map" onClick={() => zoom(1.5)} disabled={view.k >= 8}><Plus size={15}/></button><button aria-label="Zoom out orbital map" onClick={() => zoom(1 / 1.5)} disabled={view.k <= 1}><Minus size={15}/></button><button aria-label="Reset orbital map" onClick={() => { cancel(); update(INITIAL_GEO_VIEW); setTouch(false); }}><RotateCcw size={14}/><span>Fit</span></button><span>{view.k.toFixed(1)}×</span><button aria-pressed={touch} onClick={() => { cancel(); setTouch(v => !v); }}>Touch {touch ? 'on' : 'off'}</button>{view.k > 1 && <span className="orbital-pan">{([['←', 50, 0, 'west'], ['↑', 0, 50, 'north'], ['↓', 0, -50, 'south'], ['→', -50, 0, 'east']] as const).map(([label, x, y, direction]) => <button key={direction} aria-label={`Pan orbital map ${direction}`} onClick={() => update(panGeoBy(viewRef.current, { x, y }, extent))}>{label}</button>)}</span>}</div>}
      </div>
      {!embedded && <aside className="orbital-map-evidence"><div className="orbital-evidence-hint"><strong>{linked ? `${linked.satellite} / ${linked.station}` : 'Inspect a contact'}</strong><p>Select a track to link the station skyplot, contact window and margin budget.</p>{linked && <DetailValues items={[
        ['Acquisition', `${orbitalUtc(linked.acquisition, true)} UTC`], ['Loss', `${orbitalUtc(linked.loss, true)} UTC`], ['Duration', orbitalDuration(linked.loss - linked.acquisition)],
      ]}/>}</div></aside>}
    </div>
    {inspect && inspected && active && <DomainInspector title={`${active.satellite} / ${active.station}`} onClose={clear} pinned={!!inspection.pinned}><DetailValues items={[
        ['Acquisition', `${orbitalUtc(active.acquisition, true)} UTC`], ['Loss', `${orbitalUtc(active.loss, true)} UTC`], ['Duration', orbitalDuration(active.loss - active.acquisition)], ['Track sample', marker ? `${orbitalUtc(marker.timestamp, true)} UTC` : 'Unknown'], ['Altitude', marker ? `${number(marker.altitude)} km` : 'Unknown'], ['Coordinates', marker ? `${number(marker.latitude, 2)}°, ${number(marker.longitude, 2)}°` : 'Unknown'], ['Illumination', marker?.eclipse ? 'Eclipse segment' : 'Sunlit segment'],
      ]}/></DomainInspector>}
    {!embedded && inspect && cfg.showPassPicker && <PassPicker passes={choices} selected={selection.selected} onSelect={choose}/>}
    {widget.options?.showLegend !== false && <div className="orbital-legend"><Swatch color={C.cyan}>Selected track</Swatch><span>━━ Past</span><span>┄┄ Predicted</span>{cfg.showEclipse && <span>··· Eclipse</span>}<span>Synthetic trajectories · scroll to zoom</span></div>}
  </div>;
}

export function OrbitalSkyplot(props: WidgetRendererProps) {
  const { widget, result, embedded } = props, cfg = useMemo(() => skyplotConfig.parse(widget.config ?? {}), [widget.config]);
  const points = useMemo(() => skyPoints(result.records), [result]), passes = useMemo(() => summarizePasses(points), [points]);
  const selection = usePassSelection(props, cfg.selectedPass ?? passes[0]?.id, cfg.selectedTimestamp), selected = passes.find(p => p.id === selection.selected), inspect = !embedded && widget.options?.showTooltip !== false;
  const station = selected?.station, shown = passes.filter(p => !station || p.station === station), ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 380), svg = useRef<SVGSVGElement>(null);
  const entering = useChartEntrance({ disabled: embedded, anchor: ref });
  const side = Math.min(width, 300), cx = width / 2, cy = side / 2 + 7, radius = side / 2 - 35, height = side + 14;
  const inspection = useInspection(points, result, inspect, selection.selected, point => point.passId), current = inspection.item;
  const linkedSample = selected ? nearestAt(selected.samples, selection.timestamp ?? (selected.start + selected.end) / 2) : undefined, marker = current ?? linkedSample;
  const choose = (id: string, timestamp?: number, target?: HTMLElement | SVGElement) => { if (!inspect) return; const pass = passes.find(row => row.id === id), sample = pass ? nearestAt(pass.samples, timestamp ?? (pass.start + pass.end) / 2) : undefined; if (!sample) { selection.choose(''); inspection.dismiss(); return; } inspection.select(sample.id, target ?? svg.current ?? undefined); selection.choose(id, sample.timestamp); };
  const clear = inspection.dismiss;
  const toPoint = (azimuth: number, elevation: number) => { const p = skyPosition(azimuth, elevation, radius); return { x: cx + p.x, y: cy + p.y }; };
  const maskOuter = Array.from({ length: 16 }, (_, i) => toPoint(120 + i * 3, 0)), maskInner = Array.from({ length: 16 }, (_, i) => toPoint(165 - i * 3, 18));
  const onPointer = (event: PointerEvent<SVGSVGElement>, pin = false) => {
    if (!inspect) return;
    const local = localPoint(event.currentTarget, event.clientX, event.clientY), candidates = shown.flatMap(p => p.samples);
    const nearest = candidates.reduce<{ id: string; d: number } | null>((best, p) => { const point = toPoint(p.azimuth, p.elevation), d = Math.hypot(point.x - local.x, point.y - local.y); return !best || d < best.d ? { id: p.id, d } : best; }, null);
    if (!nearest || nearest.d > 22) { inspection.setHover(null); return; }
    const p = points.find(sample => sample.id === nearest.id)!;
    if (pin) choose(p.passId, p.timestamp, event.currentTarget); else inspection.setHover(p.id);
  };
  if (!points.length) return <Empty/>;
  if (!selected) return <div className="orbital-chart" ref={ref}><Empty>Select a contact to inspect its station skyplot.</Empty>{!embedded && inspect && cfg.showPassPicker && <PassPicker passes={passes} selected="" onSelect={id => choose(id)} label="Select skyplot pass"/>}</div>;
  return <div className="orbital-chart orbital-skyplot" ref={ref} data-chart-entering={entering || undefined} onKeyDown={event => { if (event.key === 'Escape' && (current || inspection.pinned)) { event.preventDefault(); event.stopPropagation(); clear(); } }}>
    <div className="orbital-plot-context"><strong>{station ?? 'All stations'}</strong><span>Predicted access · azimuth / elevation</span></div>
    <svg ref={svg} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${station ?? 'All stations'} polar skyplot. North is zero azimuth. Zenith is the centre.`} tabIndex={inspect ? 0 : undefined} onPointerMove={event => onPointer(event)} onPointerLeave={() => inspection.setHover(null)} onClick={event => onPointer(event as unknown as PointerEvent<SVGSVGElement>, true)} onKeyDown={event => {
      if (!inspect || !selected || event.target !== event.currentTarget) return;
      const index = Math.max(0, selected.samples.findIndex(p => p.id === marker?.id));
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const sample = selected.samples[Math.max(0, Math.min(selected.samples.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))]; if (inspection.pinned) choose(selected.id, sample.timestamp, event.currentTarget); else inspection.setHover(sample.id); } else if ((event.key === 'Enter' || event.key === ' ') && marker) { event.preventDefault(); choose(marker.passId, marker.timestamp, event.currentTarget); }
    }} onBlur={() => inspection.setHover(null)}>
            {[0, 30, 60].map(elevation => <circle key={elevation} cx={cx} cy={cy} r={radius * (90 - elevation) / 90} className="orbital-grid" fill="none"/>)}
      {Array.from({ length: 12 }, (_, i) => i * 30).map(angle => { const p = toPoint(angle, 0); return <line key={angle} x1={cx} y1={cy} x2={p.x} y2={p.y} className="orbital-grid"/>; })}
      {cfg.showMask && <path d={`${path([...maskOuter, ...maskInner])}Z`} fill="var(--gamma-muted)" fillOpacity=".2" stroke={C.muted} strokeDasharray="3 4"/>}
      {([['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const).map(([name, angle]) => { const p = skyPosition(angle, 0, radius + 21); return <text key={name} x={cx + p.x} y={cy + p.y + 4} textAnchor="middle" className="orbital-axis">{name} {angle}°</text>; })}
      {[0, 30, 60, 90].map(elevation => { const p = toPoint(38, elevation); return <text key={elevation} x={p.x + 5} y={p.y - 3} className="orbital-axis">{elevation}°</text>; })}
      <g className={chartEntrance.revealMarks}>{shown.map(pass => <g key={pass.id} role={inspect ? 'button' : undefined} tabIndex={inspect ? 0 : undefined} aria-label={`Inspect sky pass ${pass.satellite} ${orbitalUtc(pass.start)} UTC`} aria-pressed={inspect ? selection.selected === pass.id : undefined} onFocus={() => { const sample = nearestAt(pass.samples, (pass.start + pass.end) / 2); if (sample) inspection.setHover(sample.id); }} onBlur={() => inspection.setHover(null)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(pass.id, undefined, event.currentTarget); } }} onClick={event => { event.stopPropagation(); if (svg.current) onPointer({ currentTarget: svg.current, clientX: event.clientX, clientY: event.clientY } as PointerEvent<SVGSVGElement>, true); }}>
        <path d={path(pass.samples.map(p => toPoint(p.azimuth, p.elevation)))} fill="none" stroke={satelliteColor(pass.satellite)} strokeWidth={pass.id === selection.selected ? 2.1 : 1.2} opacity={!selected || pass.id === selected.id ? 1 : .65}/>
        {inspect && <path d={path(pass.samples.map(p => toPoint(p.azimuth, p.elevation)))} fill="none" stroke="transparent" strokeWidth="12"/>}
        {pass.samples.filter((_, i) => i % 5 === 0).map((p, i) => { const position = toPoint(p.azimuth, p.elevation); return <g key={p.id} pointerEvents="none"><circle cx={position.x} cy={position.y} r="2.2" fill={satelliteColor(p.satellite)}/>{cfg.showTimeLabels && pass.id === selection.selected && i % 2 === 0 && <text x={position.x + 7} y={position.y - 6} className="orbital-axis" fill={satelliteColor(p.satellite)}>{orbitalUtc(p.timestamp)}</text>}</g>; })}
      </g>)}</g>
      {marker && <g pointerEvents="none"><circle cx={toPoint(marker.azimuth, marker.elevation).x} cy={toPoint(marker.azimuth, marker.elevation).y} r="5" fill="var(--gamma-surface)" stroke={C.cyan} strokeWidth="2"/></g>}
    </svg>
    {!embedded && inspect && cfg.showPassPicker && <PassPicker passes={passes} selected={selection.selected} onSelect={id => choose(id)} label="Select skyplot pass"/>}
    {!embedded && inspect && selected && <label className="orbital-sample-slider">Observation<input type="range" min="0" max={selected.samples.length - 1} step="1" aria-label="Skyplot observation" value={Math.max(0, selected.samples.findIndex(p => p.id === marker?.id))} onChange={event => choose(selected.id, selected.samples[Number(event.target.value)].timestamp)}/><span>{marker ? orbitalUtc(marker.timestamp, true) : '—'} UTC</span></label>}
    {inspect && current && <DomainInspector title={`${current.satellite} · ${orbitalUtc(current.timestamp, true)} UTC`} onClose={clear} pinned={!!inspection.pinned}><DetailValues items={[
      ['Azimuth', `${number(current.azimuth)}°`], ['Elevation', `${number(current.elevation)}°`], ['Link margin', `${number(current.margin)} dB`], ['Mask', isObstructed(current.azimuth, current.elevation) ? 'Inside illustrative obstruction' : 'Clear of illustrative obstruction'],
    ]}/></DomainInspector>}
    {widget.options?.showLegend !== false && <div className="orbital-legend">{shown.map(p => <Swatch key={p.id} color={satelliteColor(p.satellite)}>{p.satellite} · {orbitalUtc(p.start)}</Swatch>)}{cfg.showMask && <span><i style={{ background: 'var(--gamma-muted)', opacity: .3 }}/>Shaded: illustrative horizon mask</span>}</div>}
  </div>;
}

export function OrbitalContactTimeline(props: WidgetRendererProps) {
  const { widget, result, embedded } = props, cfg = useMemo(() => contactTimelineConfig.parse(widget.config ?? {}), [widget.config]);
  const points = useMemo(() => skyPoints(result.records), [result]), passes = useMemo(() => summarizePasses(points), [points]);
  const selection = usePassSelection(props, cfg.selectedPass, cfg.selectedTimestamp), selected = passes.find(p => p.id === selection.selected), inspect = !embedded && widget.options?.showTooltip !== false;
  const inspection = useInspection(passes, result, inspect, selection.selected), inspected = inspection.item;
  const ref = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), width = usePlotWidth(ref, 800), uid = useId().replaceAll(':', '');
  const entering = useChartEntrance({ disabled: embedded, anchor: ref });
  const extent = passes.length ? { start: Math.floor(Math.min(...passes.map(p => p.start)) / 3600000) * 3600000, end: Math.ceil(Math.max(...passes.map(p => p.end)) / 3600000) * 3600000 } : null;
  const windowState = useChartTimeWindow(extent, result, 30000), window = windowState.window;
  const rows = [...new Set(passes.map(p => p.satellite))], left = 66, right = 18, plotWidth = Math.max(1, width - left - right), top = 27, rowHeight = 27, lanesBottom = top + rows.length * rowHeight;
  const signalHeight = 66, signalGap = 29, marginTop = lanesBottom + 32, throughputTop = marginTop + signalHeight + signalGap, height = cfg.showSignals ? throughputTop + signalHeight + 25 : lanesBottom + 28;
  const x = (timestamp: number) => left + (timestamp - window.start) / (window.end - window.start) * plotWidth;
  const yMargin = (value: number) => marginTop + signalHeight - (value + 5) / 25 * signalHeight, yThroughput = (value: number) => throughputTop + signalHeight - value / 60 * signalHeight;
  const brush = useTimeWindowBrush({ enabled: !embedded && windowState.enabled, revision: result, window, point: (clientX, clientY) => { if (!svg.current) return null; const p = localPoint(svg.current, clientX, clientY); return { x: Math.max(left, Math.min(width - right, p.x)), y: p.y, timestamp: window.start + Math.max(0, Math.min(1, (p.x - left) / plotWidth)) * (window.end - window.start), inPlot: p.x >= left && p.x <= width - right && p.y >= top && p.y <= height - 20 }; }, commit: windowState.commit, onStart: () => {} });
  const choose = (pass: OrbitalPass, target?: HTMLElement | SVGElement) => { if (!inspect) return; inspection.select(pass.id, target ?? svg.current ?? undefined); selection.choose(pass.id, (pass.start + pass.end) / 2); };
  const clear = inspection.dismiss;
  const observed = selected ? nearestAt(selected.samples, selection.timestamp ?? (selected.start + selected.end) / 2) : undefined;
  const tickCount = width < 470 ? 4 : 7, ticks = Array.from({ length: tickCount }, (_, i) => window.start + i * (window.end - window.start) / (tickCount - 1));
  const signalPath = (samples: typeof points, field: 'margin' | 'throughput', y: (n: number) => number) => { let open = false; return samples.map(p => { if (p[field] === null) { open = false; return ''; } const d = `${open ? 'L' : 'M'}${x(p.timestamp)},${y(p[field]!)}`; open = true; return d; }).join(' '); };
  if (!points.length) return <Empty/>;
  return <div className="orbital-chart orbital-timeline" ref={ref} data-chart-entering={entering || undefined} onKeyDown={event => { if (event.key === 'Escape' && inspection.item && !brush.active) { event.preventDefault(); event.stopPropagation(); clear(); } }}>
    <div className="orbital-brush-host" {...brush.handlers}>
      <svg ref={svg} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} tabIndex={inspect ? 0 : undefined} role="img" aria-label="Predicted contact intervals and linked link-margin and throughput tracks. Drag horizontally to zoom this chart.">
        <defs><clipPath id={`${uid}-time`}><rect x={left} y={top} width={plotWidth} height={height - top - 18}/></clipPath><PlotHatchDefs id={uid}/></defs>
        {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={top} y2={height - 24} className="orbital-grid"/><text x={x(t)} y="16" textAnchor="middle" className="orbital-axis">{orbitalUtc(t)}</text><text x={x(t)} y={height - 4} textAnchor="middle" className="orbital-axis">{orbitalUtc(t)}</text></g>)}
        {rows.map((satellite, i) => <g key={satellite}><text x={left - 8} y={top + i * rowHeight + 17} textAnchor="end" className="orbital-axis">{satellite}</text><line x1={left} x2={width - right} y1={top + (i + 1) * rowHeight} y2={top + (i + 1) * rowHeight} className="orbital-grid"/></g>)}
        <g clipPath={`url(#${uid}-time)`}><g className={chartEntrance.revealMarks}>
          {passes.map(p => <g key={p.id} role={inspect ? 'button' : undefined} tabIndex={inspect ? 0 : undefined} aria-label={`Select contact ${p.satellite} at ${p.station}, ${orbitalUtc(p.start)} UTC`} aria-pressed={inspect ? selection.selected === p.id : undefined} onPointerEnter={() => inspection.setHover(p.id)} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(p.id)} onBlur={() => inspection.setHover(null)} onClick={event => choose(p, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(p, event.currentTarget); } }}>
            <rect x={x(p.start)} y={top + rows.indexOf(p.satellite) * rowHeight + 5} width={Math.max(1, x(p.end) - x(p.start))} height="17" rx="1" fill={stationColor(p.station)} opacity={!selection.selected || selection.selected === p.id ? .95 : .5} stroke={selection.selected === p.id ? 'var(--gamma-ink)' : 'none'} strokeWidth="1.5"/>
            {inspect && <rect x={x(p.start) - 3} y={top + rows.indexOf(p.satellite) * rowHeight} width={Math.max(20, x(p.end) - x(p.start) + 6)} height={rowHeight} fill="transparent"/>}
          </g>)}
          {selected && <rect pointerEvents="none" x={x(selected.start)} y={top} width={x(selected.end) - x(selected.start)} height={height - top - 24} fill={C.cyan} opacity=".06" stroke={C.cyan} strokeWidth="1"/>}
          {cfg.showSignals && passes.map(p => <g key={p.id} pointerEvents="none" opacity={!selected || p.id === selected.id ? 1 : .22}>
            {cfg.showUncertainty && p.samples.slice(1).map((b, i) => { const a = p.samples[i]; if (a.margin === null || b.margin === null) return null; return <path key={b.id} d={`M${x(a.timestamp)},${yMargin(a.margin + a.uncertainty)}L${x(b.timestamp)},${yMargin(b.margin + b.uncertainty)}L${x(b.timestamp)},${yMargin(b.margin - b.uncertainty)}L${x(a.timestamp)},${yMargin(a.margin - a.uncertainty)}Z`} fill={C.cyan} opacity=".13"/>; })}
            <path d={signalPath(p.samples, 'margin', yMargin)} fill="none" stroke={C.cyan} strokeWidth="1.6"/>
            <path d={signalPath(p.samples, 'throughput', yThroughput)} fill="none" stroke={C.violet} strokeWidth="1.6"/>
            {p.samples.filter(sample => sample.margin === null).map(sample => <rect key={sample.id} x={x(sample.timestamp) - 2} y={marginTop} width="4" height={signalHeight} fill={plotHatchFill(uid)}/>)}
          </g>)}
          {observed && cfg.showSignals && <g pointerEvents="none"><line x1={x(observed.timestamp)} x2={x(observed.timestamp)} y1={top} y2={height - 24} stroke={C.cyan} strokeDasharray="3 4"/>{observed.margin !== null && <circle cx={x(observed.timestamp)} cy={yMargin(observed.margin)} r="3.5" fill={C.cyan} stroke="var(--gamma-ink)"/>}{observed.throughput !== null && <circle cx={x(observed.timestamp)} cy={yThroughput(observed.throughput)} r="3.5" fill={C.violet} stroke="var(--gamma-ink)"/>}</g>}
        </g></g>
        {cfg.showSignals && <>
          <text x={left} y={marginTop - 10} className="orbital-axis">Link margin · dB</text><text x={left} y={throughputTop - 10} className="orbital-axis">Predicted throughput · Mbps</text>
          {[-5, 0, 10, 20].map(v => <g key={v}><line x1={left} x2={width - right} y1={yMargin(v)} y2={yMargin(v)} className={v === 0 ? 'orbital-zero' : 'orbital-grid'}/><text x={left - 8} y={yMargin(v) + 4} textAnchor="end" className="orbital-axis">{v}</text></g>)}
          {[0, 30, 60].map(v => <g key={v}><line x1={left} x2={width - right} y1={yThroughput(v)} y2={yThroughput(v)} className="orbital-grid"/><text x={left - 8} y={yThroughput(v) + 4} textAnchor="end" className="orbital-axis">{v}</text></g>)}
        </>}
        {brush.preview && <rect pointerEvents="none" x={Math.min(brush.preview.x1, brush.preview.x2)} y={top} width={Math.abs(brush.preview.x2 - brush.preview.x1)} height={height - top - 20} fill={C.cyan} fillOpacity=".15" stroke={C.cyan}/>} 
      </svg>
    </div>
    {!embedded && <div className="orbital-timeline-tools"><LabWindowControls state={windowState} description="Zoom changes only contact and signal plot bounds. Selected pass, predicted totals and other panels retain their source scope."/>{selected && <button onClick={() => windowState.commit({ start: Math.max(windowState.full.start, selected.start - 60000), end: Math.min(windowState.full.end, selected.end + 60000) })}>Focus selected pass</button>}</div>}
    {!embedded && inspect && cfg.showPassPicker && <PassPicker passes={passes} selected={selection.selected} onSelect={(id, target) => { const p = passes.find(pass => pass.id === id); if (p) choose(p, target); else { selection.choose(''); clear(); } }} label="Select contact interval"/>}
    {widget.options?.showLegend !== false && <div className="orbital-legend">{[...new Set(passes.map(p => p.station))].map(station => <Swatch key={station} color={stationColor(station)}>{station}</Swatch>)}<span>Signals exist only during predicted contacts</span>{cfg.showUncertainty && <span>Band: supplied margin uncertainty ±1σ</span>}</div>}
    {inspect && inspected && <DomainInspector title={`${inspected.satellite} / ${inspected.station} · predicted contact`} onClose={clear} pinned={!!inspection.pinned}><DetailValues items={[
      ['UTC interval', `${orbitalUtc(inspected.start, true)} – ${orbitalUtc(inspected.end, true)}`], ['Duration', orbitalDuration(inspected.end - inspected.start)], ['Minimum margin', `${number(inspected.minMargin)} dB`], ['Predicted volume', inspected.volumeMB === null ? 'Unknown · incomplete samples' : `${number(inspected.volumeMB / 1000, 2)} GB`], ['Signal coverage', `${number(inspected.coverage * 100)}%`],
    ]}/></DomainInspector>}
  </div>;
}

export function OrbitalLinkBudget(props: WidgetRendererProps) {
  const { widget, result, embedded } = props, cfg = useMemo(() => linkBudgetConfig.parse(widget.config ?? {}), [widget.config]);
  const terms = useMemo(() => budgetTerms(result.records), [result]), groups = useMemo(() => groupByPass(terms), [terms]), selection = usePassSelection(props, cfg.selectedPass);
  const passId = selection.selected || (cfg.selectedPass === undefined && groups[0]?.id) || '', chosen = terms.filter(p => p.passId === passId), steps = budgetSteps(chosen), total = budgetTotal(chosen);
  const inspect = !embedded && widget.options?.showTooltip !== false, inspection = useInspection(steps, result, inspect, passId);
  const ref = useRef<HTMLDivElement>(null), width = usePlotWidth(ref, 450), height = 265, left = 39, right = 12, top = 25, bottom = 60;
  const entering = useChartEntrance({ disabled: embedded, anchor: ref });
  const min = Math.min(0, ...steps.flatMap(p => [p.start, p.end]), total) - 1, max = Math.max(1, ...steps.flatMap(p => [p.start, p.end]), total) + 2;
  const y = (value: number) => top + (max - value) / (max - min) * (height - top - bottom), slot = (width - left - right) / Math.max(1, steps.length + 1), barWidth = Math.max(12, slot - 10);
  if (!terms.length) return <Empty/>;
  if (!chosen.length) return <Empty>Select a contact to inspect its link margin budget.</Empty>;
  return <div className="orbital-chart orbital-budget" ref={ref} data-chart-entering={entering || undefined} onKeyDown={inspection.onKeyDown}>
    <div className="orbital-plot-context"><span>Relative margin · dB</span><strong>{number(total)} dB</strong></div>
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Relative link margin waterfall. Total ${number(total)} decibels.`}>
      {Array.from({ length: 5 }, (_, i) => min + i * (max - min) / 4).map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="orbital-grid"/><text x={left - 8} y={y(value) + 4} textAnchor="end" className="orbital-axis">{number(value, 0)}</text></g>)}
      <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} className="orbital-zero"/>
      {steps.map((step, i) => { const x = left + slot * i + 5, active = inspection.item?.id === step.id; return <g key={step.id} role={inspect ? 'button' : undefined} tabIndex={inspect ? 0 : undefined} aria-label={`${step.label}: ${step.value >= 0 ? '+' : ''}${number(step.value)} dB; cumulative ${number(step.end)} dB`} onFocus={() => inspection.setHover(step.id)} onBlur={() => inspection.setHover(null)} onPointerEnter={() => inspection.setHover(step.id)} onPointerLeave={() => inspection.setHover(null)} onClick={event => inspection.select(step.id, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspection.select(step.id, event.currentTarget); } }}>
        <g className={chartEntrance.revealMarks}><rect x={x} y={y(Math.max(step.start, step.end))} width={barWidth} height={Math.max(1, Math.abs(y(step.start) - y(step.end)))} fill={i === 0 ? C.cyan : step.value >= 0 ? C.mint : C.amber} stroke={active ? 'var(--gamma-ink)' : 'none'} strokeWidth="1.5"/>
        <line x1={x + barWidth} x2={x + slot} y1={y(step.end)} y2={y(step.end)} stroke={C.muted} strokeDasharray="3 3"/></g>
        {cfg.showValues && <text x={x + barWidth / 2} y={y(Math.max(step.start, step.end)) - 7} textAnchor="middle" className="orbital-value">{step.value > 0 ? '+' : ''}{number(step.value)}</text>}
        <text x={x + barWidth / 2} y={height - bottom + 20} textAnchor="middle" className="orbital-axis">{(width < 400 ? step.label.replace('Interference','Interf.').replace('Reference','Ref.') : step.label).split(' ').map((word, j) => <tspan key={word} x={x + barWidth / 2} dy={j ? 15 : 0}>{word}</tspan>)}</text>
      </g>; })}
      <g><g className={chartEntrance.revealMarks}><rect x={left + slot * steps.length + 5} y={y(Math.max(0, total))} width={barWidth} height={Math.abs(y(total) - y(0))} fill={C.blue}/></g>{cfg.showValues && <text x={left + slot * steps.length + 5 + barWidth / 2} y={y(Math.max(0, total)) - 7} textAnchor="middle" className="orbital-value">{number(total)}</text>}<text x={left + slot * steps.length + 5 + barWidth / 2} y={height - bottom + 20} textAnchor="middle" className="orbital-axis">Margin</text></g>
    </svg>
    {inspect && inspection.item && <DomainInspector title={inspection.item.label} onClose={inspection.dismiss} pinned={!!inspection.pinned}><DetailValues items={[
      ['Contribution', `${inspection.item.value >= 0 ? '+' : ''}${number(inspection.item.value)} dB`], ['Before', `${number(inspection.item.start)} dB`], ['After', `${number(inspection.item.end)} dB`], ['Pass', passId],
    ]}/></DomainInspector>}
    {widget.options?.showLegend !== false && <div className="orbital-legend"><Swatch color={C.mint}>Gain</Swatch><Swatch color={C.amber}>Loss</Swatch><Swatch color={C.blue}>Final margin</Swatch></div>}
  </div>;
}

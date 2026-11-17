import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus, RotateCcw } from 'lucide-react';
import { scaleLinear } from 'd3-scale';
import type { WidgetRendererProps } from '@insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { constrainGeoView, geoToScreen, geoWheelView, INITIAL_GEO_VIEW, panGeoBy, pinchGeo, revealGeoPoint, zoomGeoAt, type GeoPoint, type GeoViewport } from '../geo/geo-viewport';
import { BIN_LABEL, DIE_BINS, filterDies, summarizeWafer, waferFocusId, waferKeyboardTarget, waferMapConfig, waferRows, type WaferDie } from './model';
import './wafer.css';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import hatchStyles from '@insights/plot-hatch.module.css';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

export const WAFER_COLORS = { pass: C.cyan, leakage: C.red, timing: C.amber, open: C.violet, untested: C.muted, excluded: 'var(--gamma-border)' };
export const waferNumber = (value: number | null, decimals = 2) => value === null ? 'Unavailable' : value.toLocaleString('en-US', { maximumFractionDigits: decimals });
export const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
export const dieLabel = (d: WaferDie) => `Column ${signed(d.column)}, row ${signed(d.row)} · ${BIN_LABEL[d.bin]}`;
export function leakageColor(value: number | null) {
  if (value === null) return C.muted;
  const position = Math.max(0, Math.min(1, (Math.log10(Math.max(.1, value)) + 1) / Math.log10(1500)));
  return `color-mix(in srgb, ${C.red} ${position * 100}%, ${C.cyan})`;
}

/** A discrete physical map; the existing bounded geographic camera supplies presentation-only transforms. */
export function WaferDieMap({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const cfg = useMemo(() => waferMapConfig.parse(widget.config ?? {}), [widget.config]);
  const dies = useMemo(() => waferRows(result.records), [result]);
  const visible = useMemo(() => filterDies(dies, cfg.filter), [dies, cfg.filter]);
  const plot = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), width = usePlotWidth(plot, 560);
  const entering = useChartEntrance({ anchor: plot });
  const height = Math.min(490, Math.max(300, width * .94));
  const pad = { left: cfg.showCoordinates ? 43 : 14, right: 14, top: 13, bottom: cfg.showCoordinates ? 37 : 14 };
  const board = Math.max(180, Math.min(width - pad.left - pad.right, height - pad.top - pad.bottom));
  const cx = pad.left + (width - pad.left - pad.right) / 2, cy = pad.top + (height - pad.top - pad.bottom) / 2;
  const diameter = dies[0]?.diameterMm ?? 300, radius = diameter / 2, scale = board / diameter;
  const coordinateTicks = scaleLinear().domain([-radius, radius]).ticks(6);
  const point = (d: Pick<WaferDie, 'xMm' | 'yMm'>) => ({ x: cx + d.xMm * scale, y: cy - d.yMm * scale });
  const uid = `wafer-${useId().replaceAll(':', '')}`, extent = { width, height }, enabled = !embedded && widget.options?.showTooltip !== false;
  const [view, setView] = useState<GeoViewport>(INITIAL_GEO_VIEW), camera = useRef(view);
  const [selectedState, setSelected] = useState<string | null>(cfg.selectedDieId || null), [touch, setTouch] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null), [search, setSearch] = useState('');
  const [exactPage, setExactPage] = useState(0);
  const sourceRevision = useRef(result), selectionRequest = useRef(cfg.selectedDieId), frame = useRef<number | null>(null);
  const requested = sourceRevision.current !== result || selectionRequest.current !== cfg.selectedDieId ? cfg.selectedDieId : selectedState;
  const selected = visible.some(die => die.id === requested) ? requested || null : null;
  const inspect = useInspection(visible, result, enabled, cfg.selectedDieId), active = inspect.item;
  const rovingId = waferFocusId(visible, focusId, selected);
  const marks = useRef(new Map<string, SVGRectElement>()), pointers = useRef(new Map<number, GeoPoint>());
  const drag = useRef<{ origin: GeoPoint; view: GeoViewport; candidate: string | null } | null>(null);
  const pinch = useRef<{ points: [GeoPoint, GeoPoint]; view: GeoViewport } | null>(null), moved = useRef(false), suppressClick = useRef(false);
  const summary = summarizeWafer(dies);
  const query = search.trim().toLowerCase(), candidates = visible.filter(d => !query || `${d.id} ${dieLabel(d)} ${d.xMm},${d.yMm}`.toLowerCase().includes(query));
  const page = Math.min(exactPage, Math.max(0, Math.ceil(candidates.length / 15) - 1));
  const signal = (die: WaferDie | null) => onContextChange?.({ series: die?.id ?? '', value: die?.leakageNA ?? null, labels: { dieId: die?.id ?? '', wafer: die?.wafer ?? '', chamber: die?.chamber ?? '', bin: die?.bin ?? '' } });

  function update(next: GeoViewport, immediate = false) {
    camera.current = constrainGeoView(next, extent);
    if (immediate) { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; setView(camera.current); }
    else if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; setView(camera.current); });
  }
  function local(clientX: number, clientY: number) {
    const matrix = svg.current?.getScreenCTM();
    if (matrix) return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    const rect = svg.current?.getBoundingClientRect();
    return rect ? { x: (clientX - rect.left) * width / Math.max(1, rect.width), y: (clientY - rect.top) * height / Math.max(1, rect.height) } : { x: width / 2, y: height / 2 };
  }
  function stopGesture() {
    for (const id of pointers.current.keys()) if (svg.current?.hasPointerCapture(id)) svg.current.releasePointerCapture(id);
    pointers.current.clear(); drag.current = null; pinch.current = null; moved.current = true;
  }
  function choose(id: string, target?: HTMLElement | SVGElement) {
    if (!enabled) return;
    const die = visible.find(d => d.id === id); if (!die) return;
    setSelected(id); setFocusId(id); inspect.select(id, target); signal(die);
    update(revealGeoPoint(camera.current, point(die), extent, 25), true);
  }
  function clear() { setSelected(null); inspect.dismiss(); signal(null); }
  function focusDie(id: string) {
    const die = visible.find(d => d.id === id); if (!die) return;
    setFocusId(id); update(revealGeoPoint(camera.current, point(die), extent, 25), true); marks.current.get(id)?.focus({ preventScroll: true });
  }
  function zoom(factor: number) { update(zoomGeoAt(camera.current, factor, { x: width / 2, y: height / 2 }, extent), true); }
  function reset() { stopGesture(); update(INITIAL_GEO_VIEW, true); }

  useEffect(() => {
    const newRequest = selectionRequest.current !== cfg.selectedDieId;
    if (newRequest) { selectionRequest.current = cfg.selectedDieId; setSelected(visible.some(d => d.id === cfg.selectedDieId) ? cfg.selectedDieId : null); }
    if (sourceRevision.current !== result) { sourceRevision.current = result; setSelected(visible.some(die => die.id === cfg.selectedDieId) ? cfg.selectedDieId : null); setSearch(''); setExactPage(0); }
  }, [result, cfg.selectedDieId]);
  useEffect(() => { if (selectedState && !visible.some(d => d.id === selectedState)) clear(); setExactPage(0); }, [cfg.filter]);
  useEffect(() => { update(camera.current, true); }, [width, height]);
  useEffect(() => {
    const node = svg.current; if (!node || embedded) return;
    const wheel = (event: WheelEvent) => { const next = geoWheelView(camera.current, event, local(event.clientX, event.clientY), { width, height }); if (next) { event.preventDefault(); update(next); } };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, [width, height, embedded]);
  useEffect(() => () => { pointers.current.clear(); drag.current = null; pinch.current = null; }, []);

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (embedded || event.button !== 0) return;
    if (pointers.current.size >= 2) return;
    if (event.pointerType === 'touch' && !touch) { moved.current = false; suppressClick.current = false; return; }
    const p = local(event.clientX, event.clientY); pointers.current.set(event.pointerId, p); event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) { pinch.current = { points: [...pointers.current.values()] as [GeoPoint, GeoPoint], view: camera.current }; drag.current = null; moved.current = true; return; }
    drag.current = { origin: p, view: camera.current, candidate: (event.target as Element).closest('[data-wafer-die]')?.getAttribute('data-wafer-die') ?? null };
    moved.current = false; suppressClick.current = false;
  }
  function move(event: ReactPointerEvent<SVGSVGElement>) {
    const p = local(event.clientX, event.clientY);
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, p);
    if (pinch.current && pointers.current.size === 2) { update(pinchGeo(pinch.current.view, pinch.current.points, [...pointers.current.values()] as [GeoPoint, GeoPoint], extent)); return; }
    const d = drag.current; if (!d) return;
    if (Math.hypot(p.x - d.origin.x, p.y - d.origin.y) > 4) moved.current = true;
    if (moved.current) update(panGeoBy(d.view, { x: p.x - d.origin.x, y: p.y - d.origin.y }, extent));
  }
  function up(event: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current, didMove = moved.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointers.current.delete(event.pointerId); drag.current = null; pinch.current = null;
    suppressClick.current = true;
    if (d?.candidate && !didMove) choose(d.candidate, marks.current.get(d.candidate));
  }
  if (!dies.length) return <div className="domain-empty">No wafer die observations</div>;

  return <div className="wafer-chart wafer-map" data-wafer-map data-map-zoom={view.k.toFixed(3)} onKeyDown={event => {
    if (event.key === 'Escape' && (active || drag.current || pinch.current)) { event.preventDefault(); event.stopPropagation(); stopGesture(); inspect.dismiss(); }
  }} onPointerLeave={() => inspect.setHover(null)}>
    {!embedded && <div className="wafer-controls"><div className="wafer-camera-controls">
      <button className="domain-control" aria-label="Zoom in wafer" disabled={view.k >= 8} onClick={() => zoom(1.5)}><Plus size={15}/></button>
      <button className="domain-control" aria-label="Zoom out wafer" disabled={view.k <= 1} onClick={() => zoom(1 / 1.5)}><Minus size={15}/></button>
      <button className="domain-control" aria-label="Fit wafer" onClick={reset}><RotateCcw size={14}/>Fit</button><span>{view.k.toFixed(1)}×</span>
    </div><span className="domain-note">Scroll to zoom · drag to pan</span>{selected && <button className="domain-control" onClick={clear}>Clear die</button>}</div>}
    <div className="wafer-map-layout"><div ref={plot} data-chart-entering={entering || undefined} className="wafer-map-stage">
      <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${dies[0].wafer} die map. Scroll to zoom; arrow keys pan; plus and minus zoom; Home fits the wafer.`} tabIndex={embedded ? undefined : 0}
        style={{ touchAction: touch ? 'none' : 'pan-y' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { stopGesture(); suppressClick.current = true; }}
        onKeyDown={event => {
          if (embedded || event.target !== event.currentTarget) return;
          const delta: Record<string, GeoPoint> = { ArrowLeft: { x: 35, y: 0 }, ArrowRight: { x: -35, y: 0 }, ArrowUp: { x: 0, y: 35 }, ArrowDown: { x: 0, y: -35 } };
          if (delta[event.key]) { event.preventDefault(); update(panGeoBy(camera.current, delta[event.key], extent), true); }
          else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoom(event.key === '-' ? 1 / 1.5 : 1.5); }
          else if (event.key === 'Home') { event.preventDefault(); reset(); }
        }}>
        <defs><clipPath id={`${uid}-plot`}><rect x={pad.left - 1} y="0" width={width - pad.left} height={height - pad.bottom + 3}/></clipPath><clipPath id={`${uid}-wafer`}><circle cx={cx} cy={cy} r={board / 2}/></clipPath>
          <PlotHatchDefs id={uid}/>
          <linearGradient id={`${uid}-leakage`}><stop stopColor={C.cyan}/><stop offset="1" stopColor={C.red}/></linearGradient>
        </defs>
        <g clipPath={`url(#${uid}-plot)`}><g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <circle cx={cx} cy={cy} r={board / 2} fill="var(--gamma-bg)" stroke={C.muted} strokeWidth="1.2" vectorEffect="non-scaling-stroke"/>
          {cfg.showGrid && coordinateTicks.map(t => <g key={t} className="wafer-grid"><line x1={cx + t * scale} x2={cx + t * scale} y1={cy - board / 2} y2={cy + board / 2} vectorEffect="non-scaling-stroke"/><line x1={cx - board / 2} x2={cx + board / 2} y1={cy - t * scale} y2={cy - t * scale} vectorEffect="non-scaling-stroke"/></g>)}
          <g clipPath={`url(#${uid}-wafer)`}><g className={chartEntrance.revealMarks}>{visible.map(die => {
            const p = point(die), side = die.dieSizeMm * scale * (1 - cfg.cellGap), selectedMark = die.id === active?.id || die.id === selected;
            return <rect key={die.id} ref={node => { if (node) marks.current.set(die.id, node); else marks.current.delete(die.id); }} x={p.x - side / 2} y={p.y - side / 2} width={side} height={side} rx=".25"
              data-wafer-die={die.id} role={enabled ? 'button' : undefined} tabIndex={enabled ? die.id === rovingId ? 0 : -1 : undefined}
              aria-label={`Inspect die ${dieLabel(die)}`} aria-pressed={enabled ? selected === die.id : undefined}
              fill={die.bin === 'untested' ? plotHatchFill(uid) : cfg.colorMode === 'leakage' && die.bin !== 'excluded' ? leakageColor(die.leakageNA) : WAFER_COLORS[die.bin]}
              opacity={die.bin === 'excluded' ? .7 : 1} stroke={die.id === active?.id ? C.orange : die.id === selected ? C.cyan : 'none'} strokeWidth={selectedMark ? 2.5 : 0} vectorEffect="non-scaling-stroke"
              onPointerEnter={() => { if (enabled && !inspect.pinned) inspect.setHover(die.id); }} onFocus={() => { if (enabled && !inspect.pinned) inspect.setHover(die.id); }} onPointerLeave={() => inspect.setHover(null)} onBlur={() => inspect.setHover(null)}
              onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } if (!moved.current) choose(die.id, event.currentTarget); }}
              onKeyDown={event => {
                if (!enabled) return;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(die.id, event.currentTarget); }
                else if (event.key.startsWith('Arrow')) {
                  event.preventDefault(); event.stopPropagation();
                  const next = waferKeyboardTarget(visible, die, event.key);
                  if (next) focusDie(next.id);
                }
              }}><title>{`${dieLabel(die)} · X ${die.xMm} mm, Y ${die.yMm} mm · ${waferNumber(die.leakageNA, 3)} nA`}</title></rect>;
          })}</g></g>
          <path d={`M${cx - 7 * scale},${cy + board / 2 + 2}Q${cx},${cy + board / 2 - 15 * scale} ${cx + 7 * scale},${cy + board / 2 + 2}`} fill="var(--gamma-bg)" stroke={C.muted} strokeWidth="1.2" vectorEffect="non-scaling-stroke"/>
        </g></g>
        {cfg.showCoordinates && <g className="wafer-axis">{coordinateTicks.map(t => {
          const xp = geoToScreen({ x: cx + t * scale, y: 0 }, view).x, yp = geoToScreen({ x: 0, y: cy - t * scale }, view).y;
          return <g key={t}>{xp >= pad.left && xp <= width - 10 && <text x={xp} y={height - 20} textAnchor="middle">{t}</text>}{yp > 9 && yp < height - pad.bottom && <text x={pad.left - 7} y={yp + 4} textAnchor="end">{t}</text>}</g>;
        })}<text x={cx} y={height - 3} textAnchor="middle">X (mm)</text><text transform={`translate(12 ${height / 2}) rotate(-90)`} textAnchor="middle">Y (mm)</text></g>}
      </svg>
    </div>{enabled && active && <DomainInspector title={`Die C${signed(active.column)} / R${signed(active.row)}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Final bin', BIN_LABEL[active.bin]], ['Leakage', active.leakageNA === null ? 'Not measured' : `${waferNumber(active.leakageNA, 3)} nA`],
      ['Physical X / Y', `${signed(active.xMm)} / ${signed(active.yMm)} mm`], ['Etch chamber', active.chamber],
      ['Probe · UTC', active.probeAt === null ? 'Not tested' : new Date(active.probeAt).toISOString().slice(11, 19)],
    ]}/>{!inspect.pinned && <button className="wafer-pin" onClick={() => choose(active.id)}>Pin die</button>}</DomainInspector>}</div>
    {widget.options?.showLegend !== false && <div className="domain-legend">{cfg.colorMode === 'bin' ? DIE_BINS.map(bin => <span key={bin}><i className={bin === 'untested' ? `${hatchStyles.hatch} ${hatchStyles.swatch}` : undefined} style={bin === 'untested' ? undefined : { background: WAFER_COLORS[bin] }}/>{BIN_LABEL[bin]}</span>) : <><span>Leakage · nA</span><i className="wafer-color-scale"/><span>≤0.1 → ≥150 · log colour</span><span>Hatch: untested · grey: unmeasured</span></>}</div>}
    {!embedded && <><div className="wafer-controls"><label>Inspect die <select className="domain-control" aria-label="Inspect wafer die" value={selected ?? ''} onChange={event => event.target.value ? choose(event.target.value, event.currentTarget) : clear()} disabled={!enabled}><option value="">Choose a die</option>{visible.map(d => <option key={d.id} value={d.id}>{dieLabel(d)}</option>)}</select></label>
      <button className="domain-control" aria-pressed={touch} onClick={() => { stopGesture(); setTouch(v => !v); }}>Touch pan {touch ? 'on' : 'off'}</button>
      {view.k > 1 && <div className="wafer-camera-controls">{([{ icon: ArrowUp, x: 0, y: 35, label: 'up' }, { icon: ArrowLeft, x: 35, y: 0, label: 'left' }, { icon: ArrowRight, x: -35, y: 0, label: 'right' }, { icon: ArrowDown, x: 0, y: -35, label: 'down' }] as const).map(p => <button key={p.label} className="domain-control" aria-label={`Pan wafer ${p.label}`} onClick={() => update(panGeoBy(camera.current, p, extent), true)}><p.icon size={14}/></button>)}</div>}
    </div><details className="wafer-exact"><summary>Exact die records · {visible.length} shown / {dies.length} positions</summary><div className="wafer-controls"><input className="domain-control" aria-label="Search exact wafer dies" placeholder="Find die or physical coordinate" value={search} onChange={event => { setSearch(event.target.value); setExactPage(0); }}/><span>{candidates.length} matches</span><button className="domain-control" disabled={page === 0} onClick={() => setExactPage(page - 1)}>Previous</button><button className="domain-control" disabled={(page + 1) * 15 >= candidates.length} onClick={() => setExactPage(page + 1)}>Next</button></div><div className="domain-table-scroll"><table className="domain-table"><thead><tr><th>Die C / R</th><th>X / Y · mm</th><th>Final bin</th><th>Leakage · nA</th></tr></thead><tbody>{candidates.slice(page * 15, page * 15 + 15).map(d => <tr key={d.id} data-selected={selected === d.id}><td><button className="wafer-text-button" onClick={() => choose(d.id)}>{signed(d.column)} / {signed(d.row)}</button></td><td>{d.xMm} / {d.yMm}</td><td>{BIN_LABEL[d.bin]}</td><td className="is-number">{waferNumber(d.leakageNA, 3)}</td></tr>)}</tbody></table></div></details></>}
    <p className="domain-note wafer-map-note">{summary.tested} tested · {summary.untested} untested · {summary.excluded} edge exclusions. Camera and display filter preserve the wafer population.</p>
  </div>;
}

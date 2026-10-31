import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { normalizeGeoLocations } from './geo-data';
import type { GeoDecorationPoint, GeoGeometry, GeoLocation, GeoSeverity } from './geo-data';
import { constrainGeoView, GEO_MAX_ZOOM, geoScreenUnits, geoToScreen, geoWheelView, INITIAL_GEO_VIEW, panGeoBy, pinchGeo, revealGeoPoint, zoomGeoAt } from './geo-viewport';
import type { GeoPoint, GeoViewport } from './geo-viewport';
import './GeoMap.css';

export type GeoMapProps = {
  label: string;
  locations: readonly GeoLocation[];
  geometry: GeoGeometry;
  valueLabel?: string;
  /** Host terminology for the supplied classifications, without changing their colors or values. */
  classificationLabels?: Partial<Record<GeoSeverity, string>>;
  /** Display filtering affects inspection only; it never resets viewport navigation. */
  activeSeverity?: GeoSeverity | null;
  maxPoints?: number;
  interactive?: boolean;
  /** Hide inspection without disabling viewport navigation. */
  inspectable?: boolean;
  /** Host result/query revision: invalidate exact inspection without resetting navigation. */
  selectionRevision?: unknown;
  /** Optional host selection for linked regional evidence; undefined keeps local ownership. */
  selectedLocationId?: string | null;
  /** Explicit concept artwork, excluded from records, counts, selection and export. */
  decoration?: readonly GeoDecorationPoint[];
  concept?: boolean;
  /** Natural-height stage and screen-sized marks; source-canvas reproductions opt out. */
  responsive?: boolean;
  onSelect?: (location: GeoLocation | null) => void;
};

const COLORS: Record<GeoSeverity, string> = { low: 'var(--paprika-map-low, #04d8ed)', medium: 'var(--paprika-map-medium, #ffbd30)', high: 'var(--paprika-map-high, #fb4e43)', unknown: 'var(--paprika-map-unknown, #7898aa)' };
const RADII: Record<GeoSeverity, number> = { low: 1.9, medium: 4.2, high: 2.3, unknown: 2.5 };
const identity = (point: GeoLocation) => JSON.stringify([point.id, point.label, point.longitude, point.latitude, point.value, point.severity]);
const number = (value: number | null) => value === null ? 'No value' : value.toLocaleString('en-US', { maximumFractionDigits: 20 });

export interface GeoSelectionState {
  controlled: boolean;
  requestedId: string | null;
  id: string | null;
  snapshot: string | null;
  revision: unknown;
  canInspect: boolean;
}

/** One reconciliation step owns host requests and source invalidation together.
 * A stale controlled ID is acknowledged once and stays cleared until the host
 * changes its request or the user deliberately selects a current observation.
 */
export function reconcileGeoSelection(previous: GeoSelectionState, input: {
  selectedLocationId?: string | null; locations: readonly GeoLocation[]; revision: unknown; canInspect: boolean;
}): { state: GeoSelectionState; notifyClear: boolean; revealId: string | null } {
  const controlled = input.selectedLocationId !== undefined, requestedId = controlled ? input.selectedLocationId! : null;
  const newRequest = controlled && (!previous.controlled || requestedId !== previous.requestedId);
  if (newRequest) {
    const point = input.canInspect && requestedId !== null ? input.locations.find(item => item.id === requestedId) : undefined;
    return { state: { controlled, requestedId, id: point?.id ?? null, snapshot: point ? identity(point) : null, revision: input.revision, canInspect: input.canInspect }, notifyClear: requestedId !== null && !point, revealId: point?.id ?? null };
  }
  const point = input.canInspect && previous.id !== null ? input.locations.find(item => item.id === previous.id) : undefined;
  const invalid = previous.id !== null && (!point || identity(point) !== previous.snapshot || input.revision !== previous.revision);
  const changed = invalid || previous.controlled !== controlled || previous.requestedId !== requestedId || previous.revision !== input.revision || previous.canInspect !== input.canInspect;
  return { state: changed ? { controlled, requestedId, id: invalid ? null : previous.id, snapshot: invalid ? null : previous.snapshot, revision: input.revision, canInspect: input.canInspect } : previous, notifyClear: invalid, revealId: null };
}

/** Zoom is a local, query-free viewport transform; values and marker sizes never scale with it. */
export function GeoMap({ label, locations, geometry, valueLabel = 'connections', classificationLabels, activeSeverity = null, maxPoints = 500, decoration = [], concept = false, responsive = false, interactive = true, inspectable = true, selectionRevision, selectedLocationId, onSelect }: GeoMapProps) {
  const canInspect = interactive && inspectable;
  const classification = (severity: GeoSeverity) => classificationLabels?.[severity] ?? (severity === 'unknown' ? 'Unclassified' : `${severity[0].toUpperCase()}${severity.slice(1)} risk`);
  const uid = `geo-${useId().replaceAll(':', '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const markerRefs = useRef(new Map<string, SVGGElement>());
  const pointers = useRef(new Map<number, GeoPoint>());
  const moved = useRef(false);
  const totalMovement = useRef(0);
  const pointerCandidate = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  const viewRef = useRef<GeoViewport>(INITIAL_GEO_VIEW);
  const [view, setView] = useState<GeoViewport>(INITIAL_GEO_VIEW);
  const [dragging, setDragging] = useState(false);
  const [touchNavigation, setTouchNavigation] = useState(false);
  const [selection, setSelection] = useState<GeoSelectionState>(() => ({ controlled: false, requestedId: null, id: null, snapshot: null, revision: selectionRevision, canInspect }));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [cssScale, setCssScale] = useState(1);
  const [controlScale, setControlScale] = useState(1);
  const normalized = useMemo(() => normalizeGeoLocations(locations, maxPoints), [locations, maxPoints]);
  const projected = useMemo(() => normalized.locations.flatMap(location => {
    const [x, y] = geometry.project(location.longitude, location.latitude);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ ...location, x, y }] : [];
  }), [normalized.locations, geometry]);
  const visible = useMemo(() => projected.filter(point => !activeSeverity || point.severity === activeSeverity), [projected, activeSeverity]);
  const selectionTransition = useMemo(() => reconcileGeoSelection(selection, { selectedLocationId, locations: visible, revision: selectionRevision, canInspect }), [selection, selectedLocationId, visible, selectionRevision, canInspect]);
  const appliedSelectionTransition = useRef<typeof selectionTransition | null>(null);
  const selectedId = selectionTransition.state.id;
  const selected = visible.find(point => point.id === selectedId) ?? null;
  const focusableId = visible.some(point => point.id === focusId) ? focusId : visible[0]?.id;
  const excluded = normalized.invalid + normalized.duplicates + (normalized.locations.length - projected.length);
  const symbol = (pixels: number) => responsive ? geoScreenUnits(pixels, cssScale) : pixels;

  // Do not mirror a host request into one effect and invalidate the previous
  // selection in another: both effects would see the old ID and different snapshots.
  useEffect(() => {
    if (appliedSelectionTransition.current === selectionTransition) return;
    appliedSelectionTransition.current = selectionTransition;
    if (selectionTransition.state !== selection) setSelection(selectionTransition.state);
    if (selectionTransition.revealId) {
      const point = visible.find(item => item.id === selectionTransition.revealId);
      if (point) { setFocusId(point.id); immediate(revealGeoPoint(viewRef.current, point, geometry)); }
    }
    if (selectionTransition.notifyClear) onSelect?.(null);
  }, [selectionTransition, selection, visible, geometry, onSelect]);

  function commit(next: GeoViewport) {
    viewRef.current = constrainGeoView(next, geometry);
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; setView(viewRef.current); });
  }
  function immediate(next: GeoViewport) {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    viewRef.current = constrainGeoView(next, geometry);
    setView(viewRef.current);
  }
  function localPoint(clientX: number, clientY: number): GeoPoint {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (matrix) { const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()); return { x: point.x, y: point.y }; }
    const box = svg?.getBoundingClientRect();
    return box ? { x: (clientX - box.left) * geometry.width / Math.max(1, box.width), y: (clientY - box.top) * geometry.height / Math.max(1, box.height) } : { x: geometry.width / 2, y: geometry.height / 2 };
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || (!interactive && !responsive)) return;
    const measure = () => {
      const box = svg.getBoundingClientRect(), matrix = svg.getScreenCTM();
      // Include meet/letterboxing and artboard transforms for SVG hit circles.
      const x = matrix ? Math.hypot(matrix.a, matrix.b) : box.width / geometry.width;
      const y = matrix ? Math.hypot(matrix.c, matrix.d) : box.height / geometry.height;
      setCssScale(Math.max(.1, Math.min(x, y)));
      // HTML controls need only the enclosing CSS transform, not the SVG viewBox scale.
      setControlScale(Math.max(.1, box.width / Math.max(1, svg.clientWidth)));
    };
    const observer = new ResizeObserver(measure); observer.observe(svg); measure();
    // CSS artboard fitting scales ancestors without resizing the SVG's content box.
    const ancestorStyles = new MutationObserver(measure);
    for (let parent = svg.parentElement?.parentElement; parent; parent = parent.parentElement) ancestorStyles.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] });
    window.addEventListener('resize', measure);
    // Plain wheel zoom is deliberate for this lab; page/browser zoom and outward bounds pass through.
    const wheel = (event: WheelEvent) => {
      const next = geoWheelView(viewRef.current, event, localPoint(event.clientX, event.clientY), geometry);
      if (!next) return;
      event.preventDefault();
      commit(next);
    };
    if (interactive) svg.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect(); ancestorStyles.disconnect(); window.removeEventListener('resize', measure); svg.removeEventListener('wheel', wheel);
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
      for (const id of pointers.current.keys()) if (svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
      pointers.current.clear();
    };
  }, [geometry, interactive, responsive]);

  function zoom(factor: number) { immediate(zoomGeoAt(viewRef.current, factor, { x: geometry.width / 2, y: geometry.height / 2 }, geometry)); }
  function pan(x: number, y: number) { immediate(panGeoBy(viewRef.current, { x, y }, geometry)); }
  function stopGestures() {
    const svg = svgRef.current;
    pointerCandidate.current = null;
    moved.current = true;
    for (const id of pointers.current.keys()) if (svg?.hasPointerCapture(id)) svg.releasePointerCapture(id);
    pointers.current.clear();
    setDragging(false);
  }
  function reset() { stopGestures(); setTouchNavigation(false); immediate(INITIAL_GEO_VIEW); }
  function toggleTouchNavigation() { stopGestures(); setTouchNavigation(value => !value); }
  useEffect(() => { if (!interactive) { stopGestures(); setTouchNavigation(false); } }, [interactive]);
  function clearSelection(restoreFocus = true) {
    const previous = selectedId;
    if (selectedLocationId === undefined) setSelection({ ...selectionTransition.state, id: null, snapshot: null });
    onSelect?.(null);
    if (restoreFocus) (previous ? markerRefs.current.get(previous) : svgRef.current)?.focus({ preventScroll: true });
  }
  function inspect(point: typeof visible[number], toggle = true) {
    if (!canInspect) return;
    const next = toggle && selectedId === point.id ? null : point.id;
    // A controlled map reports a request and waits for its host. Re-selecting an
    // already-requested but invalidated ID explicitly accepts its current data.
    if (selectedLocationId === undefined || next === selectedLocationId) setSelection({ ...selectionTransition.state, id: next, snapshot: next ? identity(point) : null });
    setFocusId(point.id); onSelect?.(next ? point : null);
    immediate(revealGeoPoint(viewRef.current, point, geometry));
  }
  function keyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Escape') { if (selectedId) { event.preventDefault(); event.stopPropagation(); clearSelection(); } return; }
    // Point arrows navigate the point set; viewport arrows operate when the map itself has focus.
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 64 : 32;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.5); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoom(1 / 1.5); }
    else if (event.key === 'Home' || event.key === '0') { event.preventDefault(); reset(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); pan(step, 0); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); pan(-step, 0); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); pan(0, step); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); pan(0, -step); }
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return;
    if (event.pointerType === 'touch' && !touchNavigation) { moved.current = false; return; }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (pointers.current.size === 0) { moved.current = false; totalMovement.current = 0; }
    pointerCandidate.current = pointers.current.size === 0 ? (event.target as Element).closest<SVGGElement>('[data-geo-location]')?.dataset.geoLocation ?? null : null;
    pointers.current.set(event.pointerId, localPoint(event.clientX, event.clientY));
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    if (!(event.target as Element).closest('[data-geo-location]')) svgRef.current?.focus({ preventScroll: true });
    if (pointers.current.size > 1) moved.current = true;
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.current.values()];
    const next = localPoint(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, next);
    totalMovement.current += Math.hypot(next.x - previous.x, next.y - previous.y) * (responsive ? cssScale : 1);
    if (totalMovement.current > 3) moved.current = true;
    if (pointers.current.size > 1) {
      const after = [...pointers.current.values()];
      commit(pinchGeo(viewRef.current, [before[0], before[1]], [after[0], after[1]], geometry));
    } else commit(panGeoBy(viewRef.current, { x: next.x - previous.x, y: next.y - previous.y }, geometry));
  }
  function pointerEnd(event: ReactPointerEvent<SVGSVGElement>) {
    const candidate = pointerCandidate.current;
    pointerCandidate.current = null;
    if (event.type === 'pointerup' && pointers.current.size === 1 && !moved.current && candidate) { const point = visible.find(item => item.id === candidate); if (point) inspect(point); moved.current = true; }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!pointers.current.size) setDragging(false);
  }

  return <div className="paprika-geo-map" style={{ '--geo-target-size': `${Math.max(responsive ? 30 : 26, 24 / controlScale)}px` } as CSSProperties} data-geo-responsive={responsive || undefined} data-geo-zoom={view.k.toFixed(3)} data-geo-x={view.x.toFixed(3)} data-geo-y={view.y.toFixed(3)} data-geo-locations={visible.length} data-geo-touch-navigation={interactive && touchNavigation ? 'on' : 'off'}>
    <p id={`${uid}-help`} className="paprika-geo-sr">{geometry.description}. {interactive ? <>Drag with a mouse to pan. Scroll over the map to zoom around the pointer. At the zoom limits, outward scrolling returns to the page. Ctrl or Command plus scroll remains browser zoom. Use plus and minus to zoom, arrows to pan, and Home to reset while the map has focus. {touchNavigation ? 'Touch navigation is on: drag or pinch to move and zoom the map. Turn off Touch navigation or reset to restore page touch gestures.' : 'Touch navigation is off: page scrolling and browser pinch remain available. Enable Touch navigation to drag or pinch the map.'}{canInspect && ' Location arrows move between observations; Enter selects. Escape closes details. The Locations menu offers the same observations.'}</> : 'Static location view.'}</p>
    <div className="paprika-geo-stage"><svg ref={svgRef} viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="group" aria-label={label} aria-describedby={`${uid}-help`} tabIndex={interactive ? 0 : undefined} className={`paprika-geo-svg${interactive ? ' is-interactive' : ''}${interactive && dragging ? ' is-dragging' : ''}${interactive && touchNavigation ? ' is-touch-navigation' : ''}`} onKeyDown={interactive ? keyDown : undefined} onPointerDown={interactive ? pointerDown : undefined} onPointerMove={interactive ? pointerMove : undefined} onPointerUp={interactive ? pointerEnd : undefined} onPointerCancel={interactive ? pointerEnd : undefined} onLostPointerCapture={interactive ? pointerEnd : undefined} onClickCapture={interactive ? event => { if (moved.current) { event.preventDefault(); event.stopPropagation(); moved.current = false; } } : undefined}>
      <defs>
        <radialGradient id={`${uid}-ocean`}><stop stopColor="var(--paprika-map-ocean-start, #09202b)"/><stop offset="1" stopColor="var(--paprika-map-ocean-end, #03121c)"/></radialGradient>
        <linearGradient id={`${uid}-land`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--paprika-map-land-start, #19333e)"/><stop offset="1" stopColor="var(--paprika-map-land-end, #102832)"/></linearGradient>
        {Object.entries(COLORS).map(([severity, color]) => <radialGradient key={severity} id={`${uid}-${severity}`}><stop stopColor={concept && severity === 'medium' ? 'var(--paprika-map-medium-highlight, #fff7a3)' : color} stopOpacity=".95"/><stop offset=".25" stopColor={color} stopOpacity=".65"/><stop offset="1" stopColor={color} stopOpacity="0"/></radialGradient>)}
        <clipPath id={`${uid}-clip`}><rect width={geometry.width} height={geometry.height} rx="7"/></clipPath>
      </defs>
      <g clipPath={`url(#${uid}-clip)`}>
        <rect width={geometry.width} height={geometry.height} fill={`url(#${uid}-ocean)`}/>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`} fill={`url(#${uid}-land)`} stroke="var(--paprika-map-land-border, #061a25)" strokeWidth=".45" aria-hidden="true">{geometry.countries.map(country => <path key={country.name} d={country.path} vectorEffect="non-scaling-stroke"/>)}</g>
        <g aria-hidden="true" pointerEvents="none">{decoration.map((point, index) => { const position = geoToScreen(point, view); return <circle key={index} cx={position.x} cy={position.y} r={symbol(point.radius)} fill={point.color} opacity={point.opacity * (activeSeverity && point.severity && activeSeverity !== point.severity ? .1 : 1)}/>; })}</g>
        {projected.map(point => {
          const position = geoToScreen(point, view), shown = !activeSeverity || point.severity === activeSeverity;
          const inView = position.x >= 0 && position.x <= geometry.width && position.y >= 0 && position.y <= geometry.height;
          return <g key={point.id} ref={element => { if (element) markerRefs.current.set(point.id, element); else markerRefs.current.delete(point.id); }} transform={`translate(${position.x} ${position.y})`} role={canInspect ? "button" : "img"} tabIndex={canInspect ? shown && inView && point.id === focusableId ? 0 : -1 : undefined} aria-hidden={!shown || !inView || undefined} aria-label={`${point.label}: ${number(point.value)} ${valueLabel}, ${classification(point.severity)}${concept ? ', concept' : ''}`} aria-pressed={canInspect ? point.id === selectedId : undefined} data-geo-location={point.id} className={`paprika-geo-marker${canInspect ? ' is-inspectable' : ''}`} opacity={shown ? 1 : .09} style={{ pointerEvents: canInspect && shown && inView ? 'auto' : 'none' }} onClick={canInspect ? () => inspect(point) : undefined} onFocus={canInspect ? () => { setFocusId(point.id); } : undefined} onKeyDown={canInspect ? event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); inspect(point); }
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault(); event.stopPropagation();
              const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
              const next = visible[(visible.findIndex(item => item.id === point.id) + direction + visible.length) % visible.length];
              if (next) { setFocusId(next.id); immediate(revealGeoPoint(viewRef.current, next, geometry)); markerRefs.current.get(next.id)?.focus({ preventScroll: true }); }
            }
          } : undefined}>
            {canInspect && <title>{point.label} · {number(point.value)} {valueLabel} · {point.latitude}°, {point.longitude}°</title>}
            <circle className="paprika-geo-halo" r={symbol(concept ? point.value !== null && Math.abs(point.value) > 1500 ? 10 : 5.5 : 7)} fill={`url(#${uid}-${point.severity})`} opacity={concept ? point.severity === 'high' ? .4 : .72 : .55} pointerEvents="none"/>
            <circle className="paprika-geo-hit" r={responsive ? symbol(14) : Math.max(14, 12 / cssScale)} fill="transparent" vectorEffect={responsive?'non-scaling-stroke':undefined}/>
            <circle className="paprika-geo-mark" r={symbol(concept ? RADII[point.severity] : 3)} fill={point.value === null ? 'var(--paprika-map-ocean-end, #03121c)' : COLORS[point.severity]} stroke={point.value === null ? COLORS[point.severity] : 'none'} vectorEffect={responsive?'non-scaling-stroke':undefined} pointerEvents="none"/>
            {concept && point.severity === 'medium' && <circle cx={-symbol(.6)} cy={-symbol(1)} r={symbol(1.8)} fill="var(--paprika-map-medium-highlight, #fff8b3)" pointerEvents="none"/>}
            {point.id === selectedId && <circle className="paprika-geo-selection" r={symbol(7)} fill="none" stroke="var(--paprika-map-selection, #d5faff)" strokeWidth="1.2" vectorEffect={responsive?'non-scaling-stroke':undefined} pointerEvents="none"/>}
          </g>;
        })}
      </g>
    </svg>
    {interactive && <div className="paprika-geo-zoom" role="group" aria-label="Map zoom controls">
      <span className="paprika-geo-scale" aria-label={`Map zoom ${Math.round(view.k * 100)} percent`}>{Math.round(view.k * 100)}%</span>
      <button type="button" aria-label="Zoom in map" title="Zoom in (+)" disabled={view.k >= GEO_MAX_ZOOM} onClick={() => zoom(1.5)}>+</button>
      <button type="button" aria-label="Zoom out map" title="Zoom out (−)" disabled={view.k <= 1} onClick={() => zoom(1 / 1.5)}>−</button>
      <button type="button" aria-label="Reset map view" title="Reset view (Home)" disabled={view.k === 1 && !touchNavigation} onClick={reset}>↺</button>
    </div>}
    {interactive && <button type="button" className="paprika-geo-touch" aria-label="Touch map navigation" aria-pressed={touchNavigation} title={touchNavigation ? 'Disable map touch navigation to restore page gestures' : 'Enable touch drag and pinch on this map'} onClick={toggleTouchNavigation}>Touch: {touchNavigation ? 'on' : 'off'}</button>}
    {interactive && view.k > 1 && <div className="paprika-geo-pan" role="group" aria-label="Map pan controls">
      <button type="button" className="pan-up" aria-label="Pan map north" title="Pan north" disabled={view.y >= 0} onClick={() => pan(0, 32)}>↑</button>
      <button type="button" className="pan-left" aria-label="Pan map west" title="Pan west" disabled={view.x >= 0} onClick={() => pan(32, 0)}>←</button>
      <button type="button" className="pan-down" aria-label="Pan map south" title="Pan south" disabled={view.y <= geometry.height * (1 - view.k)} onClick={() => pan(0, -32)}>↓</button>
      <button type="button" className="pan-right" aria-label="Pan map east" title="Pan east" disabled={view.x <= geometry.width * (1 - view.k)} onClick={() => pan(-32, 0)}>→</button>
    </div>}
    {canInspect && <label className="paprika-geo-locations"><span className="paprika-geo-sr">Inspect a map location</span><select aria-label="Inspect a map location" value={selected?.id ?? ''} onChange={event => { const point = visible.find(item => item.id === event.target.value); if (point) inspect(point, false); else clearSelection(false); }}><option value="">Locations ({visible.length})</option>{visible.map(point => <option key={point.id} value={point.id}>{point.label} · {number(point.value)} {valueLabel}</option>)}</select></label>}
    {!visible.length && <div className="paprika-geo-empty" role="status">No locations for this filter</div>}
    {(excluded > 0 || normalized.omitted > 0) && <div className="paprika-geo-warning" role="status">{excluded > 0 && `${excluded} invalid or duplicate location${excluded === 1 ? '' : 's'} excluded`}{excluded > 0 && normalized.omitted > 0 ? ' · ' : ''}{normalized.omitted > 0 && `${normalized.omitted} additional locations omitted`}</div>}
    {interactive && <span className="paprika-geo-hint" aria-hidden="true">Scroll to zoom · drag to pan</span>}
    </div>
    {canInspect && selected && <section className="paprika-geo-detail" aria-label={`Location details for ${selected.label}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearSelection(); } }}>
      <span className="paprika-geo-detail-kicker">Selected location{concept ? ' · concept' : ''}</span>
      <strong>{selected.label}</strong>
      <div className="paprika-geo-detail-value">{selected.value === null ? <span>No observed value</span> : <><b>{number(selected.value)}</b><span>{valueLabel}</span></>}</div>
      <dl><div><dt>Latitude</dt><dd>{selected.latitude}°</dd></div><div><dt>Longitude</dt><dd>{selected.longitude}°</dd></div><div><dt>Classification</dt><dd><i style={{ background: COLORS[selected.severity] }} aria-hidden="true"/>{classification(selected.severity)}</dd></div></dl>
      <button type="button" aria-label="Close selected location" onClick={() => clearSelection()}>×</button>
    </section>}
  </div>;
}


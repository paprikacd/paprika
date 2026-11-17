/** Pure, projection-independent viewport math. All positions use map viewBox units. */
export type GeoPoint = { x: number; y: number };
export type GeoViewport = { x: number; y: number; k: number };
export type GeoExtent = { width: number; height: number };
export const GEO_MIN_ZOOM = 1;
export const GEO_MAX_ZOOM = 8;
export const INITIAL_GEO_VIEW: GeoViewport = { x: 0, y: 0, k: 1 };

const finiteOr = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const dimension = (value: number) => Math.max(1, finiteOr(value, 1));
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Keep the projected world covering the viewport; a reset is exactly the authored view. */
export function constrainGeoView(view: GeoViewport, extent: GeoExtent): GeoViewport {
  const k = clamp(finiteOr(view.k, 1), GEO_MIN_ZOOM, GEO_MAX_ZOOM);
  return {
    k,
    x: clamp(finiteOr(view.x, 0), dimension(extent.width) * (1 - k), 0) || 0,
    y: clamp(finiteOr(view.y, 0), dimension(extent.height) * (1 - k), 0) || 0,
  };
}

export function geoToScreen(point: GeoPoint, view: GeoViewport): GeoPoint {
  return { x: point.x * view.k + view.x, y: point.y * view.k + view.y };
}

/** Convert a CSS-pixel symbol dimension to the outer SVG's coordinate units.
 * Camera zoom is intentionally absent: geographic positions move under the
 * camera while a presence marker and its hit target keep their screen size. */
export function geoScreenUnits(cssPixels: number, cssScale: number): number {
  return Math.max(0, finiteOr(cssPixels, 0)) / (Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1);
}

/** Preserve the world position under the anchor unless a world boundary constrains it. */
export function zoomGeoAt(view: GeoViewport, factor: number, anchor: GeoPoint, extent: GeoExtent): GeoViewport {
  const before = constrainGeoView(view, extent);
  const k = clamp(before.k * Math.max(0.001, finiteOr(factor, 1)), GEO_MIN_ZOOM, GEO_MAX_ZOOM);
  const x = finiteOr(anchor.x, extent.width / 2), y = finiteOr(anchor.y, extent.height / 2);
  const ratio = k / before.k;
  return constrainGeoView({ k, x: x - (x - before.x) * ratio, y: y - (y - before.y) * ratio }, extent);
}

export type GeoWheelInput = { deltaY: number; deltaX?: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean };

/** Plain wheel zoom is scoped to the map. Null leaves page/browser navigation alone. */
export function geoWheelView(view: GeoViewport, event: GeoWheelInput, anchor: GeoPoint, extent: GeoExtent): GeoViewport | null {
  if (event.ctrlKey || event.metaKey || event.shiftKey || !Number.isFinite(event.deltaY) || event.deltaY === 0 || Math.abs(event.deltaX ?? 0) > Math.abs(event.deltaY)) return null;
  const before = constrainGeoView(view, extent);
  if ((event.deltaY > 0 && before.k <= GEO_MIN_ZOOM) || (event.deltaY < 0 && before.k >= GEO_MAX_ZOOM)) return null;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? dimension(extent.height) : 1;
  const factor = Math.exp(clamp(-event.deltaY * unit * .002, -.7, .7));
  const next = zoomGeoAt(before, factor, {
    x: clamp(finiteOr(anchor.x, extent.width / 2), 0, dimension(extent.width)),
    y: clamp(finiteOr(anchor.y, extent.height / 2), 0, dimension(extent.height)),
  }, extent);
  return next.k === before.k && next.x === before.x && next.y === before.y ? null : next;
}

export function panGeoBy(view: GeoViewport, delta: GeoPoint, extent: GeoExtent): GeoViewport {
  return constrainGeoView({ ...view, x: view.x + finiteOr(delta.x, 0), y: view.y + finiteOr(delta.y, 0) }, extent);
}

/** A pinch preserves its old midpoint and then follows the moving midpoint. */
export function pinchGeo(view: GeoViewport, before: readonly [GeoPoint, GeoPoint], after: readonly [GeoPoint, GeoPoint], extent: GeoExtent): GeoViewport {
  const midpoint = (points: readonly [GeoPoint, GeoPoint]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
  const distance = (points: readonly [GeoPoint, GeoPoint]) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  const previousCenter = midpoint(before), nextCenter = midpoint(after);
  const previousDistance = distance(before);
  const factor = previousDistance > 0.01 ? distance(after) / previousDistance : 1;
  return panGeoBy(zoomGeoAt(view, factor, previousCenter, extent), { x: nextCenter.x - previousCenter.x, y: nextCenter.y - previousCenter.y }, extent);
}

/** Bring an inspected point into the current viewport without altering zoom or data. */
export function revealGeoPoint(view: GeoViewport, point: GeoPoint, extent: GeoExtent, inset = 18): GeoViewport {
  const position = geoToScreen(point, view);
  const margin = Math.max(0, Math.min(inset, extent.width / 2, extent.height / 2));
  const dx = position.x < margin ? margin - position.x : position.x > extent.width - margin ? extent.width - margin - position.x : 0;
  const dy = position.y < margin ? margin - position.y : position.y > extent.height - margin ? extent.height - margin - position.y : 0;
  return panGeoBy(view, { x: dx, y: dy }, extent);
}


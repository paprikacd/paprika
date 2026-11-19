/**
 * Placement for observation inspectors. `placeTooltip` is the single entry
 * point: it places a pointer preview, an anchor (beside it, or above or below),
 * or an inspector outside its widget that avoids obstacles. The settings
 * (`tooltipPlacement`, `tooltipOffset`, `tooltipMaxWidth`, `tooltipMaxHeight`)
 * change the preferred side, the gap and the size caps. Left unset, every
 * function returns what the renderer has always returned.
 * Coordinates are CSS pixels in the layout viewport, including visualViewport offsets.
 */

export type TooltipPlacement = "auto" | "top" | "right" | "bottom" | "left";
export type TooltipSide = Exclude<TooltipPlacement, "auto">;
export interface TooltipRectangle { left: number; right: number; top: number; bottom: number }
export interface TooltipViewport { width: number; height: number; left?: number; top?: number }
export interface TooltipSize { width: number; height: number }
export interface TooltipObstacle extends TooltipRectangle { weight?: number }

/** Validated placement settings. A missing field keeps the default for each placement mode. */
export interface TooltipPlacementOptions {
  /** Preferred side. `auto` keeps each mode's own order. */
  placement?: TooltipPlacement;
  /** Gap between the anchor and the inspector, in px, clamped to 0 to 40. */
  offset?: number;
  /** Largest inspector width, in px. The viewport still limits it. */
  maxWidth?: number;
  /** Largest inspector height, in px. The viewport still limits it. */
  maxHeight?: number;
}

export type TooltipTarget =
  | { kind: "pointer"; point: { x: number; y: number } }
  | { kind: "anchor"; anchor: TooltipRectangle; preferSide?: boolean }
  | { kind: "outside"; anchor: TooltipRectangle; widget: TooltipRectangle; obstacles?: readonly TooltipObstacle[] };

export interface TooltipPosition {
  left: number;
  top: number;
  placement: string;
  /** The height the panel may use here. Content beyond it scrolls inside the panel. */
  maxHeight?: number;
  /** The panel covers its own widget, which happens only when no outside space exists. */
  overlapsWidget?: boolean;
}

export interface OutsideTooltipPosition extends TooltipPosition {
  placement: TooltipSide;
  maxHeight: number;
  overlapsWidget: boolean;
}

const placements: readonly TooltipPlacement[] = ["auto", "top", "right", "bottom", "left"];
const defaultMaxHeight = 560;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
const finiteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const heightCap = (options: TooltipPlacementOptions) => options.maxHeight ?? defaultMaxHeight;
const isSide = (placement: string | undefined): placement is "left" | "right" => placement === "left" || placement === "right";

/** Reads a widget's tooltip settings. Invalid values are dropped, so the defaults apply. */
export function readTooltipPlacement(source: object | null | undefined): TooltipPlacementOptions {
  const record = (source ?? {}) as Record<string, unknown>;
  const placement = placements.find(candidate => candidate === record.tooltipPlacement);
  const offset = finiteNumber(record.tooltipOffset);
  const maxWidth = finiteNumber(record.tooltipMaxWidth);
  const maxHeight = finiteNumber(record.tooltipMaxHeight);
  return {
    ...(placement ? { placement } : {}),
    ...(offset !== undefined ? { offset: clamp(offset, 0, 40) } : {}),
    ...(maxWidth !== undefined && maxWidth > 0 ? { maxWidth } : {}),
    ...(maxHeight !== undefined && maxHeight > 0 ? { maxHeight } : {}),
  };
}

/** The largest inspector beside an anchor, when it sits above or below the anchor. */
export function heatmapTooltipSizeLimit(anchor: Pick<TooltipRectangle, "top" | "bottom">, viewport: TooltipViewport, options: TooltipPlacementOptions = {}) {
  const above = anchor.top - (viewport.top ?? 0) - 22;
  const below = (viewport.top ?? 0) + viewport.height - anchor.bottom - 22;
  return {
    width: Math.max(0, Math.min(viewport.width - 24, options.maxWidth ?? Infinity)),
    height: Math.max(0, Math.min(heightCap(options), viewport.height - 24, Math.max(64, above, below))),
  };
}

/** Above or below the anchor, centred on it. Auto and bottom take the room below; top takes the room above. */
export function placeHeatmapTooltip(anchor: Pick<TooltipRectangle, "left" | "right" | "top" | "bottom">, size: TooltipSize, viewport: TooltipViewport, options: TooltipPlacementOptions = {}): { left: number; top: number; placement: "top" | "bottom" } {
  const margin = 12;
  const gap = options.offset ?? 10;
  const leftEdge = (viewport.left ?? 0) + margin;
  const topEdge = (viewport.top ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= bottomEdge;
  const fitsAbove = above >= topEdge;
  const preferBelow = options.placement === "top" ? !fitsAbove : fitsBelow || !fitsAbove;
  return {
    left: Math.max(leftEdge, Math.min((anchor.left + anchor.right - size.width) / 2, rightEdge - size.width)),
    top: Math.max(topEdge, Math.min(preferBelow ? below : above, bottomEdge - size.height)),
    placement: preferBelow ? "bottom" : "top",
  };
}

/** Leave the sample's vertical track exposed while inspecting adjacent lines. */
export function placePlotTooltip(anchor: Pick<TooltipRectangle, "left" | "right" | "top" | "bottom">, size: TooltipSize, viewport: TooltipViewport, options: TooltipPlacementOptions = {}) {
  const margin = 12;
  const gap = options.offset ?? 16;
  const leftEdge = (viewport.left ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const right = anchor.right + gap;
  const left = anchor.left - gap - size.width;
  const fits: Record<"left" | "right", boolean> = {
    right: right >= leftEdge && right + size.width <= rightEdge,
    left: left >= leftEdge && left + size.width <= rightEdge,
  };
  const order: ("left" | "right")[] = options.placement === "left" ? ["left", "right"] : ["right", "left"];
  const chosen = order.find(candidate => fits[candidate]);
  if (!chosen) return placeHeatmapTooltip(anchor, size, viewport, options);
  const topEdge = (viewport.top ?? 0) + margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  return {
    left: chosen === "right" ? right : left,
    top: Math.max(topEdge, Math.min((anchor.top + anchor.bottom - size.height) / 2, bottomEdge - size.height)),
    placement: chosen,
  };
}

/**
 * The shortest outside slot that can show a reading. On a narrow viewport a slot under 200 px cannot show one (186 px and
 * 103 px slots were seen), so the overlap fallback wins instead; wide viewports keep the 64 px floor.
 */
function narrowMinimumSlot(size: TooltipSize, viewport: TooltipViewport) {
  return viewport.width < 600 ? Math.max(64, Math.min(size.height, 200)) : 64;
}

/** Prefer a free area outside the widget, so inspecting never covers its plot. */
export function placeOutsideWidgetTooltip(widget: TooltipRectangle, anchor: TooltipRectangle, size: TooltipSize, viewport: TooltipViewport, options: TooltipPlacementOptions = {}): OutsideTooltipPosition {
  const margin = 12;
  const gap = options.offset ?? 10;
  const left = (viewport.left ?? 0) + margin, right = (viewport.left ?? 0) + viewport.width - margin;
  const top = (viewport.top ?? 0) + margin, bottom = (viewport.top ?? 0) + viewport.height - margin;
  const maxHeight = Math.max(0, Math.min(heightCap(options), bottom - top));
  const clampedTop = Math.max(top, Math.min((anchor.top + anchor.bottom - size.height) / 2, bottom - Math.min(size.height, maxHeight)));
  const rightStart = Math.max(left, widget.right + gap), leftStart = Math.min(right - size.width, widget.left - gap - size.width);
  const beside = (side: "left" | "right"): OutsideTooltipPosition | undefined => {
    if (side === "right") return rightStart + size.width <= right ? { left: rightStart, top: clampedTop, placement: "right", maxHeight, overlapsWidget: false } : undefined;
    return leftStart >= left ? { left: leftStart, top: clampedTop, placement: "left", maxHeight, overlapsWidget: false } : undefined;
  };
  const minimumSlot = narrowMinimumSlot(size, viewport);
  const vertical = (preferBelow?: boolean): OutsideTooltipPosition | undefined => {
    const aboveEnd = Math.min(bottom, widget.top - gap), belowStart = Math.max(top, widget.bottom + gap);
    const above = Math.max(0, aboveEnd - top), below = Math.max(0, bottom - belowStart);
    if (Math.max(above, below) < minimumSlot) return undefined;
    let useBelow = below >= above;
    if (preferBelow !== undefined && (preferBelow ? below : above) >= minimumSlot) useBelow = preferBelow;
    const available = Math.min(maxHeight, useBelow ? below : above);
    return {
      left: Math.max(left, Math.min((anchor.left + anchor.right - size.width) / 2, right - size.width)),
      top: useBelow ? belowStart : aboveEnd - Math.min(size.height, available),
      placement: useBelow ? "bottom" : "top",
      maxHeight: available,
      overlapsWidget: false,
    };
  };
  const preference = options.placement ?? "auto";
  const attempts: (() => OutsideTooltipPosition | undefined)[] = preference === "top" || preference === "bottom"
    ? [() => vertical(preference === "bottom"), () => beside("right"), () => beside("left")]
    : preference === "left"
      ? [() => beside("left"), () => beside("right"), () => vertical()]
      : [() => beside("right"), () => beside("left"), () => vertical()];
  for (const attempt of attempts) {
    const found = attempt();
    if (found) return found;
  }
  // A full-viewport chart has no outside space. Hover previews pass pointer
  // events through in this case; pinning makes the same panel interactive.
  const fallback = preference === "top" || preference === "bottom"
    ? placeHeatmapTooltip(anchor, size, viewport, options)
    : placePlotTooltip(anchor, size, viewport, options);
  return { ...fallback, maxHeight, overlapsWidget: true };
}

/** Prefer an unobstructed outside position when neighboring panels leave room.
 * When every outside position is occupied, keep the least-obscuring one and
 * retain the existing scrollable, pointer-transparent hover fallback. */
export function placeClearOutsideWidgetTooltip(widget: TooltipRectangle, anchor: TooltipRectangle, size: TooltipSize, viewport: TooltipViewport, obstacles: readonly TooltipObstacle[], options: TooltipPlacementOptions = {}): OutsideTooltipPosition {
  const baseline = placeOutsideWidgetTooltip(widget, anchor, size, viewport, options);
  if (!obstacles.length || baseline.overlapsWidget) return baseline;
  const margin = 12;
  const gap = options.offset ?? 10;
  const left = (viewport.left ?? 0) + margin, right = (viewport.left ?? 0) + viewport.width - margin;
  const top = (viewport.top ?? 0) + margin, bottom = (viewport.top ?? 0) + viewport.height - margin;
  const maxHeight = Math.max(0, Math.min(heightCap(options), bottom - top));
  // The same usable floor as the baseline: a phone never gets a sliver from the obstacle-aware candidates either.
  const minimumSlot = narrowMinimumSlot(size, viewport);
  const overlap = (a: TooltipRectangle, b: TooltipRectangle) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const candidates: OutsideTooltipPosition[] = [baseline];
  const vertical = (placement: "top" | "bottom", boundary: number, available: number) => {
    const limit = Math.min(maxHeight, available);
    if (limit < minimumSlot || right - left < size.width) return;
    const height = Math.min(size.height, limit);
    const y = placement === "top" ? boundary - height : boundary;
    const xs = [(anchor.left + anchor.right - size.width) / 2, left, right - size.width,
      ...obstacles.flatMap(rect => [rect.left - size.width - gap, rect.right + gap])];
    for (const value of xs) candidates.push({ left: clamp(value, left, right - size.width), top: y, placement, maxHeight: limit, overlapsWidget: false });
  };
  const horizontal = (placement: "left" | "right", x: number) => {
    if (x < left || x + size.width > right || maxHeight < minimumSlot) return;
    const height = Math.min(size.height, maxHeight);
    const ys = [(anchor.top + anchor.bottom - height) / 2, top, bottom - height,
      ...obstacles.flatMap(rect => [rect.top - height - gap, rect.bottom + gap])];
    for (const value of ys) candidates.push({ left: x, top: clamp(value, top, bottom - height), placement, maxHeight, overlapsWidget: false });
  };
  vertical("top", Math.min(bottom, widget.top - gap), Math.max(0, Math.min(bottom, widget.top - gap) - top));
  vertical("bottom", Math.max(top, widget.bottom + gap), Math.max(0, bottom - Math.max(top, widget.bottom + gap)));
  horizontal("left", widget.left - gap - size.width);
  horizontal("right", widget.right + gap);
  const score = (candidate: OutsideTooltipPosition) => {
    const height = Math.min(size.height, candidate.maxHeight);
    const rect = { left: candidate.left, right: candidate.left + size.width, top: candidate.top, bottom: candidate.top + height };
    return {
      controls: obstacles.filter(obstacle => (obstacle.weight ?? 1) > 1).reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0),
      other: obstacles.filter(obstacle => (obstacle.weight ?? 1) <= 1).reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0) + (size.height - height) * size.width,
    };
  };
  return candidates.reduce((best, candidate) => {
    const a = score(candidate), b = score(best);
    return a.controls < b.controls || (a.controls === b.controls && a.other < b.other) ? candidate : best;
  }, baseline);
}

/** Use a narrower inspector when it makes room beside the chart. */
export function outsideTooltipWidthLimit(widget: Pick<TooltipRectangle, "left" | "right">, viewport: TooltipViewport, options: TooltipPlacementOptions = {}) {
  const left = (viewport.left ?? 0) + 12;
  const right = (viewport.left ?? 0) + viewport.width - 12;
  const available = Math.max(
    0,
    right - Math.max(left, widget.right + 10),
    Math.min(right, widget.left - 10) - left,
  );
  // Below 240px, retain the comfortable width and try above/below instead.
  return available >= 240
    ? Math.min(options.maxWidth ?? 330, available)
    : Math.max(0, Math.min(right - left, options.maxWidth ?? Infinity));
}

/** Choose room for the full height cap, so asynchronous content cannot flip a preview across the pointer. */
export function placePointerPosition(point: { x: number; y: number }, size: TooltipSize, viewport: TooltipViewport, options: TooltipPlacementOptions = {}): TooltipPosition & { maxHeight: number } {
  const margin = 12;
  const gap = options.offset ?? 16;
  const left = (viewport.left ?? 0) + margin, right = (viewport.left ?? 0) + viewport.width - margin;
  const top = (viewport.top ?? 0) + margin, bottom = (viewport.top ?? 0) + viewport.height - margin;
  const rightPosition = point.x + gap, leftPosition = point.x - gap - size.width;
  const fitsRight = rightPosition + size.width <= right, fitsLeft = leftPosition >= left;
  const useRight = options.placement === "left" ? !fitsLeft : fitsRight || !fitsLeft;
  const x = Math.max(left, Math.min(useRight ? rightPosition : leftPosition, right - size.width));
  const above = Math.max(0, point.y - gap - top), below = Math.max(0, bottom - point.y - gap);
  const minimum = Math.min(64, heightCap(options));
  const useBelow = options.placement === "top"
    ? above < minimum && below > above
    : options.placement === "bottom"
      ? below >= minimum || below >= above
      : below >= Math.min(heightCap(options), above);
  const maxHeight = Math.min(heightCap(options), useBelow ? below : above);
  const y = useBelow ? point.y + gap : point.y - gap - Math.min(size.height, maxHeight);
  return { left: x, top: y, placement: `pointer-${useBelow ? "bottom" : "top"}-${useRight ? "right" : "left"}`, maxHeight };
}

/** The largest size a target may take before it is measured. For an anchor, pass the chosen placement to get the side limit. */
export function tooltipLimit(target: TooltipTarget, viewport: TooltipViewport, options: TooltipPlacementOptions = {}, placement?: string): TooltipSize {
  const viewportHeight = Math.max(0, Math.min(heightCap(options), viewport.height - 24));
  if (target.kind === "pointer") return { width: Math.max(0, Math.min(viewport.width - 24, options.maxWidth ?? Infinity)), height: viewportHeight };
  if (target.kind === "outside") return { width: outsideTooltipWidthLimit(target.widget, viewport, options), height: viewportHeight };
  const vertical = heatmapTooltipSizeLimit(target.anchor, viewport, options);
  return isSide(placement) ? { width: vertical.width, height: viewportHeight } : vertical;
}

/** The single placement entry point for observation inspectors. */
export function placeTooltip(target: TooltipTarget, size: TooltipSize, viewport: TooltipViewport, options: TooltipPlacementOptions = {}): TooltipPosition {
  if (target.kind === "pointer") return placePointerPosition(target.point, size, viewport, options);
  if (target.kind === "outside") return placeClearOutsideWidgetTooltip(target.widget, target.anchor, size, viewport, target.obstacles ?? [], options);
  const sidesAllowed = options.placement === "left" || options.placement === "right" || ((options.placement === undefined || options.placement === "auto") && !!target.preferSide);
  return sidesAllowed
    ? placePlotTooltip(target.anchor, size, viewport, options)
    : placeHeatmapTooltip(target.anchor, size, viewport, options);
}

/**
 * A pointer preview above the pointer, cut short below the lowest control that sits above it, so it never runs
 * under the header or toolbar. Only used when the controls leave less room than the bottom or side candidates.
 */
function pointerAboveControls(target: TooltipTarget, size: TooltipSize, viewport: TooltipViewport, controls: readonly TooltipObstacle[], settings: TooltipPlacementOptions) {
  if (target.kind !== "pointer") return undefined;
  const base = placePointerPosition(target.point, size, viewport, settings);
  const gap = settings.offset ?? 16;
  const topEdge = (viewport.top ?? 0) + 12;
  const floor = controls
    .filter(rect => rect.bottom <= target.point.y && rect.left < base.left + size.width && rect.right > base.left)
    .reduce((edge, rect) => Math.max(edge, rect.bottom + gap), topEdge);
  const maxHeight = Math.min(heightCap(settings), target.point.y - gap - floor);
  if (maxHeight < Math.min(64, heightCap(settings))) return undefined;
  const side = base.placement.endsWith("-left") ? "left" : "right";
  return { left: base.left, top: target.point.y - gap - Math.min(size.height, maxHeight), placement: `pointer-top-${side}`, maxHeight };
}

/**
 * Vertical gaps between the controls that overlap a preview's column, inside the viewport. A preview placed in a gap
 * is centred on the pointer where it can be, so a pointer low on a plot under a tall header still gets a full panel
 * when the free band between the header and the viewport bottom is tall enough.
 */
function pointerFreeBands(target: TooltipTarget, size: TooltipSize, viewport: TooltipViewport, controls: readonly TooltipObstacle[], settings: TooltipPlacementOptions): TooltipPosition[] {
  if (target.kind !== "pointer") return [];
  const margin = 12;
  const gap = settings.offset ?? 16;
  const cap = heightCap(settings);
  const minimum = Math.min(64, cap);
  const topEdge = (viewport.top ?? 0) + margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  const leftEdge = (viewport.left ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const point = target.point;
  const columns = [point.x + gap, point.x - gap - size.width]
    .map(left => Math.max(leftEdge, Math.min(left, rightEdge - size.width)))
    .filter((left, index, all) => all.indexOf(left) === index);
  const bands: TooltipPosition[] = [];
  for (const left of columns) {
    const blocking = controls
      .filter(rect => left < rect.right && left + size.width > rect.left)
      .sort((a, b) => a.top - b.top);
    const spans: [number, number][] = [];
    let cursor = topEdge;
    for (const rect of blocking) {
      if (rect.top - gap > cursor) spans.push([cursor, rect.top - gap]);
      cursor = Math.max(cursor, rect.bottom + gap);
    }
    if (bottomEdge > cursor) spans.push([cursor, bottomEdge]);
    for (const [start, end] of spans) {
      const available = Math.min(cap, end - start);
      if (available < minimum) continue;
      const height = Math.min(size.height, available);
      const top = Math.max(start, Math.min(point.y - height / 2, end - height));
      const side = left > point.x ? "right" : "left";
      bands.push({ left, top, placement: `pointer-band-${side}`, maxHeight: available });
    }
  }
  return bands;
}

/**
 * A pointer preview takes a placement that clears the controls, in the author's order. A panel that already fits
 * its full height wins at once; otherwise the clear candidate with the most visible height wins, so a pointer low
 * on the plot keeps a usable panel instead of a sliver. A free band between the controls is the last resort when
 * that height stays under 75% of the panel. With no clear candidate, the first candidate is kept.
 */
export function placePointerAvoiding(target: TooltipTarget, size: TooltipSize, viewport: TooltipViewport, obstacles: readonly TooltipObstacle[], settings: TooltipPlacementOptions) {
  const controls = obstacles.filter(obstacle => (obstacle.weight ?? 1) > 1);
  const order: TooltipPlacement[] = [settings.placement ?? "auto", "auto", "top", "bottom", "left", "right"];
  const candidates = order.map(placement => placeTooltip(target, size, viewport, { ...settings, placement }));
  const above = pointerAboveControls(target, size, viewport, controls, settings);
  if (above) candidates.push(above);
  const visibleHeight = (next: ReturnType<typeof placeTooltip>) => Math.min(size.height, next.maxHeight ?? size.height);
  const clears = (next: ReturnType<typeof placeTooltip>) => {
    const height = visibleHeight(next);
    return !controls.some(rect => next.left < rect.right && next.left + size.width > rect.left && next.top < rect.bottom && next.top + height > rect.top);
  };
  let best: ReturnType<typeof placeTooltip> | undefined;
  for (const next of candidates) {
    if (!clears(next)) continue;
    if (visibleHeight(next) >= size.height) return next;
    if (!best || visibleHeight(next) > visibleHeight(best)) best = next;
  }
  // A free band may cover the pointer's own column, so it only wins when every pointer-side slot is under 75% of the panel.
  if (!best || visibleHeight(best) < size.height * 0.75) {
    for (const next of pointerFreeBands(target, size, viewport, controls, settings)) {
      if (!clears(next)) continue;
      if (!best || visibleHeight(next) > visibleHeight(best)) best = next;
    }
  }
  return best ?? candidates[0]!;
}

/** All coordinates are CSS pixels in the layout viewport, including visualViewport offsets. */
export interface TooltipAnchor { left: number; right: number; top: number; bottom: number }
export interface TooltipViewport { width: number; height: number; left?: number; top?: number }
export type TooltipPlacement = 'auto' | 'top' | 'right' | 'bottom' | 'left';
export type TooltipSide = Exclude<TooltipPlacement, 'auto'>;
export interface TooltipSize { width: number; height: number }
export interface TooltipPosition extends TooltipSize { left: number; top: number; placement: TooltipSide }

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

export function tooltipViewportBounds(viewport: TooltipViewport) {
  const width = Math.max(0, finite(viewport.width)), height = Math.max(0, finite(viewport.height));
  const marginX = Math.min(12, width / 2), marginY = Math.min(12, height / 2);
  const left = finite(viewport.left ?? 0) + marginX, top = finite(viewport.top ?? 0) + marginY;
  return { left, top, right: left + width - marginX * 2, bottom: top + height - marginY * 2,
    width: width - marginX * 2, height: height - marginY * 2 };
}

export function limitTooltipSize(size: TooltipSize, viewport: TooltipViewport): TooltipSize {
  const bounds = tooltipViewportBounds(viewport);
  return { width: clamp(finite(size.width), 0, bounds.width), height: clamp(finite(size.height), 0, bounds.height) };
}

/** Flip the preferred side, shift on its other axis, and contain oversized content. */
export function positionObservationTooltip(
  anchor: TooltipAnchor,
  desired: TooltipSize,
  viewport: TooltipViewport,
  preferred: TooltipPlacement = 'auto',
  offset = 12,
): TooltipPosition {
  const bounds = tooltipViewportBounds(viewport), size = limitTooltipSize(desired, viewport);
  const gap = clamp(finite(offset, 12), 0, 40);
  const origin = {
    left: clamp(finite(anchor.left, bounds.left), bounds.left, bounds.right),
    right: clamp(finite(anchor.right, bounds.left), bounds.left, bounds.right),
    top: clamp(finite(anchor.top, bounds.top), bounds.top, bounds.bottom),
    bottom: clamp(finite(anchor.bottom, bounds.top), bounds.top, bounds.bottom),
  };
  const available = {
    right: Math.max(0, bounds.right - origin.right - gap),
    left: Math.max(0, origin.left - bounds.left - gap),
    bottom: Math.max(0, bounds.bottom - origin.bottom - gap),
    top: Math.max(0, origin.top - bounds.top - gap),
  };
  const opposite: Record<TooltipSide, TooltipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const defaults: TooltipSide[] = ['right', 'left', 'bottom', 'top'];
  const sides = preferred === 'auto' ? defaults : [preferred, opposite[preferred], ...defaults.filter(side => side !== preferred && side !== opposite[preferred])];
  let placement = sides.find(side => available[side] >= (side === 'left' || side === 'right' ? size.width : size.height));
  let height = size.height;
  if (!placement) {
    // Preserve readable width in a narrow viewport and scroll the shorter panel.
    placement = available.bottom >= available.top ? 'bottom' : 'top';
    if (available[placement] >= Math.min(64, size.height)) height = Math.min(height, available[placement]);
  }
  const point = origin.left === origin.right && origin.top === origin.bottom;
  const centerX = (origin.left + origin.right - size.width) / 2;
  const centerY = point ? origin.top + gap : (origin.top + origin.bottom - height) / 2;
  const rawLeft = placement === 'right' ? origin.right + gap : placement === 'left' ? origin.left - gap - size.width : point ? origin.left + gap : centerX;
  const rawTop = placement === 'bottom' ? origin.bottom + gap : placement === 'top' ? origin.top - gap - height : centerY;
  return { left: clamp(rawLeft, bounds.left, bounds.right - size.width), top: clamp(rawTop, bounds.top, bounds.bottom - height),
    width: size.width, height, placement };
}

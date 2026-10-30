"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { correctPortalPosition, installTooltipPointerTracking, placePointerTooltip, pointerOverAnchor } from "./tooltip-pointer";
import { inheritGammaTheme } from "./gamma/inherit-theme";
import { GammaButton } from "./gamma/button";
import { TooltipInstructions } from "./tooltip-instructions";
import configStyles from "./chart-styles.module.css";

interface TooltipViewport {
  width: number;
  height: number;
  left?: number;
  top?: number;
}
export function heatmapTooltipSizeLimit(
  anchor: Pick<DOMRect, "top" | "bottom">,
  viewport: TooltipViewport,
) {
  const above = anchor.top - (viewport.top ?? 0) - 22;
  const below = (viewport.top ?? 0) + viewport.height - anchor.bottom - 22;
  return {
    width: Math.max(0, viewport.width - 24),
    height: Math.max(
      0,
      Math.min(560, viewport.height - 24, Math.max(64, above, below)),
    ),
  };
}
export function placeHeatmapTooltip(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  size: { width: number; height: number },
  viewport: TooltipViewport,
) {
  const margin = 12;
  const gap = 10;
  const leftEdge = (viewport.left ?? 0) + margin;
  const topEdge = (viewport.top ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const preferBelow = below + size.height <= bottomEdge || above < topEdge;
  return {
    left: Math.max(
      leftEdge,
      Math.min(
        (anchor.left + anchor.right - size.width) / 2,
        rightEdge - size.width,
      ),
    ),
    top: Math.max(
      topEdge,
      Math.min(preferBelow ? below : above, bottomEdge - size.height),
    ),
    placement: preferBelow ? "bottom" : "top",
  };
}

/** Leave the sample's vertical track exposed while inspecting adjacent lines. */
export function placePlotTooltip(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  size: { width: number; height: number },
  viewport: TooltipViewport,
) {
  const margin = 12;
  const gap = 16;
  const leftEdge = (viewport.left ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const right = anchor.right + gap;
  const left = anchor.left - gap - size.width;
  const fitsRight = right >= leftEdge && right + size.width <= rightEdge;
  const fitsLeft = left >= leftEdge && left + size.width <= rightEdge;
  if (!fitsRight && !fitsLeft) return placeHeatmapTooltip(anchor, size, viewport);
  const topEdge = (viewport.top ?? 0) + margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  return {
    left: fitsRight ? right : left,
    top: Math.max(
      topEdge,
      Math.min(
        (anchor.top + anchor.bottom - size.height) / 2,
        bottomEdge - size.height,
      ),
    ),
    placement: fitsRight ? "right" : "left",
  };
}

/** Prefer a free area outside the widget, so inspecting never covers its plot. */
export function placeOutsideWidgetTooltip(
  widget: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  size: { width: number; height: number },
  viewport: TooltipViewport,
) {
  const margin = 12, gap = 10;
  const left = (viewport.left ?? 0) + margin, right = (viewport.left ?? 0) + viewport.width - margin;
  const top = (viewport.top ?? 0) + margin, bottom = (viewport.top ?? 0) + viewport.height - margin;
  const maxHeight = Math.max(0, Math.min(560, bottom - top));
  const clampedTop = Math.max(top, Math.min((anchor.top + anchor.bottom - size.height) / 2, bottom - Math.min(size.height, maxHeight)));
  const rightStart = Math.max(left, widget.right + gap), leftStart = Math.min(right - size.width, widget.left - gap - size.width);
  if (rightStart + size.width <= right)
    return { left: rightStart, top: clampedTop, placement: "right", maxHeight, overlapsWidget: false };
  if (leftStart >= left)
    return { left: leftStart, top: clampedTop, placement: "left", maxHeight, overlapsWidget: false };
  const aboveEnd = Math.min(bottom, widget.top - gap), belowStart = Math.max(top, widget.bottom + gap);
  const above = Math.max(0, aboveEnd - top), below = Math.max(0, bottom - belowStart);
  if (Math.max(above, below) >= 64) {
    const useBelow = below >= above, available = Math.min(maxHeight, useBelow ? below : above);
    return {
      left: Math.max(left, Math.min((anchor.left + anchor.right - size.width) / 2, right - size.width)),
      top: useBelow ? belowStart : aboveEnd - Math.min(size.height, available),
      placement: useBelow ? "bottom" : "top", maxHeight: available, overlapsWidget: false,
    };
  }
  // A full-viewport chart has no outside space. Hover previews pass pointer
  // events through in this case; pinning makes the same panel interactive.
  return { ...placePlotTooltip(anchor, size, viewport), maxHeight, overlapsWidget: true };
}

type TooltipRectangle = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
type TooltipObstacle = TooltipRectangle & { weight?: number };

/** Prefer an unobstructed outside position when neighboring panels leave room.
 * When every outside position is occupied, keep the least-obscuring one and
 * retain the existing scrollable, pointer-transparent hover fallback. */
export function placeClearOutsideWidgetTooltip(
  widget: TooltipRectangle,
  anchor: TooltipRectangle,
  size: { width: number; height: number },
  viewport: TooltipViewport,
  obstacles: readonly TooltipObstacle[],
) {
  const baseline = placeOutsideWidgetTooltip(widget, anchor, size, viewport);
  if (!obstacles.length || baseline.overlapsWidget) return baseline;
  const left = (viewport.left ?? 0) + 12, right = (viewport.left ?? 0) + viewport.width - 12;
  const top = (viewport.top ?? 0) + 12, bottom = (viewport.top ?? 0) + viewport.height - 12;
  const gap = 10, maxHeight = Math.max(0, Math.min(560, bottom - top));
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  const overlap = (a: TooltipRectangle, b: TooltipRectangle) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const candidates = [baseline];
  const vertical = (placement: "top" | "bottom", boundary: number, available: number) => {
    const limit = Math.min(maxHeight, available);
    if (limit < 64 || right - left < size.width) return;
    const height = Math.min(size.height, limit);
    const y = placement === "top" ? boundary - height : boundary;
    const xs = [(anchor.left + anchor.right - size.width) / 2, left, right - size.width,
      ...obstacles.flatMap(rect => [rect.left - size.width - gap, rect.right + gap])];
    for (const value of xs) candidates.push({ left: clamp(value, left, right - size.width), top: y, placement, maxHeight: limit, overlapsWidget: false });
  };
  const horizontal = (placement: "left" | "right", x: number) => {
    if (x < left || x + size.width > right || maxHeight < 64) return;
    const height = Math.min(size.height, maxHeight);
    const ys = [(anchor.top + anchor.bottom - height) / 2, top, bottom - height,
      ...obstacles.flatMap(rect => [rect.top - height - gap, rect.bottom + gap])];
    for (const value of ys) candidates.push({ left: x, top: clamp(value, top, bottom - height), placement, maxHeight, overlapsWidget: false });
  };
  vertical("top", Math.min(bottom, widget.top - gap), Math.max(0, Math.min(bottom, widget.top - gap) - top));
  vertical("bottom", Math.max(top, widget.bottom + gap), Math.max(0, bottom - Math.max(top, widget.bottom + gap)));
  horizontal("left", widget.left - gap - size.width);
  horizontal("right", widget.right + gap);
  const score = (candidate: typeof baseline) => {
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
export function outsideTooltipWidthLimit(
  widget: Pick<DOMRect, "left" | "right">,
  viewport: TooltipViewport,
) {
  const left = (viewport.left ?? 0) + 12;
  const right = (viewport.left ?? 0) + viewport.width - 12;
  const available = Math.max(
    0,
    right - Math.max(left, widget.right + 10),
    Math.min(right, widget.left - 10) - left,
  );
  // Below 240px, retain the comfortable width and try above/below instead.
  return available >= 240 ? Math.min(330, available) : Math.max(0, right - left);
}

/** A transient overlay must not intercept pointer movement over another tile. */
export function tooltipOverlapsOtherWidget(
  panel: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  owner: Element,
) {
  return [...document.querySelectorAll("[data-widget-id]")].some(other => {
    if (other === owner || other.contains(owner) || owner.contains(other)) return false;
    const bounds = other.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && panel.left < bounds.right && panel.right > bounds.left && panel.top < bounds.bottom && panel.bottom > bounds.top;
  });
}

export function ObservationTooltip({
  id,
  anchor,
  anchorRect,
  preferSide = false,
  anchorOwnsHistoryKeys = false,
  avoidWidget = false,
  pinned = false,
  panelRef,
  role = "tooltip",
  ariaLabel,
  className,
  tabIndex,
  onDismiss,
  onEnter,
  onLeave,
  children,
}: {
  id: string;
  anchor: Element;
  anchorRect?: () => DOMRect;
  preferSide?: boolean;
  /** Home/End belong to an interactive history trigger, not panel scrolling. */
  anchorOwnsHistoryKeys?: boolean;
  avoidWidget?: boolean;
  pinned?: boolean;
  panelRef?: (element: HTMLDivElement | null) => void;
  role?: "tooltip" | "region";
  ariaLabel?: string;
  className?: string;
  tabIndex?: number;
  onDismiss: () => void;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [compactState, setCompactState] = useState({ anchor, pinned, minimized: false });
  if (compactState.anchor !== anchor || compactState.pinned !== pinned) {
    setCompactState({ anchor, pinned, minimized: false });
  }
  const minimized = narrow && pinned && compactState.anchor === anchor && compactState.pinned === pinned && compactState.minimized;
  const dismissRef = useRef(onDismiss);
  const pinnedRef = useRef(pinned);
  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
    pinnedRef.current = pinned;
  }, [onDismiss, pinned]);
  useEffect(() => {
    // A stationary pointer can acquire a new hover target after scrolling
    // while another chart still has focus. Keep transient previews singular;
    // explicitly pinned observations remain under the user's control.
    const opened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id && !pinnedRef.current) dismissRef.current();
    };
    document.addEventListener("paprika:observation-open", opened);
    document.dispatchEvent(new CustomEvent("paprika:observation-open", { detail: id }));
    return () => document.removeEventListener("paprika:observation-open", opened);
  }, [id]);
  const assignRef = useCallback((element: HTMLDivElement | null) => { ref.current = element; panelRef?.(element); }, [panelRef]);
  const [position, setPosition] = useState<ReturnType<
    typeof placeHeatmapTooltip
  > & { overlapsWidget?: boolean; overlapsOtherWidget?: boolean; overlapsControls?: boolean; pointer?: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !position) return;
    const actual = element.getBoundingClientRect();
    const corrected = correctPortalPosition(position, actual, { width: element.offsetWidth, height: element.offsetHeight });
    element.style.left = `${corrected.left}px`;
    element.style.top = `${corrected.top}px`;
  }, [position]);
  useLayoutEffect(() => {
    let frame = 0;
    const stopPointer = installTooltipPointerTracking();
    const stopTheme = ref.current ? inheritGammaTheme(anchor, ref.current) : undefined;
    const update = () => {
      const element = ref.current;
      if (!element || !anchor.isConnected) return;
      const viewport = window.visualViewport;
      const visibleViewport = {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        left: viewport?.offsetLeft,
        top: viewport?.offsetTop,
      };
      setNarrow(visibleViewport.width < 600);
      const anchorBounds = anchorRect?.() ?? anchor.getBoundingClientRect();
      const limits = heatmapTooltipSizeLimit(anchorBounds, visibleViewport);
      const pointer = !pinned ? pointerOverAnchor(anchor) : undefined;
      if (pointer) {
        element.style.maxWidth = `${Math.max(0, visibleViewport.width - 24)}px`;
        element.style.maxHeight = `${Math.max(0, Math.min(560, visibleViewport.height - 24))}px`;
        const next = placePointerTooltip(pointer, element.getBoundingClientRect(), visibleViewport);
        element.style.maxHeight = `${next.maxHeight}px`;
        setPosition(previous => previous?.pointer && previous.left === next.left && previous.top === next.top && previous.placement === next.placement ? previous : { ...next, pointer: true });
        return;
      }
      if (avoidWidget) {
        const widget = anchor.closest("[data-widget-id]") ?? anchor.parentElement ?? anchor;
        const widgetBounds = widget.getBoundingClientRect();
        // Keep inspectors inside the dashboard canvas rather than covering
        // navigation or the settings panel alongside it. Dialogs and charts
        // outside a dashboard retain the ordinary viewport bounds.
        const canvas = anchor.closest('[data-testid="dashboard-canvas"]');
        const canvasBounds = canvas?.getBoundingClientRect();
        const canvasLeft = Math.max(visibleViewport.left ?? 0, canvasBounds?.left ?? (visibleViewport.left ?? 0));
        const canvasRight = Math.min((visibleViewport.left ?? 0) + visibleViewport.width, canvasBounds?.right ?? ((visibleViewport.left ?? 0) + visibleViewport.width));
        const tooltipViewport = canvasBounds && canvasRight - canvasLeft >= 240
          ? { ...visibleViewport, left: canvasLeft, width: canvasRight - canvasLeft }
          : visibleViewport;
        const obstacles = [...document.querySelectorAll("[data-widget-id], [data-tooltip-obstacle]")].flatMap(other => {
          if (other === widget || other.contains(widget) || widget.contains(other)) return [];
          const bounds = other.getBoundingClientRect();
          const viewportLeft = tooltipViewport.left ?? 0, viewportTop = tooltipViewport.top ?? 0;
          return bounds.width > 0 && bounds.height > 0 && bounds.right > viewportLeft && bounds.left < viewportLeft + tooltipViewport.width && bounds.bottom > viewportTop && bounds.top < viewportTop + tooltipViewport.height
            ? [{ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, weight: other.hasAttribute("data-tooltip-obstacle") ? 8 : 1 }]
            : [];
        });
        element.style.maxWidth = `${outsideTooltipWidthLimit(widgetBounds, tooltipViewport)}px`;
        // Clear a previous placement's height restriction before measuring.
        // Otherwise an expanding tooltip is scored as if its clipped height
        // were its full height, and the second placement can choose a smaller
        // space without applying that new space's height limit.
        element.style.maxHeight = `${Math.max(0, Math.min(560, tooltipViewport.height - 24))}px`;
        const next = placeClearOutsideWidgetTooltip(widgetBounds, anchorBounds, element.getBoundingClientRect(), tooltipViewport, obstacles);
        element.style.maxHeight = `${next.maxHeight}px`;
        const size = element.getBoundingClientRect();
        const overlapsOtherWidget = tooltipOverlapsOtherWidget({ left: next.left, right: next.left + size.width, top: next.top, bottom: next.top + size.height }, widget);
        const overlapsControls = obstacles.some(rect => rect.weight === 8 && next.left < rect.right && next.left + size.width > rect.left && next.top < rect.bottom && next.top + size.height > rect.top);
        setPosition(previous => !previous?.pointer && previous?.left === next.left && previous?.top === next.top && previous?.placement === next.placement && previous?.overlapsWidget === next.overlapsWidget && previous?.overlapsOtherWidget === overlapsOtherWidget && previous?.overlapsControls === overlapsControls ? previous : { ...next, overlapsOtherWidget, overlapsControls });
        return;
      }
      element.style.maxWidth = `${limits.width}px`;
      const candidate = preferSide
        ? placePlotTooltip(
            anchorBounds,
            element.getBoundingClientRect(),
            visibleViewport,
          )
        : null;
      const useSide =
        candidate?.placement === "left" || candidate?.placement === "right";
      // Side panels leave neighboring lines reachable; vertical panels must
      // scroll before they can overlap the trigger that pins or dismisses them.
      element.style.maxHeight = `${
        useSide
          ? Math.max(0, Math.min(560, visibleViewport.height - 24))
          : limits.height
      }px`;
      const bounds = element.getBoundingClientRect();
      const next = useSide
        ? placePlotTooltip(anchorBounds, bounds, visibleViewport)
        : placeHeatmapTooltip(anchorBounds, bounds, visibleViewport);
      setPosition((previous) =>
        !previous?.pointer && previous?.left === next.left &&
        previous?.top === next.top &&
        previous?.placement === next.placement
          ? previous
          : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const followPointer = (event: PointerEvent) => {
      if (!pinned && event.pointerType !== "touch" && event.target instanceof Node && anchor.contains(event.target)) schedule();
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    // A scroll-capped panel can gain content without its border box resizing.
    // Observe content changes as well, so async results and pinning can choose
    // a better position instead of retaining a stale small height limit.
    const contentObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(schedule);
    if (ref.current) observer?.observe(ref.current);
    if (ref.current) contentObserver?.observe(ref.current, { subtree: true, childList: true, characterData: true });
    observer?.observe(anchor);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("pointermove", followPointer, true);
    document.addEventListener("keydown", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      stopTheme?.();
      stopPointer();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      contentObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointermove", followPointer, true);
      document.removeEventListener("keydown", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [anchor, anchorRect, preferSide, avoidWidget, minimized, pinned]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (
        !anchor.contains(event.target as Node) &&
        !ref.current?.contains(event.target as Node)
      )
        onDismiss();
    };
    const focus = (event: FocusEvent) => {
      if (!pinned && !anchor.contains(event.target as Node) && !ref.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // A focused Gamma menu/listbox owns the first Escape even though its
        // panel is portaled away from the widget and observation tooltip.
        if (event.target instanceof Element && event.target.closest("[data-gamma-portal]")) return;
        // A fading hover card must not swallow Escape from another chart.
        if (anchor.contains(event.target as Node) || ref.current?.contains(event.target as Node)) {
          event.preventDefault();
          event.stopPropagation();
        }
        onDismiss();
        return;
      }
      const element = ref.current;
      if (
        element &&
        !(anchorOwnsHistoryKeys && anchor.contains(event.target as Node) && ["Home", "End"].includes(event.key)) &&
        (event.target === anchor || (role !== "region" && element.contains(event.target as Node))) &&
        ["PageDown", "PageUp", "Home", "End"].includes(event.key)
      ) {
        // A tooltip does not take focus away from its trigger. Let keyboard
        // users inspect every label while keeping the chart's tab order intact.
        event.preventDefault();
        event.stopPropagation();
        const maximum = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        const page = Math.max(48, Math.round(element.clientHeight * 0.8));
        element.scrollTop =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? maximum
              : Math.max(
                  0,
                  Math.min(
                    maximum,
                    element.scrollTop +
                      (event.key === "PageDown" ? page : -page),
                  ),
                );
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [anchor, onDismiss, pinned, role, anchorOwnsHistoryKeys]);
  return createPortal(
    <div
      ref={assignRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      className={`${configStyles.heatmapTooltip} ${className ?? ""}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: minimized ? "max-content" : undefined,
        visibility: position ? "visible" : "hidden",
        pointerEvents: !pinned && (position?.pointer || (avoidWidget && (position?.overlapsWidget || position?.overlapsOtherWidget || position?.overlapsControls))) ? "none" : undefined,
      }}
      data-placement={position?.placement}
      data-tooltip-pointer={position?.pointer || undefined}
      data-tooltip-overlap={position?.overlapsWidget || undefined}
      data-tooltip-overlaps-other-widget={position?.overlapsOtherWidget || undefined}
      data-tooltip-overlaps-controls={position?.overlapsControls || undefined}
      data-inspector-minimized={minimized || undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocusCapture={onEnter}
      onBlurCapture={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          !anchor.contains(event.relatedTarget as Node | null)
        )
          onLeave();
      }}
    >
      {pinned && avoidWidget && narrow && (minimized || position?.overlapsWidget || position?.overlapsOtherWidget || position?.overlapsControls) && (
        <div className={configStyles.tooltipCompactControls}>
          <GammaButton variant="ghost" size="sm" aria-label={minimized ? "Show inspector details" : "Minimize inspector"} aria-expanded={!minimized} aria-controls={`${id}-details`} onClick={() => setCompactState({ anchor, pinned, minimized: !minimized })}>
            {minimized ? "Show details" : "Minimize"}
          </GammaButton>
          {minimized && <GammaButton variant="ghost" size="sm" aria-label="Close inspector" onClick={() => {
            const returnFocus = ref.current?.contains(document.activeElement);
            if (returnFocus && (anchor instanceof HTMLElement || anchor instanceof SVGElement)) anchor.focus({ preventScroll: true });
            onDismiss();
          }}>Close</GammaButton>}
        </div>
      )}
      <div id={`${id}-details`} hidden={minimized}>{children}</div>
    </div>,
    // Native dialogs occupy the browser top layer; a body portal would render
    // behind them even with a high z-index. Escape the chart within that layer.
    anchor.closest("dialog[open]") ?? document.body,
  );
}


/** Pointer preview and click/tap pinning share the same keyboard-readable panel. */
export function ObservationDetails({
  label,
  children,
  details,
  onSelect,
  enabled = true,
  pointerPreview = true,
  className,
  revision,
  externalAnchor,
  avoidWidget = true,
  selectOnFocus = true,
  tabIndex,
}: {
  label: string;
  children: ReactNode;
  details: ReactNode;
  onSelect?: () => void;
  enabled?: boolean;
  pointerPreview?: boolean;
  className?: string;
  revision?: unknown;
  externalAnchor?: Element;
  avoidWidget?: boolean;
  /** Some contexts change dashboard variables only on explicit activation. */
  selectOnFocus?: boolean;
  /** A dense visual can expose individual observations through a separate keyboard-accessible explorer. */
  tabIndex?: number;
}) {
  const id = useId();
  const [active, setActive] = useState<{
    anchor: Element;
    pinned: boolean;
    revision: unknown;
  } | null>(null);
  const interaction = useRef({ focused: false, hovered: false, panel: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHide = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => {
    clearHide();
    interaction.current.panel = false;
    setActive(null);
  }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide();
    timer.current = setTimeout(() => {
      const state = interaction.current;
      setActive((current) =>
        current &&
        !current.pinned &&
        !state.focused &&
        !state.hovered &&
        !state.panel
          ? null
          : current,
      );
    }, 180);
  }, [clearHide]);
  useEffect(() => clearHide, [clearHide]);
  useEffect(() => enabled ? installTooltipPointerTracking() : undefined, [enabled]);
  useEffect(() => {
    if (!externalAnchor || !enabled) return;
    let disposed = false;
    const interactionState = interaction.current;
    interactionState.hovered = true;
    clearHide();
    queueMicrotask(() => {
      if (!disposed)
        setActive((current) =>
          current?.pinned
            ? current
            : { anchor: externalAnchor, pinned: false, revision },
        );
    });
    return () => {
      disposed = true;
      interactionState.hovered = false;
      scheduleHide();
    };
  }, [externalAnchor, enabled, revision, clearHide, scheduleHide]);
  if (active && (active.revision !== revision || !enabled)) {
    setActive(null);
  }
  const show = (anchor: HTMLButtonElement, pinned = false) => {
    clearHide();
    if (!enabled) return;

    setActive({ anchor, pinned, revision });
  };
  if (!enabled && !onSelect)
    return <span className={className}>{children}</span>;
  return (
    <>
      <GammaButton
        variant="ghost"
        className={className ?? configStyles.observationTrigger}
        aria-label={label}
        aria-describedby={active ? id : undefined}
        aria-pressed={enabled ? (active?.pinned ?? false) : undefined}
        tabIndex={tabIndex}
        onPointerEnter={(event) => {
          if (!pointerPreview || event.pointerType === "touch") return;
          interaction.current.hovered = true;
          if (!active?.pinned) show(event.currentTarget);
        }}
        onPointerLeave={() => {
          interaction.current.hovered = false;
          scheduleHide();
        }}
        onFocus={(event) => {
          interaction.current.focused = true;
          if (selectOnFocus) onSelect?.();
          if (!active?.pinned) show(event.currentTarget);
        }}
        onBlur={() => {
          interaction.current.focused = false;
          // Focus can move into the portaled content. Pinned observations
          // remain open until explicitly dismissed.
          scheduleHide();
        }}
        onClick={(event) => {
          onSelect?.();
          if (active?.pinned) dismiss();
          else show(event.currentTarget, true);
        }}
      >
        {children}
      </GammaButton>
      {active && enabled && (
        <ObservationTooltip
          id={id}
          anchor={active.anchor}
          avoidWidget={avoidWidget}
          pinned={active.pinned}
          onDismiss={dismiss}
          onEnter={() => {
            interaction.current.panel = true;
            clearHide();
          }}
          onLeave={() => {
            interaction.current.panel = false;
            scheduleHide();
          }}
        >
          {details}
          <div className={configStyles.tooltipFooter}>
            <small><TooltipInstructions /></small>
            <small>
              {active.pinned
                ? "Pinned · tap again to close"
                : "Click or tap to keep open"}
            </small>
          </div>
        </ObservationTooltip>
      )}
    </>
  );
}

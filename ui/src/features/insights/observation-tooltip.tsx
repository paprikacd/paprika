"use client";

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { correctPortalPosition, installTooltipPointerTracking, pointerOverAnchor } from "./tooltip-pointer";
import { inheritGammaTheme } from "./gamma/inherit-theme";
import { GammaButton } from "./gamma/button";
import { TooltipInstructions } from "./tooltip-instructions";
import configStyles from "./chart-styles.module.css";
import { placeTooltip, tooltipLimit, type TooltipObstacle, type TooltipPlacementOptions, type TooltipPosition, type TooltipTarget, type TooltipViewport } from "./tooltip-position";
import { attachTooltipDismissal, useTooltipDismiss, type TooltipDismissalTarget } from "./tooltip-dismiss";
import { isRestoringTooltipFocus, restoreTooltipFocus, tooltipFocusOwner, withTooltipDismissReason, type TooltipDismissReason } from "./tooltip-focus";
import { registerNestedPanel, TooltipOwnerContext, tooltipScopeFor, useProvidedTooltipScope } from "./tooltip-interaction";

export {
  heatmapTooltipSizeLimit,
  outsideTooltipWidthLimit,
  placeClearOutsideWidgetTooltip,
  placeHeatmapTooltip,
  placeOutsideWidgetTooltip,
  placePlotTooltip,
  placeTooltip,
  readTooltipPlacement,
} from "./tooltip-position";
export type { TooltipPlacement, TooltipPlacementOptions, TooltipTarget } from "./tooltip-position";
export { WidgetTooltipProvider } from "./tooltip-interaction";
export type { TooltipDismissReason } from "./tooltip-focus";

/** Announces a new transient preview page-wide, so an older one closes. */
const openedEvent = "paprika:observation-open";

/** Whether the nearby dashboard widgets leave the tooltip's rectangle clear. */
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

type PanelPosition = TooltipPosition & {
  pointer?: boolean;
  overlapsOtherWidget?: boolean;
  overlapsControls?: boolean;
};

const noOwner = () => null;

export interface ObservationTooltipProps {
  id: string;
  anchor: Element;
  anchorRect?: () => DOMRect;
  preferSide?: boolean;
  /** Home/End belong to an interactive history trigger, not panel scrolling. */
  anchorOwnsHistoryKeys?: boolean;
  avoidWidget?: boolean;
  pinned?: boolean;
  /** Placement, gap and size limits from the widget's tooltip settings. Unset fields keep the defaults. */
  options?: TooltipPlacementOptions;
  panelRef?: (element: HTMLDivElement | null) => void;
  role?: "tooltip" | "region";
  ariaLabel?: string;
  className?: string;
  tabIndex?: number;
  /** Receives why the panel closed. Callers that ignore the reason need not read it. */
  onDismiss: (reason?: TooltipDismissReason) => void;
  onEnter?: () => void;
  onLeave?: () => void;
  children: ReactNode;
}

/** One panel for an observation. Its scope gives a pinned owner precedence, and its dismissal path is shared. */
export function ObservationTooltip({
  id,
  anchor,
  anchorRect,
  preferSide = false,
  anchorOwnsHistoryKeys = false,
  avoidWidget = false,
  pinned = false,
  options,
  panelRef,
  role = "tooltip",
  ariaLabel,
  className,
  tabIndex,
  onDismiss,
  onEnter,
  onLeave,
  children,
}: ObservationTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const provided = useProvidedTooltipScope();
  const store = useMemo(() => tooltipScopeFor(anchor, provided), [anchor, provided]);
  const [token] = useState(() => Symbol("observation-tooltip"));
  // An inspector rendered inside another panel nests under it and never competes with it.
  const nestedUnder = useContext(TooltipOwnerContext), nested = nestedUnder !== null;
  const owner = useSyncExternalStore(store.subscribe, store.getOwner, noOwner);
  const ownsPanel = nested || owner === token;
  const [narrow, setNarrow] = useState(false);
  const [compactState, setCompactState] = useState({ anchor, pinned, minimized: false });
  if (compactState.anchor !== anchor || compactState.pinned !== pinned) {
    setCompactState({ anchor, pinned, minimized: false });
  }
  const minimized = narrow && pinned && compactState.anchor === anchor && compactState.pinned === pinned && compactState.minimized;
  const placementPreference = options?.placement, offset = options?.offset, maxWidth = options?.maxWidth, maxHeight = options?.maxHeight;
  const settings = useMemo<TooltipPlacementOptions>(
    () => ({ placement: placementPreference, offset, maxWidth, maxHeight }),
    [placementPreference, offset, maxWidth, maxHeight],
  );
  const latest = useRef({ onDismiss, onEnter, onLeave, anchorRect });
  useLayoutEffect(() => {
    latest.current = { onDismiss, onEnter, onLeave, anchorRect };
  });
  // What the dismissal bindings and the scope see of this panel. Null while it does not own the panel.
  const dismissal = useRef<TooltipDismissalTarget | null>(null);
  const dismissWith = useCallback((reason: TooltipDismissReason) => {
    // Explicit Close and Escape return focus to the opener. Passive dismissal keeps the user's new focus.
    const returnFocus = (reason === "escape" || reason === "close") && !!ref.current?.contains(document.activeElement);
    withTooltipDismissReason(reason, () => latest.current.onDismiss(reason));
    if (returnFocus) restoreTooltipFocus(tooltipFocusOwner(anchor));
  }, [anchor]);
  const retire = useCallback(() => dismissWith("superseded"), [dismissWith]);
  // A pinned owner keeps the scope against transient previews. Claims are retried whenever the owner changes.
  useLayoutEffect(() => {
    if (!nested) store.claim(token, pinned, retire);
  }, [store, token, nested, pinned, owner, retire]);
  useLayoutEffect(() => {
    if (nested) return;
    return () => store.release(token);
  }, [store, token, nested]);
  // A nested panel is recorded under its parent, so working in it is working in the parent.
  useLayoutEffect(() => {
    const element = ref.current;
    if (nestedUnder === null || !ownsPanel || !element) return;
    return registerNestedPanel(nestedUnder, token, element);
  }, [nestedUnder, ownsPanel, token]);
  useEffect(() => {
    // A stationary pointer can acquire a new hover target after scrolling
    // while another chart still has focus. Keep transient previews singular;
    // explicitly pinned observations remain under the user's control. Nested
    // inspectors belong to their panel, so they never announce themselves.
    if (nested || !ownsPanel) return;
    const opened = (event: Event) => {
      const panel = dismissal.current;
      if ((event as CustomEvent<string>).detail !== id && panel && !panel.pinned) panel.dismiss("superseded");
    };
    document.addEventListener(openedEvent, opened);
    document.dispatchEvent(new CustomEvent(openedEvent, { detail: id }));
    return () => document.removeEventListener(openedEvent, opened);
  }, [id, nested, ownsPanel]);
  const assignRef = useCallback((element: HTMLDivElement | null) => { ref.current = element; panelRef?.(element); }, [panelRef]);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !position) return;
    // React does not rewrite an unchanged coordinate after our previous
    // imperative correction. Measure from the requested coordinates on both
    // axes, not from a mix of requested and already-corrected local positions.
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
    const actual = element.getBoundingClientRect();
    const corrected = correctPortalPosition(position, actual, { width: element.offsetWidth, height: element.offsetHeight });
    element.style.left = `${corrected.left}px`;
    element.style.top = `${corrected.top}px`;
    // A panel that regains ownership is a new element, so its correction runs again.
  }, [position, ownsPanel]);
  useLayoutEffect(() => {
    if (!ownsPanel) return;
    let frame = 0;
    const stopPointer = installTooltipPointerTracking();
    const stopTheme = ref.current ? inheritGammaTheme(anchor, ref.current) : undefined;
    const update = () => {
      const element = ref.current;
      if (!element || !anchor.isConnected) return;
      const viewport = window.visualViewport;
      const visibleViewport: TooltipViewport = {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        left: viewport?.offsetLeft,
        top: viewport?.offsetTop,
      };
      setNarrow(visibleViewport.width < 600);
      const anchorBounds = anchorRect?.() ?? anchor.getBoundingClientRect();
      const pointer = !pinned ? pointerOverAnchor(anchor) : undefined;
      if (pointer) {
        const target: TooltipTarget = { kind: "pointer", point: pointer };
        const limit = tooltipLimit(target, visibleViewport, settings);
        element.style.maxWidth = `${limit.width}px`;
        element.style.maxHeight = `${limit.height}px`;
        const next = placeTooltip(target, element.getBoundingClientRect(), visibleViewport, settings);
        element.style.maxHeight = `${next.maxHeight ?? limit.height}px`;
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
        const obstacles: TooltipObstacle[] = [...document.querySelectorAll("[data-widget-id], [data-tooltip-obstacle]")].flatMap(other => {
          if (other === widget || other.contains(widget) || widget.contains(other)) return [];
          const bounds = other.getBoundingClientRect();
          const viewportLeft = tooltipViewport.left ?? 0, viewportTop = tooltipViewport.top ?? 0;
          return bounds.width > 0 && bounds.height > 0 && bounds.right > viewportLeft && bounds.left < viewportLeft + tooltipViewport.width && bounds.bottom > viewportTop && bounds.top < viewportTop + tooltipViewport.height
            ? [{ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, weight: other.hasAttribute("data-tooltip-obstacle") ? 8 : 1 }]
            : [];
        });
        const target: TooltipTarget = { kind: "outside", anchor: anchorBounds, widget: widgetBounds, obstacles };
        // Clear a previous placement's height restriction before measuring.
        // Otherwise an expanding tooltip is scored as if its clipped height
        // were its full height, and the second placement can choose a smaller
        // space without applying that new space's height limit.
        const limit = tooltipLimit(target, tooltipViewport, settings);
        element.style.maxWidth = `${limit.width}px`;
        element.style.maxHeight = `${limit.height}px`;
        const next = placeTooltip(target, element.getBoundingClientRect(), tooltipViewport, settings);
        element.style.maxHeight = `${next.maxHeight ?? limit.height}px`;
        const size = element.getBoundingClientRect();
        const overlapsOtherWidget = tooltipOverlapsOtherWidget({ left: next.left, right: next.left + size.width, top: next.top, bottom: next.top + size.height }, widget);
        const overlapsControls = obstacles.some(rect => rect.weight === 8 && next.left < rect.right && next.left + size.width > rect.left && next.top < rect.bottom && next.top + size.height > rect.top);
        setPosition(previous => !previous?.pointer && previous?.left === next.left && previous?.top === next.top && previous?.placement === next.placement && previous?.overlapsWidget === next.overlapsWidget && previous?.overlapsOtherWidget === overlapsOtherWidget && previous?.overlapsControls === overlapsControls ? previous : { ...next, overlapsOtherWidget, overlapsControls });
        return;
      }
      const target: TooltipTarget = { kind: "anchor", anchor: anchorBounds, preferSide };
      const limit = tooltipLimit(target, visibleViewport, settings);
      element.style.maxWidth = `${limit.width}px`;
      element.style.maxHeight = `${limit.height}px`;
      // The side depends only on the width, so one probe names the side, and that side sets the height limit.
      const probe = placeTooltip(target, element.getBoundingClientRect(), visibleViewport, settings);
      element.style.maxHeight = `${tooltipLimit(target, visibleViewport, settings, probe.placement).height}px`;
      const next = placeTooltip(target, element.getBoundingClientRect(), visibleViewport, settings);
      setPosition(previous => !previous?.pointer && previous?.left === next.left && previous?.top === next.top && previous?.placement === next.placement ? previous : next);
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
  }, [anchor, anchorRect, preferSide, avoidWidget, minimized, pinned, ownsPanel, settings]);
  // Outside-pointer, blur and Escape dismissal share one path. It reads the latest state, so it attaches once per ownership.
  useLayoutEffect(() => {
    dismissal.current = ownsPanel ? { anchor, panel: () => ref.current, pinned, dismiss: dismissWith } : null;
  });
  useLayoutEffect(() => {
    if (!ownsPanel) return;
    return attachTooltipDismissal(token, () => dismissal.current);
  }, [ownsPanel, token]);
  useEffect(() => {
    if (!ownsPanel) return;
    const keyboard = (event: KeyboardEvent) => {
      const element = ref.current;
      if (
        element &&
        !(anchorOwnsHistoryKeys && anchor.contains(event.target as Node) && ["Home", "End"].includes(event.key)) &&
        (event.target === anchor || (pinned && event.target === element) || (role !== "region" && element.contains(event.target as Node))) &&
        ["PageDown", "PageUp", "Home", "End"].includes(event.key)
      ) {
        // A tooltip does not take focus away from its trigger. Let keyboard
        // users inspect every label while keeping the chart's tab order intact.
        // A pinned region also owns its focused scroll surface: touch-browser
        // keyboard defaults need not scroll it. Descendant controls keep keys.
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
    document.addEventListener("keydown", keyboard, true);
    return () => document.removeEventListener("keydown", keyboard, true);
  }, [anchor, anchorOwnsHistoryKeys, ownsPanel, pinned, role]);
  if (!ownsPanel || typeof document === "undefined") return null;
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
          onLeave?.();
      }}
    >
      {pinned && avoidWidget && narrow && (minimized || position?.overlapsWidget || position?.overlapsOtherWidget || position?.overlapsControls) && (
        <div className={configStyles.tooltipCompactControls}>
          <GammaButton variant="ghost" size="sm" aria-label={minimized ? "Show inspector details" : "Minimize inspector"} aria-expanded={!minimized} aria-controls={`${id}-details`} onClick={() => setCompactState({ anchor, pinned, minimized: !minimized })}>
            {minimized ? "Show details" : "Minimize"}
          </GammaButton>
          {minimized && <GammaButton variant="ghost" size="sm" aria-label="Close inspector" onClick={() => dismissWith("close")}>Close</GammaButton>}
        </div>
      )}
      <TooltipOwnerContext.Provider value={token}>
        <div id={`${id}-details`} hidden={minimized}>{children}</div>
      </TooltipOwnerContext.Provider>
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
  options,
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
  /** Placement, gap and size limits for the panel. */
  options?: TooltipPlacementOptions;
}) {
  const id = useId();
  const [active, setActive] = useState<{
    anchor: Element;
    pinned: boolean;
    revision: unknown;
  } | null>(null);
  const interaction = useRef({ focused: false, hovered: false, panel: false });
  const hide = useTooltipDismiss({
    // A pinned observation is only ever closed by its owner.
    onDismiss: () => setActive(current => current && !current.pinned ? null : current),
    pinned: !!active?.pinned,
    revision,
    enabled,
    engaged: () => interaction.current.focused || interaction.current.hovered || interaction.current.panel,
  });
  const dismiss = () => {
    hide.cancel();
    interaction.current.panel = false;
    setActive(null);
  };
  useEffect(() => enabled ? installTooltipPointerTracking() : undefined, [enabled]);
  useEffect(() => {
    if (!externalAnchor || !enabled) return;
    let disposed = false;
    const interactionState = interaction.current;
    interactionState.hovered = true;
    hide.cancel();
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
      hide.schedule();
    };
  }, [externalAnchor, enabled, revision, hide]);
  if (active && (active.revision !== revision || !enabled)) {
    setActive(null);
  }
  const show = (anchor: HTMLButtonElement, pinned = false) => {
    hide.cancel();
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
          hide.schedule();
        }}
        onFocus={(event) => {
          interaction.current.focused = true;
          // Returning focus to the trigger after a dismissal must not reopen or reselect.
          if (isRestoringTooltipFocus()) return;
          if (selectOnFocus) onSelect?.();
          if (!active?.pinned) show(event.currentTarget);
        }}
        onBlur={() => {
          interaction.current.focused = false;
          // Focus can move into the portaled content. Pinned observations
          // remain open until explicitly dismissed.
          hide.schedule();
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
          options={options}
          onDismiss={dismiss}
          onEnter={() => {
            interaction.current.panel = true;
            hide.cancel();
          }}
          onLeave={() => {
            interaction.current.panel = false;
            hide.schedule();
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

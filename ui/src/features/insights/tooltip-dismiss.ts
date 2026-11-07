"use client";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { isInNestedPanel, raiseTooltipEscape, registerTooltipEscape } from "./tooltip-interaction";
import type { TooltipDismissReason } from "./tooltip-focus";

type DismissState = { pinned: boolean; enabled: boolean; engaged: boolean };

/** The grace period between leaving an observation and dismissing its preview. */
const graceMilliseconds = 180;

/**
 * Bounded grace between an observation and its panel. A scheduled hide fires
 * once, after the grace period, and only while the pointer or focus is still
 * away. Repeated schedules do not postpone it. Pins are never hidden.
 */
export function createTooltipDismissController(getState: () => DismissState, onDismiss: () => void, onHoldChange: (held: boolean) => void = () => undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, disposed = false, engaged = getState().engaged, ignoreDisengagement = false;
  const stopTimer = () => { clearTimeout(timer); timer = undefined; };
  const cancel = () => { pending = false; stopTimer(); engaged = getState().engaged; ignoreDisengagement = false; onHoldChange(false); };
  const reset = () => { cancel(); engaged = getState().engaged; ignoreDisengagement = engaged; };
  const arm = () => {
    stopTimer();
    const state = getState();
    if (disposed || !state.enabled || state.pinned) { pending = false; onHoldChange(false); return; }
    if (state.engaged) return;
    timer = setTimeout(() => {
      timer = undefined;
      const current = getState();
      if (!pending || disposed || !current.enabled || current.pinned) { pending = false; onHoldChange(false); return; }
      if (current.engaged) return;
      pending = false;
      try { onDismiss(); } finally { onHoldChange(false); }
    }, graceMilliseconds);
  };
  return {
    schedule: () => { if (!disposed) { pending = true; onHoldChange(true); if (timer === undefined) arm(); } },
    cancel,
    reset,
    engagementChanged: () => {
      const next = getState().engaged;
      if (engaged === next) return;
      engaged = next;
      if (next) { ignoreDisengagement = false; stopTimer(); }
      else if (ignoreDisengagement) { ignoreDisengagement = false; if (pending) arm(); }
      else { pending = true; onHoldChange(true); arm(); }
    },
    dispose: () => { disposed = true; cancel(); },
  };
}

/**
 * The hover and focus grace for an owner. `schedule` runs when the pointer or
 * focus leaves; `cancel` runs when it returns. A revision change resets it.
 */
export function useTooltipDismiss({ onDismiss, pinned, revision, enabled = true, engaged }: {
  onDismiss: () => void;
  pinned: boolean;
  revision: unknown;
  enabled?: boolean;
  /** True while the pointer or focus is on the trigger or its panel. */
  engaged: () => boolean;
}): { schedule: () => void; cancel: () => void } {
  const latest = useRef({ onDismiss, pinned, enabled, engaged });
  useLayoutEffect(() => { latest.current = { onDismiss, pinned, enabled, engaged }; });
  // The controller is built in an effect, so no render passes these reads into it. Strict Mode builds it again after its cleanup.
  const controller = useRef<ReturnType<typeof createTooltipDismissController> | null>(null);
  useLayoutEffect(() => {
    const created = createTooltipDismissController(
      () => ({ pinned: latest.current.pinned, enabled: latest.current.enabled, engaged: latest.current.engaged() }),
      () => latest.current.onDismiss(),
    );
    controller.current = created;
    // Cancel rather than dispose on unmount: Strict Mode runs cleanup before it remounts.
    return () => created.cancel();
  }, []);
  useLayoutEffect(() => { controller.current?.reset(); }, [revision, enabled]);
  useLayoutEffect(() => { controller.current?.cancel(); }, [pinned]);
  const schedule = useCallback(() => controller.current?.schedule(), []);
  const cancel = useCallback(() => controller.current?.cancel(), []);
  return useMemo(() => ({ schedule, cancel }), [schedule, cancel]);
}

/** What an open panel exposes to the dismissal bindings. */
export interface TooltipDismissalTarget {
  anchor: Element;
  panel: () => Element | null;
  pinned: boolean;
  dismiss: (reason: TooltipDismissReason) => void;
}

// A listbox, menu or combobox that is open owns its first Escape.
const ownedControls = '[role="listbox"],[role="menu"],[role="combobox"][aria-expanded="true"],[aria-haspopup][aria-expanded="true"]';

/**
 * The one dismissal path for an open panel: pointer outside it, focus moving
 * outside it (unless pinned), and Escape, which goes to the topmost panel of
 * the Escape stack. `current` returns the panel's target while it owns the
 * panel. Returns the detach function.
 */
export function attachTooltipDismissal(token: symbol, current: () => TooltipDismissalTarget | null): () => void {
  // Its own anchor or panel: the owner is the one the user is working in.
  const direct = (owner: TooltipDismissalTarget, target: EventTarget | null) =>
    target instanceof Node && (owner.anchor.contains(target) || !!owner.panel()?.contains(target));
  // A panel nested under this owner is part of it: working in it neither dismisses nor raises the owner.
  const nested = (target: EventTarget | null) => target instanceof Node && isInNestedPanel(token, target);
  const pointerDown = (event: PointerEvent) => {
    const owner = current();
    if (!owner) return;
    if (direct(owner, event.target)) raiseTooltipEscape(token);
    else if (!nested(event.target)) owner.dismiss("outside");
  };
  const focusIn = (event: FocusEvent) => {
    const owner = current();
    if (!owner) return;
    if (direct(owner, event.target)) raiseTooltipEscape(token);
    else if (!nested(event.target) && !owner.pinned) owner.dismiss("blur");
  };
  const escape = (event: KeyboardEvent) => {
    const owner = current();
    if (!owner) return;
    const target = event.target instanceof Element ? event.target : null;
    // A Gamma menu or an open listbox owns its own Escape, even though it is portaled away.
    if (target?.closest("[data-gamma-portal]") || target?.closest(ownedControls)) return;
    // A dialog that is neither this panel nor around it owns its own Escape.
    const dialog = target?.closest('dialog[open],[role="dialog"]');
    const panel = owner.panel();
    if (dialog && dialog !== panel && !dialog.contains(owner.anchor) && !(panel && dialog.contains(panel))) return;
    if (direct(owner, event.target) || nested(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
    owner.dismiss("escape");
  };
  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("focusin", focusIn, true);
  const unregister = registerTooltipEscape(token, escape);
  return () => {
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("focusin", focusIn, true);
    unregister();
  };
}

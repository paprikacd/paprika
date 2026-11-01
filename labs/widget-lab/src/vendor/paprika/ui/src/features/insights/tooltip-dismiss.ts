"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTooltipHandoff, useWidgetTooltip } from './tooltip-interaction';

type DismissState = { pinned: boolean; enabled: boolean; engaged: boolean };

/** Bounded handoff across the gap between an observation and its portalled inspector. */
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
    }, 180);
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

/** Ordinary pointer/blur dismissal never restores focus; explicit Close/Escape stays with the owner. */
export function useTooltipDismiss({ onDismiss, pinned, revision, enabled = true }: {
  onDismiss: () => void;
  pinned: boolean;
  revision: unknown;
  enabled?: boolean;
}) {
  const scope = useWidgetTooltip(), store = scope?.store;
  const handoff = useTooltipHandoff();
  const observedOwner = useRef<Element | null>(null);
  const focusOwner = (anchor: Element | null) => anchor?.closest('[tabindex],button,a[href],input,select,textarea') ?? anchor;
  const latest = useRef({ onDismiss, pinned, enabled });
  useLayoutEffect(() => { latest.current = { onDismiss, pinned, enabled }; });
  const controller = useMemo(() => createTooltipDismissController(
    () => {
      const sourceFocus = store?.getSourceFocus();
      return { pinned: latest.current.pinned, enabled: latest.current.enabled,
        engaged: !!store && (store.isPanelEngaged() || !!sourceFocus?.keyboard && observedOwner.current !== null && observedOwner.current === focusOwner(sourceFocus.anchor)) };
    },
    () => { observedOwner.current = null; latest.current.onDismiss(); },
    held => { if (held) handoff.hold(observedOwner.current); else handoff.release(); },
  ), [store, handoff]);
  useLayoutEffect(() => { observedOwner.current = null; controller.reset(); return controller.reset; }, [controller, revision, enabled]);
  useLayoutEffect(() => { controller.cancel(); }, [controller, pinned]);
  useEffect(() => {
    const stop = store?.subscribe(change => { if (change === 'owner') controller.reset(); else controller.engagementChanged(); });
    return () => { stop?.(); controller.cancel(); };
  }, [store, controller]);
  const cancel = useCallback(() => { observedOwner.current = focusOwner(store?.getSnapshot().anchor ?? null); controller.cancel(); }, [store, controller]);
  return useMemo(() => ({ schedule: controller.schedule, cancel }), [controller, cancel]);
}

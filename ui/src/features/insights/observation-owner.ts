"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createTooltipDismissController } from "./tooltip-dismiss";

/**
 * The one owner of an observation panel's hover, focus, pin and grace state. A host supplies stable keys (or a
 * revision), binds its triggers, and renders <ObservationTooltip> with the active observation. The grace period and
 * dismissal rules are those of tooltip-dismiss.ts; this hook decides which observation is open and when it closes.
 *
 * Rules, stated once for every host:
 * - A hide fires one grace period (tooltip-dismiss.ts) after the last engagement ends. Repeated leaves do not extend it.
 * - Engagement belongs to an element: a panel stays open while the pointer or focus is on its own anchor, or on the panel.
 *   A late leave from a previous anchor never closes the current one.
 * - A hover never replaces a pin. Selecting the pinned observation again releases the pin; selecting another moves it.
 * - Retention: with `keys`, an open panel survives a refresh while its key is still in the data and re-anchors through
 *   `locate`; it closes, and releases its pin, when the key leaves. Without keys, any revision change closes it.
 * - Disabling the owner closes any panel.
 */
export type ObservationRetention =
  | { revision: unknown }
  | {
      keys: readonly string[];
      /**
       * Maps an open key that left `keys` to the key its observation has now, when a refresh moved it (a sample whose
       * timestamp shifted). Returns undefined when the observation is gone. The panel then follows the new key.
       */
      resolve?: (key: string) => string | undefined;
    };

export interface ObservationOwnerOptions {
  /** Whether observations may open. Turning it off closes any open panel. */
  enabled?: boolean;
  retention: ObservationRetention;
  /** Finds a key's current element after a refresh, so the panel follows its mark. Used with `keys` retention. */
  locate?: (key: string) => Element | null;
}

export interface ActiveObservation {
  key: string;
  anchor: Element;
  pinned: boolean;
}

/** The part of a DOM event the owner reads. The anchor is the element the handler is bound to. */
export interface TriggerEvent {
  currentTarget: Element;
  pointerType?: string;
}

export interface TriggerHandlers {
  onPointerEnter: (event: TriggerEvent) => void;
  onPointerLeave: (event: TriggerEvent) => void;
  onFocus: (event: TriggerEvent) => void;
  onBlur: (event: TriggerEvent) => void;
  onClick: (event: TriggerEvent) => void;
}

/** Which engagement ended: the pointer or the keyboard focus. Each is held separately. */
export type EngagementSource = "pointer" | "focus";

export interface ObservationOwner {
  /** The observation whose panel is open, if any. */
  active: ActiveObservation | undefined;
  /** Handlers for a DOM trigger that owns observation `key`. The anchor is the handler's currentTarget. */
  trigger: (key: string) => TriggerHandlers;
  /** Opens an unpinned preview for a scene-driven host, such as a chart's nearest point. A pin is never replaced. */
  preview: (key: string, anchor: Element) => void;
  /** Engages `anchor` with the pointer or the focus, and previews `key` there. A pin is never replaced. */
  engage: (key: string, anchor: Element, source: EngagementSource) => void;
  /** Records focus on `anchor` without previewing anything, for focus returned to a trigger after a dismissal. */
  holdFocus: (anchor: Element) => void;
  /** Moves or sets the pin to `key` at `anchor`, for keyboard inspection of a pinned observation. */
  pin: (key: string, anchor: Element) => void;
  /** Ends one engagement with `anchor`: the pointer, or the focus. The other still holds; the grace then applies. */
  leave: (anchor: Element, source: EngagementSource) => void;
  /** Selecting a pinned observation again releases it; selecting another observation pins it. */
  toggle: (key: string, anchor: Element) => void;
  /** Releases the pin and keeps the panel open as an unpinned preview. Nothing happens without a pin. */
  unpin: () => void;
  /** Closes the panel and releases any pin. */
  dismiss: () => void;
  /** Panel engagement, for ObservationTooltip's onEnter and onLeave. */
  panelEnter: () => void;
  panelLeave: () => void;
}

type Engagement = { hovered: Element | null; focused: Element | null; panel: boolean };

export function useObservationOwner({ enabled = true, retention, locate }: ObservationOwnerOptions): ObservationOwner {
  const [active, setActive] = useState<ActiveObservation | undefined>(undefined);
  const latest = useRef({ active, enabled, locate, resolve: undefined as ((key: string) => string | undefined) | undefined });
  const emptyEngagement = (): Engagement => ({ hovered: null, focused: null, panel: false });
  const engagement = useRef<Engagement>({ hovered: null, focused: null, panel: false });
  const controller = useRef<ReturnType<typeof createTooltipDismissController> | null>(null);
  useLayoutEffect(() => {
    latest.current = { active, enabled, locate, resolve: "keys" in retention ? retention.resolve : undefined };
  });
  // Built in an effect, so no render reads the refs; Strict Mode builds it again after its cleanup.
  useLayoutEffect(() => {
    const created = createTooltipDismissController(
      () => {
        const current = latest.current.active;
        const held = engagement.current;
        return {
          pinned: !!current?.pinned,
          enabled: latest.current.enabled,
          engaged: !!current && (held.panel || held.hovered === current.anchor || held.focused === current.anchor),
        };
      },
      () => setActive(current => (current && !current.pinned ? undefined : current)),
    );
    controller.current = created;
    // Cancel rather than dispose: Strict Mode runs cleanup before it remounts.
    return () => created.cancel();
  }, []);

  const revisionKey = "revision" in retention ? retention.revision : undefined;
  const keys = "keys" in retention ? retention.keys : undefined;
  const keySignature = keys ? keys.join("\u0000") : undefined;
  const lastRevision = useRef(revisionKey);
  // A new revision closes the panel, even a pinned one, unless the owner keeps observations by key.
  useLayoutEffect(() => {
    if (keys || Object.is(lastRevision.current, revisionKey)) return;
    lastRevision.current = revisionKey;
    controller.current?.reset();
    engagement.current = { hovered: null, focused: null, panel: false };
    setActive(undefined);
  }, [keys, revisionKey]);
  // Keyed retention: close when the key leaves the data, otherwise follow the key's current element.
  useLayoutEffect(() => {
    if (!keys) return;
    const current = latest.current.active;
    if (!current) return;
    if (!keys.includes(current.key)) {
      const moved = latest.current.resolve?.(current.key);
      if (moved !== undefined && keys.includes(moved)) {
        const anchor = latest.current.locate?.(moved) ?? current.anchor;
        if (engagement.current.hovered === current.anchor) engagement.current.hovered = anchor;
        if (engagement.current.focused === current.anchor) engagement.current.focused = anchor;
        setActive({ key: moved, anchor, pinned: current.pinned });
        return;
      }
      controller.current?.cancel();
      engagement.current = { hovered: null, focused: null, panel: false };
      setActive(undefined);
      return;
    }
    const next = latest.current.locate?.(current.key);
    if (next && next !== current.anchor) {
      setActive({ ...current, anchor: next });
      if (engagement.current.hovered === current.anchor) engagement.current.hovered = next;
      if (engagement.current.focused === current.anchor) engagement.current.focused = next;
    }
    // A refresh that keeps every key still re-anchors the open panel.
  }, [keySignature, keys, active]);
  // Disabling closes the panel during render, as a revision change does. The grace timer reads `enabled` too.
  if (!enabled && active) setActive(undefined);
  useLayoutEffect(() => {
    if (enabled) return;
    controller.current?.cancel();
    engagement.current = emptyEngagement();
  }, [enabled]);

  const show = useCallback((key: string, anchor: Element, pinned: boolean) => {
    controller.current?.cancel();
    if (!latest.current.enabled) return;
    setActive(previous => previous && previous.key === key && previous.anchor === anchor && previous.pinned === pinned ? previous : { key, anchor, pinned });
  }, []);
  const dismiss = useCallback(() => {
    controller.current?.cancel();
    engagement.current.panel = false;
    setActive(undefined);
  }, []);
  const toggle = useCallback((key: string, anchor: Element) => {
    const current = latest.current.active;
    if (current?.pinned && current.key === key) dismiss();
    else show(key, anchor, true);
  }, [dismiss, show]);
  const preview = useCallback((key: string, anchor: Element) => {
    if (latest.current.active?.pinned) return;
    show(key, anchor, false);
  }, [show]);
  // A pointer leave ends only the hover, and a blur ends only the focus, so a focused trigger keeps its panel
  // open when the pointer leaves, and a blur never closes a panel the pointer is still over.
  const leave = useCallback((anchor: Element, source: EngagementSource) => {
    const held = engagement.current;
    if (source === "pointer" && held.hovered === anchor) held.hovered = null;
    if (source === "focus" && held.focused === anchor) held.focused = null;
    controller.current?.schedule();
  }, []);
  const engage = useCallback((key: string, anchor: Element, source: EngagementSource) => {
    if (source === "pointer") engagement.current.hovered = anchor;
    else engagement.current.focused = anchor;
    controller.current?.cancel();
    if (!latest.current.active?.pinned) show(key, anchor, false);
  }, [show]);
  const unpin = useCallback(() => {
    const current = latest.current.active;
    if (!current?.pinned) return;
    controller.current?.cancel();
    setActive({ ...current, pinned: false });
  }, []);
  const holdFocus = useCallback((anchor: Element) => {
    engagement.current.focused = anchor;
    controller.current?.cancel();
  }, []);
  const pin = useCallback((key: string, anchor: Element) => {
    if (!latest.current.enabled) return;
    controller.current?.cancel();
    setActive({ key, anchor, pinned: true });
  }, []);
  const trigger = useCallback((key: string): TriggerHandlers => ({
    onPointerEnter: ({ pointerType, currentTarget }) => {
      if (pointerType === "touch") return;
      engage(key, currentTarget, "pointer");
    },
    onPointerLeave: ({ currentTarget }) => leave(currentTarget, "pointer"),
    onFocus: ({ currentTarget }) => engage(key, currentTarget, "focus"),
    onBlur: ({ currentTarget }) => leave(currentTarget, "focus"),
    onClick: ({ currentTarget }) => toggle(key, currentTarget),
  }), [engage, leave, toggle]);
  const panelEnter = useCallback(() => {
    engagement.current.panel = true;
    controller.current?.cancel();
  }, []);
  const panelLeave = useCallback(() => {
    engagement.current.panel = false;
    controller.current?.schedule();
  }, []);

  return useMemo(() => ({ active, trigger, preview, engage, holdFocus, pin, leave, toggle, unpin, dismiss, panelEnter, panelLeave }), [active, trigger, preview, engage, holdFocus, pin, leave, toggle, unpin, dismiss, panelEnter, panelLeave]);
}

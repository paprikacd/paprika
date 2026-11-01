"use client";

import { createContext, useContext, useEffect, useMemo, useRef, type HTMLAttributes, type RefObject } from 'react';
import type { WidgetOptions } from './schema';
import { isRestoringTooltipFocus } from './tooltip-focus';

export interface TooltipInteraction {
  kind: 'pointer' | 'keyboard';
  x: number;
  y: number;
  anchor: Element | null;
}
export type TooltipEscapeEvent = Pick<KeyboardEvent, 'key' | 'target' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>;
export type TooltipStoreChange = 'pointer' | 'keyboard' | 'boundary' | 'handoff' | 'owner';

/** The store updates the open portal only; moving a pointer never rerenders a chart. */
export function createTooltipInteractionStore() {
  let snapshot: TooltipInteraction = { kind: 'keyboard', x: 0, y: 0, anchor: null };
  let hovered = false, focused = false, sourceFocused = false;
  let sourceFocusAnchor: Element | null = null, sourceFocusKeyboard = false;
  let panelOwner: { token: symbol; pinned: boolean; onReplaced: () => void } | null = null;
  const listeners = new Set<(change: TooltipStoreChange) => void>();
  const ownerListeners = new Set<() => void>();
  const escapeHandlers: ((event: TooltipEscapeEvent) => boolean)[] = [];
  const handoffs = new Map<symbol, Element | null>();
  const publish = (change: TooltipStoreChange = 'boundary') => { for (const listener of listeners) listener(change); };
  const publishOwner = () => { publish('owner'); for (const listener of ownerListeners) listener(); };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: (change: TooltipStoreChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pointer: (x: number, y: number, anchor: Element | null) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      snapshot = { kind: 'pointer', x, y, anchor }; publish('pointer');
    },
    keyboard: (anchor: Element | null) => { snapshot = { ...snapshot, kind: 'keyboard', anchor }; publish('keyboard'); },
    getPanelOwner: () => panelOwner?.token ?? null,
    subscribePanelOwner: (listener: () => void) => { ownerListeners.add(listener); return () => { ownerListeners.delete(listener); }; },
    claimPanel: (token: symbol, pinned: boolean, onReplaced: () => void) => {
      if (panelOwner?.token === token) { panelOwner.pinned = pinned; panelOwner.onReplaced = onReplaced; return true; }
      if (panelOwner?.pinned && !pinned) return false;
      const previous = panelOwner;
      panelOwner = { token, pinned, onReplaced };
      hovered = false; focused = false; handoffs.clear();
      publishOwner(); previous?.onReplaced();
      return true;
    },
    releasePanel: (token: symbol) => {
      if (panelOwner?.token !== token) return;
      panelOwner = null; hovered = false; focused = false; handoffs.clear(); publishOwner();
    },
    setPanelHovered: (token: symbol, value: boolean) => { if (panelOwner?.token === token && hovered !== value) { hovered = value; publish(); } },
    setPanelFocused: (token: symbol, value: boolean) => { if (panelOwner?.token === token && focused !== value) { focused = value; publish(); } },
    isPanelEngaged: () => hovered || focused,
    setSourceFocused: (value: boolean, anchor: Element | null = snapshot.anchor, keyboard = snapshot.kind === 'keyboard') => {
      if (sourceFocused === value && (!value || sourceFocusAnchor === anchor && sourceFocusKeyboard === keyboard)) return;
      sourceFocused = value; sourceFocusAnchor = value ? anchor : null; sourceFocusKeyboard = value && keyboard; publish();
    },
    isSourceFocused: () => sourceFocused,
    getSourceFocus: () => sourceFocused ? { anchor: sourceFocusAnchor, keyboard: sourceFocusKeyboard } : null,
    setHandoff: (token: symbol, active: boolean, anchor: Element | null = snapshot.anchor) => {
      if (active) { if (handoffs.has(token)) return; handoffs.set(token, anchor); }
      else if (!handoffs.delete(token)) return;
      publish('handoff');
    },
    isHandoffActive: (origin?: Element | null) => [...handoffs.values()].some(anchor => !origin || !anchor || origin === anchor || origin.contains(anchor)),
    registerEscape: (handler: (event: TooltipEscapeEvent) => boolean) => {
      escapeHandlers.push(handler);
      return () => { const index = escapeHandlers.indexOf(handler); if (index >= 0) escapeHandlers.splice(index, 1); };
    },
    handleEscape: (event: TooltipEscapeEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return false;
      for (const handler of [...escapeHandlers].reverse()) if (handler(event)) return true;
      return false;
    },
  };
}

export type TooltipInteractionStore = ReturnType<typeof createTooltipInteractionStore>;
export interface WidgetTooltipScope { store: TooltipInteractionStore; hostRef: RefObject<HTMLDivElement | null>; options?: WidgetOptions }
const TooltipContext = createContext<WidgetTooltipScope | null>(null);
export const useWidgetTooltip = () => useContext(TooltipContext);

/** A dismissal owner holds only its own source while the pointer crosses to the popup. */
export function useTooltipHandoff() {
  const store = useWidgetTooltip()?.store;
  const token = useRef(Symbol('tooltip-handoff'));
  const controls = useMemo(() => ({
    hold: (anchor?: Element | null) => store?.setHandoff(token.current, true, anchor),
    release: () => store?.setHandoff(token.current, false),
  }), [store]);
  useEffect(() => controls.release, [controls]);
  return controls;
}

export function isObservationTooltipTarget(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && !!target.closest('[data-observation-tooltip]');
}

/** Replace the existing widget host div so layout and containment stay unchanged. */
export function WidgetTooltipProvider({ options, children, ...props }: HTMLAttributes<HTMLDivElement> & { options?: WidgetOptions }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const store = useMemo(createTooltipInteractionStore, []);
  const scope = useMemo(() => ({ store, hostRef, options }), [store, options]);
  const pointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isObservationTooltipTarget(event.target)) return;
    store.pointer(event.clientX, event.clientY, event.target instanceof Element ? event.target : hostRef.current);
  };
  return <TooltipContext.Provider value={scope}><div {...props} ref={hostRef} data-widget-tooltip-scope=""
    onPointerOverCapture={event => { pointer(event); props.onPointerOverCapture?.(event); }}
    onPointerMoveCapture={event => { pointer(event); props.onPointerMoveCapture?.(event); }}
    onPointerDownCapture={event => { pointer(event); props.onPointerDownCapture?.(event); }}
    onKeyDownCapture={event => {
      if (!isObservationTooltipTarget(event.target)) store.keyboard(event.target instanceof Element ? event.target : hostRef.current);
      props.onKeyDownCapture?.(event);
    }}
    onKeyDown={event => {
      props.onKeyDown?.(event);
      if (!event.defaultPrevented && !event.isPropagationStopped()) store.handleEscape(event);
    }}
    onFocusCapture={event => {
      if (isRestoringTooltipFocus()) {
        store.setSourceFocused(true);
        event.stopPropagation();
        return;
      }
      if (!isObservationTooltipTarget(event.target)) {
        const keyboard = store.getSnapshot().kind === 'keyboard' || event.target.matches(':focus-visible');
        if (keyboard) store.keyboard(event.target);
        store.setSourceFocused(true, event.target, keyboard);
      }
      props.onFocusCapture?.(event);
    }}
    onBlurCapture={event => {
      if (!isObservationTooltipTarget(event.target) && !event.currentTarget.contains(event.relatedTarget as Node | null)) store.setSourceFocused(false);
      props.onBlurCapture?.(event);
    }}
  >{children}</div></TooltipContext.Provider>;
}

"use client";

import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WidgetOptions } from './schema';
import { inheritGammaTheme } from '@insights/gamma/inherit-theme';
import { createTooltipInteractionStore, isObservationTooltipTarget, useWidgetTooltip, type TooltipEscapeEvent } from './tooltip-interaction';
import { limitTooltipSize, positionObservationTooltip, type TooltipAnchor, type TooltipViewport } from './tooltip-position';
import { withTooltipDismissReason, type TooltipDismissReason } from './tooltip-focus';
import styles from './chart-styles.module.css';

export { isObservationTooltipTarget, useWidgetTooltip, WidgetTooltipProvider } from './tooltip-interaction';

export interface ObservationTooltipProps {
  id?: string;
  anchor?: Element | null;
  anchorRect?: () => TooltipAnchor;
  pinned?: boolean;
  options?: WidgetOptions;
  compact?: boolean;
  /** Kept for callers of the previous owner; automatic placement now tries both sides. */
  preferSide?: boolean;
  className?: string;
  label?: string;
  onDismiss: (reason?: TooltipDismissReason) => void;
  onEnter?: () => void;
  onLeave?: () => void;
  children: ReactNode;
}

/** One portal, viewport/collision policy, and pointer owner for every observation inspector. */
export function ObservationTooltip({ id: suppliedId, anchor, anchorRect, pinned = false, options, compact,
  className = '', label, onDismiss, onEnter, onLeave, children }: ObservationTooltipProps) {
  const generatedId = useId(), id = suppliedId ?? generatedId;
  const scope = useWidgetTooltip();
  const scoped = scope !== null;
  const localStore = useRef<ReturnType<typeof createTooltipInteractionStore> | null>(null);
  if (!localStore.current) localStore.current = createTooltipInteractionStore();
  const store = scope?.store ?? localStore.current;
  const panelToken = useRef(Symbol('observation-tooltip')).current;
  const activeOwner = useSyncExternalStore(store.subscribePanelOwner, store.getPanelOwner, () => null);
  const ownsPanel = activeOwner === panelToken;
  const [mountedOrigin, setMountedOrigin] = useState<Element | null>(null);
  const origin = anchor ?? scope?.hostRef.current ?? mountedOrigin;
  const effective = options ?? scope?.options;
  const disabled = effective?.showTooltip === false;
  const dense = compact ?? effective?.inspectorDensity === 'compact';
  const panelRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null);
  const previousPin = useRef(false), frozenAnchor = useRef<TooltipAnchor | null>(null), lastAnchor = useRef<TooltipAnchor | null>(null);
  const callbacks = useRef({ onDismiss, onEnter, onLeave, anchorRect });
  useLayoutEffect(() => { callbacks.current = { onDismiss, onEnter, onLeave, anchorRect }; });
  useLayoutEffect(() => { setMountedOrigin(anchor ?? scope?.hostRef.current ?? null); }, [anchor, scope?.hostRef]);
  useLayoutEffect(() => {
    if (!origin || disabled) return;
    const retire = () => withTooltipDismissReason('superseded', () => callbacks.current.onDismiss('superseded'));
    // Per-cell renderers may request several panels. A pinned owner wins over
    // transient hover; explicit selection may replace it without moving focus.
    if (!store.claimPanel(panelToken, pinned, retire)) retire();
  }, [origin, disabled, store, panelToken, pinned]);
  useLayoutEffect(() => () => {
    previousPin.current = false; frozenAnchor.current = null; lastAnchor.current = null;
    store.releasePanel(panelToken);
  }, [origin, disabled, store, panelToken]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!origin || !panel || disabled || !ownsPanel) return;
    const ownerDocument = origin.ownerDocument, ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;
    const stopTheme = inheritGammaTheme(origin, panel);
    const computed = ownerWindow.getComputedStyle(origin);
    panel.style.fontFamily = computed.getPropertyValue('--font-sans').trim() || computed.fontFamily;
    const viewport = (): TooltipViewport => ({
      left: ownerWindow.visualViewport?.offsetLeft ?? 0,
      top: ownerWindow.visualViewport?.offsetTop ?? 0,
      width: ownerWindow.visualViewport?.width ?? (ownerDocument.documentElement.clientWidth || ownerWindow.innerWidth),
      height: ownerWindow.visualViewport?.height ?? ownerWindow.innerHeight,
    });
    const resolveAnchor = (): TooltipAnchor => {
      const interaction = store.getSnapshot();
      if (interaction.kind === 'pointer') return { left: interaction.x, right: interaction.x, top: interaction.y, bottom: interaction.y };
      if (callbacks.current.anchorRect) return callbacks.current.anchorRect();
      const focused = interaction.anchor;
      return focused?.isConnected && origin.contains(focused) ? focused.getBoundingClientRect() : origin.getBoundingClientRect();
    };
    if (pinned && (!previousPin.current || !frozenAnchor.current)) frozenAnchor.current = lastAnchor.current ?? resolveAnchor();
    if (!pinned) frozenAnchor.current = null;
    previousPin.current = pinned;
    let frame = 0, disposed = false;
    let measured = { width: 0, height: 0 };
    const update = (remeasure = false) => {
      if (disposed || !origin.isConnected || store.getPanelOwner() !== panelToken) return;
      const visibleViewport = viewport();
      const limits = limitTooltipSize({ width: effective?.tooltipMaxWidth ?? (dense ? 292 : 330), height: effective?.tooltipMaxHeight ?? 560 }, visibleViewport);
      const widthChanged = panel.style.width !== `${limits.width}px`;
      if (widthChanged) { panel.style.width = `${limits.width}px`; panel.style.maxWidth = `${limits.width}px`; }
      if (remeasure || widthChanged || measured.height === 0) {
        // Measure natural content, not the previous placement's shortened scroll box.
        measured = { width: limits.width, height: Math.min(limits.height, Math.max(contentRef.current?.getBoundingClientRect().height ?? 0, panel.scrollHeight) + 2) };
      }
      let reference = frozenAnchor.current ?? resolveAnchor();
      if (!pinned && (store.isPanelEngaged() || store.isHandoffActive(origin)) && lastAnchor.current) reference = lastAnchor.current;
      lastAnchor.current = reference;
      const next = positionObservationTooltip(reference, { width: limits.width, height: Math.min(measured.height, limits.height) }, visibleViewport,
        effective?.tooltipPlacement ?? 'auto', effective?.tooltipOffset ?? 12);
      panel.style.maxHeight = `${next.height}px`;
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.style.visibility = 'visible';
      panel.dataset.placement = next.placement;
      panel.dataset.anchorMode = pinned ? 'pinned' : store.getSnapshot().kind;
    };
    const schedule = () => { if (!frame) frame = ownerWindow.requestAnimationFrame(() => { frame = 0; update(true); }); };
    // Direct manipulation is immediate: no animation, debounce, or chart rerender.
    const stopPointer = store.subscribe(change => {
      if ((change === 'pointer' || change === 'keyboard' || change === 'handoff') && !pinned && !store.isPanelEngaged() && !store.isHandoffActive(origin)) update();
    });
    const localPointer = (event: Event) => {
      const pointer = event as PointerEvent;
      if (!isObservationTooltipTarget(pointer.target)) store.pointer(pointer.clientX, pointer.clientY, pointer.target instanceof Element ? pointer.target : origin);
    };
    const localKeyboard = (event: Event) => { if (!isObservationTooltipTarget(event.target)) store.keyboard(event.target instanceof Element ? event.target : origin); };
    if (!scoped) { origin.addEventListener('pointermove', localPointer); origin.addEventListener('keydown', localKeyboard, true); }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(origin); observer?.observe(panel);
    if (contentRef.current) observer?.observe(contentRef.current);
    ownerWindow.addEventListener('resize', schedule);
    ownerWindow.addEventListener('scroll', schedule, true);
    ownerWindow.visualViewport?.addEventListener('resize', schedule);
    ownerWindow.visualViewport?.addEventListener('scroll', schedule);
    update(true);
    return () => {
      disposed = true; stopPointer(); stopTheme(); observer?.disconnect();
      ownerWindow.cancelAnimationFrame(frame);
      origin.removeEventListener('pointermove', localPointer);
      origin.removeEventListener('keydown', localKeyboard, true);
      ownerWindow.removeEventListener('resize', schedule);
      ownerWindow.removeEventListener('scroll', schedule, true);
      ownerWindow.visualViewport?.removeEventListener('resize', schedule);
      ownerWindow.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [origin, store, scoped, pinned, disabled, ownsPanel, panelToken, dense, effective?.tooltipPlacement, effective?.tooltipOffset, effective?.tooltipMaxWidth, effective?.tooltipMaxHeight]);

  useLayoutEffect(() => {
    if (!origin || disabled || !ownsPanel) return;
    let described: Element | null = null, added = false;
    const clear = () => {
      if (described && added) {
        const remaining = (described.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(token => token && token !== id);
        if (remaining.length) described.setAttribute('aria-describedby', remaining.join(' '));
        else described.removeAttribute('aria-describedby');
      }
      described = null; added = false;
    };
    const update = () => {
      if (store.getPanelOwner() !== panelToken || described && (pinned || store.isPanelEngaged() || store.isHandoffActive(origin))) return;
      const interaction = store.getSnapshot();
      const target = interaction.kind === 'keyboard' && interaction.anchor?.isConnected && origin.contains(interaction.anchor) ? interaction.anchor : origin;
      if (target === described) return;
      clear(); described = target;
      const existing = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      added = !existing.includes(id);
      if (added) target.setAttribute('aria-describedby', [...existing, id].join(' '));
    };
    update(); const stop = store.subscribe(update);
    return () => { stop(); clear(); };
  }, [origin, disabled, ownsPanel, panelToken, pinned, id, store]);

  useLayoutEffect(() => {
    if (!origin || disabled || !ownsPanel) return;
    const ownerDocument = origin.ownerDocument;
    const dismiss = (reason: TooltipDismissReason) => withTooltipDismissReason(reason, () => callbacks.current.onDismiss(reason));
    const pointer = (event: PointerEvent) => {
      if (store.getPanelOwner() !== panelToken) return;
      if (event.target instanceof Node && !origin.contains(event.target) && !panelRef.current?.contains(event.target)) dismiss('outside');
    };
    const keyboard = (event: KeyboardEvent) => {
      if (store.getPanelOwner() !== panelToken) return;
      const panel = panelRef.current, target = event.target instanceof Node ? event.target : null;
      const inside = !!target && (origin.contains(target) || !!panel?.contains(target));
      if (event.key === 'Escape' || event.defaultPrevented) return;
      if (!panel || !inside) return;
      if (event.key === 'Tab' && !event.shiftKey && pinned && !!target && origin.contains(target)) {
        const first = panel.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]');
        if (first) { event.preventDefault(); first.focus({ preventScroll: true }); }
      }
      // Home/End on the chart belong to first/last-observation navigation.
      if (!target || !panel.contains(target) || !['PageDown', 'PageUp', 'Home', 'End'].includes(event.key) || (target instanceof Element && target.matches('input,textarea,select,[contenteditable=true]'))) return;
      event.preventDefault(); event.stopPropagation();
      const maximum = Math.max(0, panel.scrollHeight - panel.clientHeight), page = Math.max(48, Math.round(panel.clientHeight * .8));
      panel.scrollTop = event.key === 'Home' ? 0 : event.key === 'End' ? maximum : Math.max(0, Math.min(maximum, panel.scrollTop + (event.key === 'PageDown' ? page : -page)));
    };
    const escape = (event: TooltipEscapeEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || store.getPanelOwner() !== panelToken) return false;
      const panel = panelRef.current, target = event.target instanceof Element ? event.target : null;
      const inside = !!target && (origin.contains(target) || !!panel?.contains(target));
      const pointerOwned = !pinned && (origin.matches(':hover') || panel?.matches(':hover'));
      if (!inside && !pointerOwned) return false;
      // A nested listbox/menu/dialog owns its own first Escape. Listen in the
      // bubble phase so its native/React handler can consume the event first.
      if (target?.closest('[role="listbox"],[role="menu"],[role="combobox"][aria-expanded="true"],[aria-haspopup][aria-expanded="true"]')) return false;
      const nested = target?.closest('dialog[open],[role="dialog"]');
      if (nested && nested !== panel && !nested.contains(origin) && !nested.contains(panel)) return false;
      event.preventDefault(); event.stopPropagation(); dismiss('escape'); return true;
    };
    ownerDocument.addEventListener('pointerdown', pointer, true);
    ownerDocument.addEventListener('keydown', keyboard, true);
    ownerDocument.addEventListener('keydown', escape);
    const stopEscape = store.registerEscape(escape);
    return () => { stopEscape(); ownerDocument.removeEventListener('pointerdown', pointer, true); ownerDocument.removeEventListener('keydown', keyboard, true); ownerDocument.removeEventListener('keydown', escape); };
  }, [origin, disabled, pinned, ownsPanel, panelToken, store]);

  if (!origin || disabled || !ownsPanel || typeof document === 'undefined') return null;
  const portalContainer = origin.closest<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]') ?? origin.ownerDocument.body;
  return createPortal(<div ref={panelRef} id={id} role={pinned ? 'dialog' : 'tooltip'} aria-label={pinned ? label ?? 'Pinned observation' : label}
    className={`${styles.heatmapTooltip} ${className}`} data-observation-tooltip="" data-pinned={pinned || undefined}
    data-inspector-density={dense ? 'compact' : 'comfortable'}
    style={{ visibility: 'hidden' }}
    onPointerEnter={() => { store.setPanelHovered(panelToken, true); callbacks.current.onEnter?.(); }}
    onPointerLeave={() => { callbacks.current.onLeave?.(); store.setPanelHovered(panelToken, false); }}
    onFocusCapture={() => { store.setPanelFocused(panelToken, true); callbacks.current.onEnter?.(); }}
    onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        if (!origin.contains(event.relatedTarget as Node | null)) callbacks.current.onLeave?.();
        store.setPanelFocused(panelToken, false);
      }
    }}
  ><div ref={contentRef} className={styles.observationTooltipContent} data-observation-tooltip-content="">{children}</div></div>, portalContainer);
}

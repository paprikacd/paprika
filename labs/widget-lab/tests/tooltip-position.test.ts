import { describe, expect, it, vi } from 'vitest';
import { limitTooltipSize, positionObservationTooltip, tooltipViewportBounds, type TooltipPlacement } from '../src/vendor/paprika/ui/src/features/insights/tooltip-position';
import { createTooltipInteractionStore } from '../src/vendor/paprika/ui/src/features/insights/tooltip-interaction';

describe('shared observation tooltip positioning', () => {
  const viewport = { width: 1000, height: 700 };
  const point = (x: number, y: number) => ({ left: x, right: x, top: y, bottom: y });

  it('tracks the exact pointer without easing and flips away from the viewport edge', () => {
    const first = positionObservationTooltip(point(50, 80), { width: 330, height: 260 }, viewport);
    const moved = positionObservationTooltip(point(55, 84), { width: 330, height: 260 }, viewport);
    expect(moved.left - first.left).toBe(5); expect(moved.top - first.top).toBe(4);
    expect(first.placement).toBe('right'); expect(first.left).toBe(62);
    const edge = positionObservationTooltip(point(970, 350), { width: 330, height: 260 }, viewport);
    expect(edge.placement).toBe('left'); expect(edge.left + edge.width).toBe(958);
  });

  it('treats explicit placement as a preference and flips when that side cannot fit', () => {
    const top = positionObservationTooltip(point(500, 450), { width: 250, height: 160 }, viewport, 'top', 20);
    expect(top.placement).toBe('top'); expect(top.top).toBe(270);
    const flipped = positionObservationTooltip(point(500, 20), { width: 250, height: 160 }, viewport, 'top', 20);
    expect(flipped.placement).toBe('bottom'); expect(flipped.top).toBe(40);
  });

  it('keeps every side inside narrow, offset, small and scrolled visual viewports', () => {
    const placements: TooltipPlacement[] = ['auto', 'top', 'right', 'bottom', 'left'];
    for (const current of [viewport, { width: 320, height: 240 }, { left: 73, top: 115, width: 275, height: 190 }, { width: 18, height: 15 }]) {
      const bounds = tooltipViewportBounds(current);
      for (const placement of placements) for (const x of [-100, bounds.left, bounds.right / 2, bounds.right, 2000]) for (const y of [-100, bounds.top, bounds.bottom / 2, bounds.bottom, 2000]) {
        const result = positionObservationTooltip(point(x, y), { width: 640, height: 800 }, current, placement);
        expect(result.left).toBeGreaterThanOrEqual(bounds.left);
        expect(result.top).toBeGreaterThanOrEqual(bounds.top);
        expect(result.left + result.width).toBeLessThanOrEqual(bounds.right + 1e-9);
        expect(result.top + result.height).toBeLessThanOrEqual(bounds.bottom + 1e-9);
        expect(Object.values(result).filter(value => typeof value === 'number').every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('reserves a scrollable region below or above a pointer when neither side fits', () => {
    const result = positionObservationTooltip(point(150, 85), { width: 292, height: 560 }, { width: 320, height: 260 });
    expect(result.placement).toBe('bottom');
    expect(result.top).toBe(97); expect(result.height).toBe(151);
  });

  it('uses element bounds for keyboard inspection and permits zero pointer offset', () => {
    const result = positionObservationTooltip({ left: 40, right: 110, top: 150, bottom: 180 }, { width: 250, height: 100 }, viewport, 'right', 0);
    expect(result.left).toBe(110); expect(result.top).toBe(115);
    expect(limitTooltipSize({ width: 330, height: 560 }, { left: 80, top: 40, width: 300, height: 200 })).toEqual({ width: 276, height: 176 });
  });
});

describe('imperative tooltip interaction ownership', () => {
  it('publishes exact coordinates synchronously and cleans subscriptions', () => {
    const store = createTooltipInteractionStore(), seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().x));
    store.pointer(12.25, 40.5, null); store.pointer(20, 42, null);
    expect(seen).toEqual([12.25, 20]); expect(store.getSnapshot()).toMatchObject({ kind: 'pointer', x: 20, y: 42 });
    unsubscribe(); store.pointer(30, 44, null); expect(seen).toHaveLength(2);
    store.pointer(NaN, 45, null); expect(store.getSnapshot().x).toBe(30);
  });

  it('distinguishes keyboard anchors and keeps the interactive portal engaged until both hover and focus leave', () => {
    const store = createTooltipInteractionStore(), anchor = {} as Element;
    const owner = Symbol('panel'); store.claimPanel(owner, false, () => {});
    store.pointer(100, 100, null); store.keyboard(anchor);
    expect(store.getSnapshot()).toMatchObject({ kind: 'keyboard', anchor });
    store.setPanelHovered(owner, true); store.setPanelFocused(owner, true); store.setPanelHovered(owner, false);
    expect(store.isPanelEngaged()).toBe(true);
    store.setPanelFocused(owner, false); expect(store.isPanelEngaged()).toBe(false);
  });

  it('routes the innermost unconsumed Escape before a parent editor and releases ownership on unmount', () => {
    const store = createTooltipInteractionStore(), handled: string[] = [];
    const event = { key: 'Escape', target: null, defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
    const removeFirst = store.registerEscape(() => { handled.push('first'); return true; });
    const removeSecond = store.registerEscape(() => { handled.push('second'); return true; });
    expect(store.handleEscape(event)).toBe(true); expect(handled).toEqual(['second']);
    removeSecond(); expect(store.handleEscape(event)).toBe(true); expect(handled).toEqual(['second', 'first']);
    expect(store.handleEscape({ ...event, defaultPrevented: true })).toBe(false);
    expect(store.handleEscape({ ...event, key: 'Home' })).toBe(false);
    expect(store.handleEscape({ ...event, key: 'End' })).toBe(false);
    removeFirst(); expect(store.handleEscape(event)).toBe(false);
  });

  it('publishes source focus ownership independently of pointer coordinates', () => {
    const store = createTooltipInteractionStore();
    let notifications = 0; const unsubscribe = store.subscribe(() => notifications++);
    store.keyboard(null); store.setSourceFocused(true);
    expect(store.isSourceFocused()).toBe(true); expect(store.getSnapshot().kind).toBe('keyboard');
    store.setSourceFocused(false); expect(store.isSourceFocused()).toBe(false);
    expect(notifications).toBe(3); unsubscribe();
  });

  it('holds the observation while crossing blank space and releases only its own handoff', () => {
    const store = createTooltipInteractionStore(), first = Symbol('first'), second = Symbol('second');
    const mark = {} as Element, other = {} as Element;
    const origin = { contains: (candidate: Element) => candidate === mark } as Element;
    store.pointer(100, 100, mark); store.setHandoff(first, true);
    store.pointer(150, 150, other); store.setHandoff(first, true);
    expect(store.isHandoffActive(origin)).toBe(true);
    expect(store.getSnapshot().x).toBe(150); // Raw coordinates remain current for the next inspected mark.
    store.setHandoff(second, true, mark); store.setHandoff(first, false);
    expect(store.isHandoffActive(origin)).toBe(true);
    store.setHandoff(second, false); expect(store.isHandoffActive(origin)).toBe(false);
  });

  it('retains keyboard focus on the observed mark across pointer exit, then releases it for an unrelated control', () => {
    const store = createTooltipInteractionStore(), mark = {} as Element, control = {} as Element;
    store.keyboard(mark); store.setSourceFocused(true, mark, true);
    store.pointer(900, 600, null);
    expect(store.getSourceFocus()).toEqual({ anchor: mark, keyboard: true });
    store.keyboard(control); store.setSourceFocused(true, control, true);
    expect(store.getSourceFocus()?.anchor).not.toBe(mark);
    store.setSourceFocused(false); expect(store.getSourceFocus()).toBeNull();
  });

  it('keeps a pinned panel over transient competitors and accepts explicit replacement without stale cleanup', () => {
    const store = createTooltipInteractionStore(), first = Symbol('first'), second = Symbol('second');
    const replaced = vi.fn(), ownerChanged = vi.fn();
    const unsubscribe = store.subscribePanelOwner(ownerChanged);
    expect(store.claimPanel(first, true, replaced)).toBe(true);
    store.setPanelHovered(first, true); store.setPanelFocused(first, true);
    expect(store.claimPanel(second, false, () => {})).toBe(false);
    expect(store.getPanelOwner()).toBe(first); expect(replaced).not.toHaveBeenCalled();
    expect(store.claimPanel(second, true, () => {})).toBe(true);
    expect(replaced).toHaveBeenCalledTimes(1); expect(store.isPanelEngaged()).toBe(false);
    store.setPanelHovered(second, true);
    store.releasePanel(first); store.setPanelHovered(first, false); store.setPanelFocused(first, true);
    expect(store.getPanelOwner()).toBe(second); expect(store.isPanelEngaged()).toBe(true);
    store.setPanelHovered(second, false); expect(store.isPanelEngaged()).toBe(false);
    store.pointer(30, 40, null); expect(ownerChanged).toHaveBeenCalledTimes(2);
    store.releasePanel(second); expect(store.getPanelOwner()).toBeNull();
    unsubscribe();
  });

  it('updates pin state in place and retires an unpinned owner on a new observation', () => {
    const store = createTooltipInteractionStore(), first = Symbol('first'), second = Symbol('second'), retired = vi.fn();
    store.claimPanel(first, true, retired);
    store.setHandoff(Symbol('crossing'), true);
    store.claimPanel(first, false, retired);
    expect(store.claimPanel(second, false, () => {})).toBe(true);
    expect(retired).toHaveBeenCalledTimes(1); expect(store.isHandoffActive()).toBe(false);
  });
});

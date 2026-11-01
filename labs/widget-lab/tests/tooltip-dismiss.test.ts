import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTooltipDismissController } from '../src/components/lab/useTooltipDismiss';

describe('transient tooltip handoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    const state = { pinned: false, enabled: true, engaged: false }, dismiss = vi.fn();
    const controller = createTooltipDismissController(() => state, dismiss);
    return { state, dismiss, controller };
  };

  it('clears blank-space hover after one bounded grace period and cancels for a new observation', () => {
    const { controller, dismiss } = setup();
    controller.schedule(); vi.advanceTimersByTime(179); expect(dismiss).not.toHaveBeenCalled();
    controller.cancel(); vi.advanceTimersByTime(500); expect(dismiss).not.toHaveBeenCalled();
    for (let index = 0; index < 20; index++) controller.schedule();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(180); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('holds the current observation while the pointer or keyboard enters the popup, then resumes dismissal', () => {
    const { controller, state, dismiss } = setup();
    controller.schedule(); vi.advanceTimersByTime(100);
    state.engaged = true; controller.engagementChanged();
    vi.advanceTimersByTime(1000); expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(179); expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses after portal disengagement even when a relatedTarget handoff cancelled the first timer', () => {
    const { controller, state, dismiss } = setup();
    controller.schedule(); controller.cancel();
    state.engaged = true; controller.engagementChanged();
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(180); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not let repeated pointer notifications postpone an already scheduled hide', () => {
    const { controller, dismiss } = setup();
    controller.schedule();
    for (let index = 0; index < 18; index++) { vi.advanceTimersByTime(10); controller.engagementChanged(); }
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not restart the grace period when moving repeatedly across empty plot space', () => {
    const { controller, dismiss } = setup();
    controller.schedule();
    for (let index = 0; index < 17; index++) { vi.advanceTimersByTime(10); controller.schedule(); }
    expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10); expect(dismiss).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('freezes positioning for the bounded handoff and releases on a new mark, dismissal, or source reset', () => {
    const state = { pinned: false, enabled: true, engaged: false }, dismiss = vi.fn(), holds: boolean[] = [];
    const controller = createTooltipDismissController(() => state, dismiss, held => holds.push(held));
    controller.schedule(); expect(holds.at(-1)).toBe(true);
    controller.cancel(); expect(holds.at(-1)).toBe(false);
    controller.schedule(); vi.advanceTimersByTime(180);
    expect(dismiss).toHaveBeenCalledTimes(1); expect(holds.at(-1)).toBe(false);
    controller.schedule(); controller.reset();
    expect(holds.at(-1)).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('protects a newly focused mark, then honors an explicit leave after an ownership reset', () => {
    const { controller, state, dismiss } = setup();
    state.engaged = true; controller.cancel(); controller.reset();
    controller.schedule(); vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(180); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('never dismisses a pin or disabled inspection and cleans timers on source replacement', () => {
    const { controller, state, dismiss } = setup();
    state.pinned = true; controller.schedule(); expect(vi.getTimerCount()).toBe(0);
    state.pinned = false; state.enabled = false; controller.schedule(); expect(vi.getTimerCount()).toBe(0);
    state.enabled = true; controller.schedule();
    state.engaged = true; controller.engagementChanged(); controller.reset();
    // The invalidated popup's unmount must not schedule a hide in the new result.
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(1000); expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('makes unmount cleanup final even if an old callback attempts to schedule work', () => {
    const { controller, dismiss } = setup();
    controller.schedule(); controller.dispose(); controller.schedule();
    vi.advanceTimersByTime(1000); expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

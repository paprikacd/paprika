import { describe, expect, it, vi } from 'vitest';
import { isRestoringTooltipFocus, restoreTooltipFocus, withTooltipDismissReason } from '@insights/tooltip-focus';

describe('reason-aware observation dismissal', () => {
  it('restores focus for explicit dismissal and retains the outside click target', () => {
    const target = { isConnected: true, focus: vi.fn() };
    expect(withTooltipDismissReason('outside', () => restoreTooltipFocus(target))).toBe(false);
    expect(withTooltipDismissReason('superseded', () => restoreTooltipFocus(target))).toBe(false);
    expect(target.focus).not.toHaveBeenCalled();
    expect(withTooltipDismissReason('escape', () => restoreTooltipFocus(target))).toBe(true);
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(withTooltipDismissReason('close', () => restoreTooltipFocus(target))).toBe(true);
  });

  it('preserves outer outside policy through nested closes and resets after repeated events', () => {
    const target = { isConnected: true, focus: vi.fn() };
    for (let event = 0; event < 3; event++) withTooltipDismissReason('outside', () => {
      withTooltipDismissReason('close', () => restoreTooltipFocus(target));
      withTooltipDismissReason('outside', () => restoreTooltipFocus(target));
      restoreTooltipFocus(target);
    });
    expect(target.focus).not.toHaveBeenCalled();
    restoreTooltipFocus(target); expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('resets suppression after a failing callback and never focuses a detached trigger', () => {
    const target = { isConnected: true, focus: vi.fn() };
    expect(() => withTooltipDismissReason('outside', () => { throw new Error('dismiss failed'); })).toThrow('dismiss failed');
    expect(restoreTooltipFocus(target)).toBe(true);
    target.isConnected = false; expect(restoreTooltipFocus(target)).toBe(false);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('marks only the synchronous focus return so ordinary focus can inspect again', () => {
    const during: boolean[] = [];
    restoreTooltipFocus({ isConnected: true, focus: () => { during.push(isRestoringTooltipFocus()); } });
    expect(during).toEqual([true]); expect(isRestoringTooltipFocus()).toBe(false);
    expect(() => restoreTooltipFocus({ isConnected: true, focus: () => { throw new Error('focus failed'); } })).toThrow('focus failed');
    expect(isRestoringTooltipFocus()).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { isRestoringTooltipFocus, restoreTooltipFocus, tooltipFocusOwner, withTooltipDismissReason } from "./tooltip-focus";

describe("reason-aware observation dismissal", () => {
  it("restores focus for explicit dismissal and never for passive dismissal", () => {
    const target = { isConnected: true, focus: vi.fn() };
    expect(withTooltipDismissReason("outside", () => restoreTooltipFocus(target))).toBe(false);
    expect(withTooltipDismissReason("superseded", () => restoreTooltipFocus(target))).toBe(false);
    expect(withTooltipDismissReason("blur", () => restoreTooltipFocus(target))).toBe(false);
    expect(target.focus).not.toHaveBeenCalled();
    expect(withTooltipDismissReason("escape", () => restoreTooltipFocus(target))).toBe(true);
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(withTooltipDismissReason("close", () => restoreTooltipFocus(target))).toBe(true);
  });

  it("keeps an outer passive policy through nested explicit closes and resets after repeated events", () => {
    const target = { isConnected: true, focus: vi.fn() };
    for (let event = 0; event < 3; event++) withTooltipDismissReason("outside", () => {
      withTooltipDismissReason("close", () => restoreTooltipFocus(target));
      withTooltipDismissReason("outside", () => restoreTooltipFocus(target));
      restoreTooltipFocus(target);
    });
    expect(target.focus).not.toHaveBeenCalled();
    restoreTooltipFocus(target);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it("resets suppression after a failing callback and never focuses a detached opener", () => {
    const target = { isConnected: true, focus: vi.fn() };
    expect(() => withTooltipDismissReason("outside", () => { throw new Error("dismiss failed"); })).toThrow("dismiss failed");
    expect(restoreTooltipFocus(target)).toBe(true);
    target.isConnected = false;
    expect(restoreTooltipFocus(target)).toBe(false);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it("marks only the synchronous focus return so ordinary focus can inspect again", () => {
    const during: boolean[] = [];
    restoreTooltipFocus({ isConnected: true, focus: () => { during.push(isRestoringTooltipFocus()); } });
    expect(during).toEqual([true]);
    expect(isRestoringTooltipFocus()).toBe(false);
    expect(() => restoreTooltipFocus({ isConnected: true, focus: () => { throw new Error("focus failed"); } })).toThrow("focus failed");
    expect(isRestoringTooltipFocus()).toBe(false);
  });

  it("returns focus to the control that contains a non-focusable anchor, or to the anchor when it is focusable", () => {
    const button = document.createElement("button");
    const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const point = document.createElementNS("http://www.w3.org/2000/svg", "path");
    button.appendChild(chart);
    chart.appendChild(point);
    document.body.appendChild(button);
    try {
      expect(tooltipFocusOwner(point)).toBe(button);
      expect(tooltipFocusOwner(button)).toBe(button);
      expect(tooltipFocusOwner(null)).toBeNull();
    } finally {
      button.remove();
    }
  });

  it("skips a region that is only programmatically focusable, and returns to a focusable chart", () => {
    const region = document.createElement("section");
    region.tabIndex = -1;
    const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const point = document.createElementNS("http://www.w3.org/2000/svg", "path");
    chart.setAttribute("tabindex", "0");
    chart.appendChild(point);
    region.appendChild(chart);
    document.body.appendChild(region);
    try {
      expect(tooltipFocusOwner(point)).toBe(chart);
      chart.removeAttribute("tabindex");
      expect(tooltipFocusOwner(point)).toBe(point);
    } finally {
      region.remove();
    }
  });
});

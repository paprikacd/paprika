import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachTooltipDismissal, createTooltipDismissController, type TooltipDismissalTarget } from "./tooltip-dismiss";
import type { TooltipDismissReason } from "./tooltip-focus";

describe("transient tooltip handoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    const state = { pinned: false, enabled: true, engaged: false }, dismiss = vi.fn();
    const controller = createTooltipDismissController(() => state, dismiss);
    return { state, dismiss, controller };
  };

  it("clears blank-space hover after one bounded grace period and cancels for a new observation", () => {
    const { controller, dismiss } = setup();
    controller.schedule(); vi.advanceTimersByTime(179); expect(dismiss).not.toHaveBeenCalled();
    controller.cancel(); vi.advanceTimersByTime(500); expect(dismiss).not.toHaveBeenCalled();
    for (let index = 0; index < 20; index++) controller.schedule();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(180); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("holds the current observation while the pointer or keyboard enters the popup, then resumes dismissal", () => {
    const { controller, state, dismiss } = setup();
    controller.schedule(); vi.advanceTimersByTime(100);
    state.engaged = true; controller.engagementChanged();
    vi.advanceTimersByTime(1000); expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(179); expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses after portal disengagement even when a relatedTarget handoff cancelled the first timer", () => {
    const { controller, state, dismiss } = setup();
    controller.schedule(); controller.cancel();
    state.engaged = true; controller.engagementChanged();
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(180); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not let repeated pointer notifications postpone an already scheduled hide", () => {
    const { controller, dismiss } = setup();
    controller.schedule();
    for (let index = 0; index < 18; index++) { vi.advanceTimersByTime(10); controller.engagementChanged(); }
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not restart the grace period when moving repeatedly across empty plot space", () => {
    const { controller, dismiss } = setup();
    controller.schedule();
    for (let index = 0; index < 17; index++) { vi.advanceTimersByTime(10); controller.schedule(); }
    expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10); expect(dismiss).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("freezes positioning for the bounded handoff and releases on a new mark, dismissal, or source reset", () => {
    const state = { pinned: false, enabled: true, engaged: false }, dismiss = vi.fn(), holds: boolean[] = [];
    const controller = createTooltipDismissController(() => state, dismiss, held => holds.push(held));
    controller.schedule(); expect(holds.at(-1)).toBe(true);
    controller.cancel(); expect(holds.at(-1)).toBe(false);
    controller.schedule(); vi.advanceTimersByTime(180);
    expect(dismiss).toHaveBeenCalledTimes(1); expect(holds.at(-1)).toBe(false);
    controller.schedule(); controller.reset();
    expect(holds.at(-1)).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("protects a newly focused mark, then honors an explicit leave after an ownership reset", () => {
    const { controller, state, dismiss } = setup();
    state.engaged = true; controller.cancel(); controller.reset();
    controller.schedule(); vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(180); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("never dismisses a pin or disabled inspection and cleans timers on source replacement", () => {
    const { controller, state, dismiss } = setup();
    state.pinned = true; controller.schedule(); expect(vi.getTimerCount()).toBe(0);
    state.pinned = false; state.enabled = false; controller.schedule(); expect(vi.getTimerCount()).toBe(0);
    state.enabled = true; controller.schedule();
    state.engaged = true; controller.engagementChanged(); controller.reset();
    // The invalidated popup's unmount must not schedule a hide in the new result.
    state.engaged = false; controller.engagementChanged();
    vi.advanceTimersByTime(1000); expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("makes unmount cleanup final even if an old callback attempts to schedule work", () => {
    const { controller, dismiss } = setup();
    controller.schedule(); controller.dispose(); controller.schedule();
    vi.advanceTimersByTime(1000); expect(dismiss).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("one dismissal path for an open panel", () => {
  const detachers: (() => void)[] = [];
  const nodes: Element[] = [];
  const build = (tag: string) => { const node = document.createElement(tag); document.body.append(node); nodes.push(node); return node; };
  afterEach(() => {
    while (detachers.length) detachers.pop()!();
    while (nodes.length) nodes.pop()!.remove();
  });

  /** Attaches a panel whose anchor and panel are fixed elements. A dismissal detaches it, as an unmounting owner does. */
  const panel = (pinned: boolean) => {
    const anchor = build("button"), body = build("div"), button = document.createElement("button");
    body.append(button);
    const reasons: TooltipDismissReason[] = [];
    let detach = () => {};
    const target: TooltipDismissalTarget = { anchor, panel: () => body, pinned, dismiss: reason => { reasons.push(reason); detach(); } };
    detach = attachTooltipDismissal(Symbol("panel"), () => target);
    detachers.push(() => detach());
    return { anchor, body, control: button, reasons };
  };

  it("dismisses as outside when the pointer goes outside the anchor and panel, even while pinned", () => {
    const outside = build("span");
    const { anchor, body, reasons } = panel(true);
    fireEvent.pointerDown(anchor); fireEvent.pointerDown(body); fireEvent.pointerDown(body.firstElementChild!);
    expect(reasons).toEqual([]);
    fireEvent.pointerDown(outside);
    expect(reasons).toEqual(["outside"]);
  });

  it("dismisses as blur when focus moves outside, but keeps a pinned panel open", () => {
    const outside = build("button");
    const transient = panel(false), pinned = panel(true);
    fireEvent.focusIn(transient.anchor); fireEvent.focusIn(transient.control);
    expect(transient.reasons).toEqual([]);
    fireEvent.focusIn(outside);
    expect(transient.reasons).toEqual(["blur"]);
    fireEvent.focusIn(outside);
    expect(pinned.reasons).toEqual([]);
  });

  it("closes the topmost panel first, and each Escape press closes only one", () => {
    const first = panel(true), second = panel(true);
    fireEvent.keyDown(first.anchor, { key: "Escape" });
    expect(second.reasons).toEqual(["escape"]);
    expect(first.reasons).toEqual([]);
    fireEvent.keyDown(first.anchor, { key: "Escape" });
    expect(first.reasons).toEqual(["escape"]);
  });

  it("raises a panel the user works in, so the next Escape closes it instead", () => {
    const first = panel(true), second = panel(true);
    fireEvent.focusIn(first.anchor);
    fireEvent.keyDown(second.anchor, { key: "Escape" });
    expect(first.reasons).toEqual(["escape"]);
    expect(second.reasons).toEqual([]);
  });

  it("leaves Escape to a Gamma menu, an open listbox, or a dialog that is not part of the panel", () => {
    const { reasons, anchor } = panel(false);
    const menu = build("div"); menu.setAttribute("data-gamma-portal", "");
    const menuItem = document.createElement("button"); menu.append(menuItem);
    fireEvent.keyDown(menuItem, { key: "Escape" });
    const listbox = build("ul"); listbox.setAttribute("role", "listbox");
    const option = document.createElement("li"); option.setAttribute("tabindex", "0"); listbox.append(option);
    fireEvent.keyDown(option, { key: "Escape" });
    const dialog = build("dialog"); dialog.setAttribute("open", "");
    const dialogButton = document.createElement("button"); dialog.append(dialogButton);
    fireEvent.keyDown(dialogButton, { key: "Escape" });
    expect(reasons).toEqual([]);
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(reasons).toEqual(["escape"]);
  });

  it("stops Escape only when it comes from the panel or its anchor, and not from another control", () => {
    const other = build("button");
    const elsewhere = vi.fn();
    other.addEventListener("keydown", elsewhere);
    const hovered = panel(false);
    fireEvent.keyDown(other, { key: "Escape" });
    expect(hovered.reasons).toEqual(["escape"]);
    expect(elsewhere).toHaveBeenCalledTimes(1);
    const owned = panel(false);
    const own = vi.fn();
    owned.anchor.addEventListener("keydown", own);
    fireEvent.keyDown(owned.anchor, { key: "Escape" });
    expect(owned.reasons).toEqual(["escape"]);
    expect(own).not.toHaveBeenCalled();
  });

  it("detaches its listeners and its Escape entry when the panel goes away", () => {
    const anchor = build("button"), reasons: TooltipDismissReason[] = [];
    const detach = attachTooltipDismissal(Symbol("gone"), () => ({ anchor, panel: () => null, pinned: false, dismiss: reason => { reasons.push(reason); } }));
    detach();
    fireEvent.keyDown(anchor, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(reasons).toEqual([]);
  });
});

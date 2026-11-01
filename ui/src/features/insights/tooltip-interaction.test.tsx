import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTooltipScopeStore, raiseTooltipEscape, registerTooltipEscape, tooltipScopeFor, WidgetTooltipProvider } from "./tooltip-interaction";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("per-widget panel ownership", () => {
  it("lets a transient preview take an empty scope and replaces the previous transient one", () => {
    const store = createTooltipScopeStore(), first = Symbol("first"), second = Symbol("second"), retired = vi.fn();
    expect(store.claim(first, false, retired)).toBe(true);
    expect(store.getOwner()).toBe(first);
    expect(store.claim(second, false, () => {})).toBe(true);
    expect(store.getOwner()).toBe(second);
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it("keeps a pinned owner over transient previews until another observation is pinned", () => {
    const store = createTooltipScopeStore(), pinned = Symbol("pinned"), hover = Symbol("hover"), other = Symbol("other");
    const retiredPinned = vi.fn();
    expect(store.claim(pinned, true, retiredPinned)).toBe(true);
    expect(store.claim(hover, false, () => {})).toBe(false);
    expect(store.getOwner()).toBe(pinned);
    expect(retiredPinned).not.toHaveBeenCalled();
    expect(store.claim(other, true, () => {})).toBe(true);
    expect(retiredPinned).toHaveBeenCalledTimes(1);
    expect(store.getOwner()).toBe(other);
  });

  it("updates the owner in place when it changes its pin, without retiring itself", () => {
    const store = createTooltipScopeStore(), owner = Symbol("owner"), retired = vi.fn();
    store.claim(owner, false, retired);
    expect(store.claim(owner, true, retired)).toBe(true);
    expect(store.claim(Symbol("hover"), false, () => {})).toBe(false);
    expect(retired).not.toHaveBeenCalled();
  });

  it("notifies subscribers as ownership changes and lets a waiting transient claim after release", () => {
    const store = createTooltipScopeStore(), pinned = Symbol("pinned"), waiting = Symbol("waiting");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.claim(pinned, true, () => {});
    expect(store.claim(waiting, false, () => {})).toBe(false);
    store.release(pinned);
    expect(store.getOwner()).toBeNull();
    expect(store.claim(waiting, false, () => {})).toBe(true);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.release(waiting);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("ignores a release from an owner that no longer holds the scope", () => {
    const store = createTooltipScopeStore(), first = Symbol("first"), second = Symbol("second");
    store.claim(first, false, () => {});
    store.claim(second, false, () => {});
    store.release(first);
    expect(store.getOwner()).toBe(second);
  });

  it("resolves an anchor's scope to the provider, else to its dashboard widget, else to the anchor alone", () => {
    const widgetA = document.createElement("article"), widgetB = document.createElement("article");
    widgetA.dataset.widgetId = "a"; widgetB.dataset.widgetId = "b";
    const firstAnchor = document.createElement("button"), secondAnchor = document.createElement("button"), loose = document.createElement("button");
    widgetA.append(firstAnchor, secondAnchor);
    widgetB.append(loose);
    document.body.append(widgetA, widgetB);
    const provided = createTooltipScopeStore();
    expect(tooltipScopeFor(firstAnchor, provided)).toBe(provided);
    expect(tooltipScopeFor(firstAnchor, null)).toBe(tooltipScopeFor(secondAnchor, null));
    expect(tooltipScopeFor(firstAnchor, null)).not.toBe(tooltipScopeFor(loose, null));
    const loneA = document.createElement("button"), loneB = document.createElement("button");
    document.body.append(loneA, loneB);
    expect(tooltipScopeFor(loneA, null)).toBe(tooltipScopeFor(loneA, null));
    expect(tooltipScopeFor(loneA, null)).not.toBe(tooltipScopeFor(loneB, null));
  });

  it("renders its children without adding any DOM of its own", () => {
    const { container } = render(<WidgetTooltipProvider><span>Chart</span></WidgetTooltipProvider>);
    expect(container.innerHTML).toBe("<span>Chart</span>");
    expect(screen.getByText("Chart")).toBeInTheDocument();
  });
});

describe("Escape stack", () => {
  it("routes Escape to the topmost panel only, and moves on after that panel leaves the stack", () => {
    const calls: string[] = [];
    const bottom = Symbol("bottom"), top = Symbol("top");
    const unregisterBottom = registerTooltipEscape(bottom, () => calls.push("bottom"));
    const unregisterTop = registerTooltipEscape(top, () => calls.push("top"));
    const target = document.createElement("button");
    document.body.append(target);
    fireEvent.keyDown(target, { key: "Escape" });
    expect(calls).toEqual(["top"]);
    unregisterTop();
    fireEvent.keyDown(target, { key: "Escape" });
    expect(calls).toEqual(["top", "bottom"]);
    unregisterBottom();
    fireEvent.keyDown(target, { key: "Escape" });
    expect(calls).toEqual(["top", "bottom"]);
  });

  it("ignores other keys and events that an earlier capture handler already prevented", () => {
    const handle = vi.fn(), token = Symbol("keys");
    // Registered before the stack's own listener, so it runs first in the capture phase.
    const preventEscape = (event: KeyboardEvent) => { if (event.key === "Escape") event.preventDefault(); };
    document.addEventListener("keydown", preventEscape, true);
    const unregister = registerTooltipEscape(token, handle);
    try {
      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(handle).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(handle).not.toHaveBeenCalled();
    } finally {
      unregister();
      document.removeEventListener("keydown", preventEscape, true);
    }
    const plain = vi.fn(), plainToken = Symbol("plain");
    const unregisterPlain = registerTooltipEscape(plainToken, plain);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(plain).toHaveBeenCalledTimes(1);
    unregisterPlain();
  });

  it("raises the panel the user works in, so it becomes the topmost", () => {
    const calls: string[] = [];
    const first = Symbol("first"), second = Symbol("second");
    const unregisterFirst = registerTooltipEscape(first, () => calls.push("first"));
    const unregisterSecond = registerTooltipEscape(second, () => calls.push("second"));
    raiseTooltipEscape(first);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(calls).toEqual(["first"]);
    raiseTooltipEscape(Symbol("unknown"));
    unregisterFirst();
    unregisterSecond();
  });

  it("removes its document listener once the stack is empty", () => {
    const handle = vi.fn(), token = Symbol("solo");
    const unregister = registerTooltipEscape(token, handle);
    unregister();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(handle).not.toHaveBeenCalled();
  });
});

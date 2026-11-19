import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useObservationOwner, type ObservationOwner } from "./observation-owner";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function anchors(...names: string[]) {
  return Object.fromEntries(names.map(name => [name, document.createElement("button")]));
}

function setup(initial: { revision?: unknown; keys?: readonly string[]; enabled?: boolean } = {}) {
  const hook = renderHook(
    (props: { revision: unknown; keys?: readonly string[]; enabled: boolean }) =>
      useObservationOwner({
        enabled: props.enabled,
        retention: props.keys ? { keys: props.keys } : { revision: props.revision },
        locate: key => (props.keys ? els[key] ?? null : null),
      }),
    { initialProps: { revision: initial.revision ?? 1, keys: initial.keys, enabled: initial.enabled ?? true } },
  );
  return hook;
}

let els: Record<string, HTMLElement> = {};

function owner(hook: { result: { current: ObservationOwner } }) {
  return hook.result.current;
}

describe("useObservationOwner grace", () => {
  it("closes one grace period after the last leave, and repeated leaves do not postpone it", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    expect(owner(hook).active?.key).toBe("a");
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(120));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(59));
    expect(owner(hook).active?.key).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(owner(hook).active).toBeUndefined();
  });

  it("holds the panel while the pointer is in it, and resumes the grace when it leaves", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => owner(hook).panelEnter());
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("a");
    act(() => owner(hook).panelLeave());
    act(() => vi.advanceTimersByTime(180));
    expect(owner(hook).active).toBeUndefined();
  });

  it("leaves no timer behind after unmount", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useObservationOwner engagement and pins", () => {
  it("keeps the new observation open when a late leave from the previous trigger arrives", () => {
    els = anchors("a", "b");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("b").onPointerEnter({ currentTarget: els.b, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("b");
  });

  it("never lets a hover replace a pin, and selecting the pinned observation again releases it", () => {
    els = anchors("a", "b");
    const hook = setup();
    act(() => owner(hook).trigger("a").onClick({ currentTarget: els.a }));
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: true });
    act(() => owner(hook).trigger("b").onPointerEnter({ currentTarget: els.b, pointerType: "mouse" }));
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: true });
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: true });
    act(() => owner(hook).toggle("a", els.a));
    expect(owner(hook).active).toBeUndefined();
  });

  it("moves the pin when another observation is selected", () => {
    els = anchors("a", "b");
    const hook = setup();
    act(() => owner(hook).toggle("a", els.a));
    act(() => owner(hook).toggle("b", els.b));
    expect(owner(hook).active).toMatchObject({ key: "b", pinned: true });
  });

  it("does not let a scene preview replace a pin", () => {
    els = anchors("a", "b");
    const hook = setup();
    act(() => owner(hook).toggle("a", els.a));
    act(() => owner(hook).preview("b", els.b));
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: true });
  });
});

describe("useObservationOwner engagement sources", () => {
  it("holds a focused trigger's panel after the pointer leaves", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onFocus({ currentTarget: els.a }));
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("a");
  });

  it("closes a focus-only preview after its blur and one grace period", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onFocus({ currentTarget: els.a }));
    act(() => owner(hook).trigger("a").onBlur({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(179));
    expect(owner(hook).active?.key).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(owner(hook).active).toBeUndefined();
  });

  it("keeps a hovered panel open when its trigger blurs while the pointer is still over it", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onFocus({ currentTarget: els.a }));
    act(() => owner(hook).trigger("a").onBlur({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("a");
  });

  it("holds a panel the pointer is in when its anchor blurs", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onFocus({ currentTarget: els.a }));
    act(() => owner(hook).panelEnter());
    act(() => owner(hook).trigger("a").onBlur({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("a");
    act(() => owner(hook).panelLeave());
    act(() => vi.advanceTimersByTime(180));
    expect(owner(hook).active).toBeUndefined();
  });

  it("ignores a focus that arrives while a pin is held", () => {
    els = anchors("a", "b");
    const hook = setup();
    act(() => owner(hook).trigger("a").onClick({ currentTarget: els.a }));
    act(() => owner(hook).trigger("b").onFocus({ currentTarget: els.b }));
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: true });
  });

  it("does not open a preview for a touch hover, and a tap pins instead", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "touch" }));
    expect(owner(hook).active).toBeUndefined();
    act(() => owner(hook).trigger("a").onClick({ currentTarget: els.a }));
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: true });
  });

  it("takes the anchor from the event, so a handler spreads onto JSX without a closure", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    expect(owner(hook).active?.anchor).toBe(els.a);
  });

  it("forgets a panel hold from before the owner was disabled", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).panelEnter());
    hook.rerender({ revision: 1, keys: undefined, enabled: false });
    hook.rerender({ revision: 1, keys: undefined, enabled: true });
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(180));
    expect(owner(hook).active).toBeUndefined();
  });

  it("leaves no timer behind in Strict Mode", () => {
    els = anchors("a");
    const hook = renderHook(() => useObservationOwner({ retention: { revision: 1 } }), { wrapper: StrictMode });
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useObservationOwner retention", () => {
  it("closes an open panel, pinned or not, when the revision changes", () => {
    els = anchors("a");
    const hook = setup({ revision: 1 });
    act(() => owner(hook).toggle("a", els.a));
    hook.rerender({ revision: 2, keys: undefined, enabled: true });
    expect(owner(hook).active).toBeUndefined();
  });

  it("keeps a pinned panel open across a refresh that keeps its key, and re-anchors it", () => {
    els = anchors("a");
    const hook = setup({ keys: ["a", "b"] });
    act(() => owner(hook).toggle("a", els.a));
    const moved = document.createElement("button");
    els = { a: moved };
    hook.rerender({ revision: 0, keys: ["a", "b"], enabled: true });
    expect(owner(hook).active?.key).toBe("a");
    expect(owner(hook).active?.pinned).toBe(true);
    expect(owner(hook).active?.anchor).toBe(moved);
  });

  it("closes and releases the pin when the key leaves the data", () => {
    els = anchors("a");
    const hook = setup({ keys: ["a", "b"] });
    act(() => owner(hook).toggle("a", els.a));
    hook.rerender({ revision: 0, keys: ["b"], enabled: true });
    expect(owner(hook).active).toBeUndefined();
  });
});

describe("useObservationOwner enablement", () => {
  it("closes any panel when the owner is disabled", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).toggle("a", els.a));
    hook.rerender({ revision: 1, keys: undefined, enabled: false });
    expect(owner(hook).active).toBeUndefined();
  });

  it("opens nothing while disabled", () => {
    els = anchors("a");
    const hook = setup({ enabled: false });
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    expect(owner(hook).active).toBeUndefined();
  });
});

describe("useObservationOwner focus, unpin and moved keys", () => {
  it("pin does nothing while the owner is disabled", () => {
    els = anchors("a");
    const hook = setup({ enabled: false });
    act(() => owner(hook).pin("a", els.a));
    expect(owner(hook).active).toBeUndefined();
  });

  it("holdFocus keeps focus on an anchor without previewing it, and the hold ends when focus leaves", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).holdFocus(els.a));
    expect(owner(hook).active).toBeUndefined();
    act(() => owner(hook).trigger("a").onPointerEnter({ currentTarget: els.a, pointerType: "mouse" }));
    act(() => owner(hook).trigger("a").onPointerLeave({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("a");
    act(() => owner(hook).trigger("a").onBlur({ currentTarget: els.a }));
    act(() => vi.advanceTimersByTime(180));
    expect(owner(hook).active).toBeUndefined();
  });

  it("unpin releases a pin and keeps the same panel as an unpinned preview", () => {
    els = anchors("a");
    const hook = setup();
    act(() => owner(hook).toggle("a", els.a));
    expect(owner(hook).active?.pinned).toBe(true);
    act(() => owner(hook).unpin());
    expect(owner(hook).active).toMatchObject({ key: "a", pinned: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(owner(hook).active?.key).toBe("a");
  });

  it("a pinned observation follows its key to its new key when a refresh moves it", () => {
    const next = document.createElement("button");
    const moved = new Map<string, Element>([["a2", next]]);
    let keys: readonly string[] = ["a1"];
    const resolve = (key: string) => (key === "a1" ? "a2" : undefined);
    const hook = renderHook(() => useObservationOwner({ retention: { keys, resolve }, locate: key => moved.get(key) ?? null }));
    els = anchors("a1");
    act(() => hook.result.current.toggle("a1", els.a1));
    keys = ["a2"];
    hook.rerender();
    expect(hook.result.current.active).toMatchObject({ key: "a2", pinned: true, anchor: next });
  });

  it("a pinned observation closes when no key resolves it", () => {
    let keys: readonly string[] = ["a1"];
    const hook = renderHook(() => useObservationOwner({ retention: { keys, resolve: () => undefined } }));
    els = anchors("a1");
    act(() => hook.result.current.toggle("a1", els.a1));
    keys = ["b"];
    hook.rerender();
    expect(hook.result.current.active).toBeUndefined();
  });
});

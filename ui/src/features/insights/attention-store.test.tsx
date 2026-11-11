import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttentionStore, AttentionStoreProvider, useAttentionPublisher, useWidgetAttentions } from "./attention-store";
import type { AttentionFacts } from "./widget-attention";

afterEach(cleanup);

const ok: AttentionFacts = { failure: "none", signal: "ok", threshold: null, breaches: null, freshness: "no_threshold" };
const critical: AttentionFacts = { ...ok, threshold: { state: "matched", status: "critical" } };
const pending: AttentionFacts = { failure: "none", signal: "pending", threshold: null, breaches: null, freshness: null };

describe("attention store", () => {
  it("keeps one entry per tile in first-published order, updating it in place", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", facts: ok });
    store.publish({ widgetId: "b", title: "Latency", facts: pending });
    store.publish({ widgetId: "a", title: "Errors", facts: critical });
    expect(store.getSnapshot()).toEqual([
      { widgetId: "a", title: "Errors", facts: critical, completedAt: undefined, mounted: true },
      { widgetId: "b", title: "Latency", facts: pending, completedAt: undefined, mounted: true },
    ]);
  });

  it("notifies only on a real change, including a change of settle time", () => {
    const store = createAttentionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.publish({ widgetId: "a", title: "Errors", facts: ok });
    store.publish({ widgetId: "a", title: "Errors", facts: { ...ok } });
    expect(listener).toHaveBeenCalledTimes(1);
    store.publish({ widgetId: "a", title: "Errors", facts: ok, completedAt: 5 });
    expect(listener).toHaveBeenCalledTimes(2);
    store.release("missing");
    store.prune(["a"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps a released tile's last known facts instead of dropping it", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", facts: critical, completedAt: 9 });
    store.release("a");
    store.release("a");
    expect(store.getSnapshot()).toEqual([{ widgetId: "a", title: "Errors", facts: critical, completedAt: 9, mounted: false }]);
    store.publish({ widgetId: "a", title: "Errors", facts: ok, completedAt: 9 });
    expect(store.getSnapshot()[0]).toMatchObject({ facts: ok, mounted: true });
  });

  it("forgets only the tiles the dashboard no longer lists", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", facts: ok });
    store.publish({ widgetId: "b", title: "Latency", facts: ok });
    store.release("b");
    store.prune(["b"]);
    expect(store.getSnapshot().map((entry) => entry.widgetId)).toEqual(["b"]);
  });

  it("gives subscribers the same snapshot until something changes", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", facts: ok });
    const first = store.getSnapshot();
    store.publish({ widgetId: "a", title: "Errors", facts: ok });
    expect(store.getSnapshot()).toBe(first);
  });

  it("is published and read through the provider, and is inert without one", () => {
    const outside = renderHook(() => useWidgetAttentions());
    expect(outside.result.current).toEqual([]);
    const { result } = renderHook(() => ({ publisher: useAttentionPublisher(), entries: useWidgetAttentions() }), {
      wrapper: ({ children }) => <AttentionStoreProvider>{children}</AttentionStoreProvider>,
    });
    act(() => result.current.publisher.publish({ widgetId: "a", title: "Errors", facts: critical }));
    expect(result.current.entries).toEqual([{ widgetId: "a", title: "Errors", facts: critical, completedAt: undefined, mounted: true }]);
    act(() => result.current.publisher.release("a"));
    expect(result.current.entries).toEqual([{ widgetId: "a", title: "Errors", facts: critical, completedAt: undefined, mounted: false }]);
    act(() => result.current.publisher.prune([]));
    expect(result.current.entries).toEqual([]);
  });
});

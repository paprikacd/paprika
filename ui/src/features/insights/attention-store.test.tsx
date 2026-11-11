import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttentionStore, AttentionStoreProvider, useAttentionPublisher, useWidgetAttentions } from "./attention-store";

afterEach(cleanup);

describe("attention store", () => {
  it("keeps one entry per tile in first-published order, updating it in place", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", state: "ok" });
    store.publish({ widgetId: "b", title: "Latency", state: "pending" });
    store.publish({ widgetId: "a", title: "Errors", state: "critical" });
    expect(store.getSnapshot()).toEqual([
      { widgetId: "a", title: "Errors", state: "critical" },
      { widgetId: "b", title: "Latency", state: "pending" },
    ]);
  });

  it("notifies only on a real change", () => {
    const store = createAttentionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.publish({ widgetId: "a", title: "Errors", state: "ok" });
    store.publish({ widgetId: "a", title: "Errors", state: "ok" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear("missing");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("removes a cleared tile and tolerates clearing it twice", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", state: "warning" });
    store.clear("a");
    store.clear("a");
    expect(store.getSnapshot()).toEqual([]);
  });

  it("gives subscribers the same snapshot until something changes", () => {
    const store = createAttentionStore();
    store.publish({ widgetId: "a", title: "Errors", state: "ok" });
    const first = store.getSnapshot();
    store.publish({ widgetId: "a", title: "Errors", state: "ok" });
    expect(store.getSnapshot()).toBe(first);
  });

  it("is published and read through the provider, and is inert without one", () => {
    const outside = renderHook(() => useWidgetAttentions());
    expect(outside.result.current).toEqual([]);
    const { result } = renderHook(() => ({ publisher: useAttentionPublisher(), entries: useWidgetAttentions() }), {
      wrapper: ({ children }) => <AttentionStoreProvider>{children}</AttentionStoreProvider>,
    });
    act(() => result.current.publisher.publish({ widgetId: "a", title: "Errors", state: "failed" }));
    expect(result.current.entries).toEqual([{ widgetId: "a", title: "Errors", state: "failed" }]);
    act(() => result.current.publisher.clear("a"));
    expect(result.current.entries).toEqual([]);
  });
});

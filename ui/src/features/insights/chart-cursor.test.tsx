import { describe, expect, it, vi } from "vitest";
import { createChartCursorStore } from "./chart-cursor";

describe("dashboard chart cursor", () => {
  it("shares exact observation times without mixing separate dashboards", () => {
    const first = createChartCursorStore(), second = createChartCursorStore();
    const changed = vi.fn(); first.subscribe(changed);
    first.publish("requests", 1234.5);
    expect(first.getSnapshot()).toEqual({ source: "requests", timestamp: 1234.5, pinned: false });
    expect(second.getSnapshot()).toBeNull();
    first.publish("requests", 1234.5);
    first.publish("requests", NaN);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("keeps a pinned observation while another chart is hovered and releases only its owner", () => {
    const store = createChartCursorStore();
    store.publish("latency", 2000, true);
    store.publish("errors", 3000);
    store.clear("errors");
    expect(store.getSnapshot()?.timestamp).toBe(2000);
    store.clear("latency");
    store.publish("errors", 3000);
    expect(store.getSnapshot()).toEqual({ source: "errors", timestamp: 3000, pinned: false });
  });
  it("restores a still-hovered chart when a pinned chart refreshes or unmounts", () => {
    const store = createChartCursorStore();
    store.publish("latency", 2000, true);
    store.publish("errors", 3000.25);
    expect(store.getSnapshot()?.source).toBe("latency");
    store.clear("latency");
    expect(store.getSnapshot()).toEqual({ source: "errors", timestamp: 3000.25, pinned: false });
    store.clear("errors");
    expect(store.getSnapshot()).toBeNull();
  });
});

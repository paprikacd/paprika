import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_STAGGER_CAP_MS, refreshStaggerSpread, staggerOffsetMs, useStaggeredWindow } from "./refresh-stagger";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("refreshStaggerSpread", () => {
  it("is a quarter of the refresh interval, capped", () => {
    expect(refreshStaggerSpread(10)).toBe(2500);
    expect(refreshStaggerSpread(60)).toBe(REFRESH_STAGGER_CAP_MS);
    expect(refreshStaggerSpread(0)).toBe(0);
  });
});

describe("staggerOffsetMs", () => {
  it("is stable for a widget id and stays inside the spread", () => {
    const first = staggerOffsetMs("requests", 4000);
    expect(staggerOffsetMs("requests", 4000)).toBe(first);
    for (const id of ["a", "b", "requests", "latency-p99", "tile-with-a-longer-id"]) {
      const offset = staggerOffsetMs(id, 4000);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(4000);
    }
  });

  it("spreads different widgets over different offsets", () => {
    const offsets = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(id => staggerOffsetMs(id, 4000)));
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("is zero without a spread", () => {
    expect(staggerOffsetMs("requests", 0)).toBe(0);
  });
});

describe("useStaggeredWindow", () => {
  it("adopts a new window at once with no stagger", () => {
    const { result, rerender } = renderHook(({ end }) => useStaggeredWindow("requests", end - 60, end, 0), { initialProps: { end: 100 } });
    expect(result.current).toEqual({ start: 100 - 60, end: 100 });
    rerender({ end: 110 });
    expect(result.current).toEqual({ start: 110 - 60, end: 110 });
  });

  it("keeps the old window until the offset elapses, then adopts the new one", () => {
    const id = "requests";
    const offset = staggerOffsetMs(id, 4000);
    const { result, rerender } = renderHook(({ end }) => useStaggeredWindow(id, end - 60, end, 4000), { initialProps: { end: 100 } });
    expect(result.current).toEqual({ start: 100 - 60, end: 100 });
    rerender({ end: 110 });
    expect(result.current).toEqual({ start: 100 - 60, end: 100 });
    act(() => {
      vi.advanceTimersByTime(offset + 1);
    });
    expect(result.current).toEqual({ start: 110 - 60, end: 110 });
  });

  it("cancels a superseded change, so a stale window is never adopted", () => {
    const { result, rerender } = renderHook(({ end }) => useStaggeredWindow("requests", end - 60, end, 4000), { initialProps: { end: 100 } });
    rerender({ end: 110 });
    rerender({ end: 120 });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current).toEqual({ start: 120 - 60, end: 120 });
  });

  it("adopts a new span at once even while the board's last change was a tick", () => {
    // An author changes the saved range in edit mode, or a remote sync does, without a manual refresh.
    const { result, rerender } = renderHook(
      ({ start, end }) => useStaggeredWindow("requests", start, end, 4000),
      { initialProps: { start: 40, end: 100 } },
    );
    rerender({ start: 110 - 3600, end: 110 });
    expect(result.current).toEqual({ start: 110 - 3600, end: 110 });
  });

  it("adopts an earlier window at once", () => {
    const { result, rerender } = renderHook(({ end }) => useStaggeredWindow("requests", end - 60, end, 4000), { initialProps: { end: 100 } });
    rerender({ end: 90 });
    expect(result.current).toEqual({ start: 30, end: 90 });
  });

  it("adopts at once when the stagger is switched off mid-wait", () => {
    const { result, rerender } = renderHook(
      ({ end, stagger }) => useStaggeredWindow("requests", end - 60, end, stagger),
      { initialProps: { end: 100, stagger: 4000 } },
    );
    rerender({ end: 110, stagger: 4000 });
    expect(result.current.end).toBe(100);
    rerender({ end: 110, stagger: 0 });
    expect(result.current).toEqual({ start: 110 - 60, end: 110 });
  });
});

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFETCH_MAX_WIDGETS, PREFETCH_SETTLE_MS, prefetchSupported, useIdlePrefetch } from "./idle-prefetch";
import type { QueryDiagnosticStore } from "./query-diagnostics";

/** A diagnostics store whose receipts the test sets, as the scheduler's ledger does. */
function fakeStore(initial: { state: string }[] = []) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  } as unknown as QueryDiagnosticStore;
  return {
    store,
    set(next: { state: string }[]) {
      snapshot = next;
      listeners.forEach(listener => listener());
    },
  };
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`);

function prefetched(result: { current: ReadonlySet<string> }) {
  return [...result.current];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
  Reflect.deleteProperty(document, "hidden");
});

describe("useIdlePrefetch", () => {
  it("grants nothing while a query is queued or running", () => {
    const { store, set } = fakeStore([{ state: "running" }]);
    const { result } = renderHook(() => useIdlePrefetch(ids(5), store, true));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS * 5);
    });
    expect(prefetched(result)).toEqual([]);

    act(() => set([{ state: "queued" }]));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS * 5);
    });
    expect(prefetched(result)).toEqual([]);

    act(() => set([{ state: "complete" }]));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS + 1);
    });
    expect(prefetched(result)).toEqual(["w0", "w1"]);
  });

  it("grants batches of two in reading order, one batch per quiet period", () => {
    const { store } = fakeStore();
    const { result } = renderHook(() => useIdlePrefetch(ids(5), store, true));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS + 1);
    });
    expect(prefetched(result)).toEqual(["w0", "w1"]);
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS + 1);
    });
    expect(prefetched(result)).toEqual(["w0", "w1", "w2", "w3"]);
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS + 1);
    });
    expect(prefetched(result)).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });

  it("grants nothing above the widget cap", () => {
    const { store } = fakeStore();
    const { result } = renderHook(() => useIdlePrefetch(ids(PREFETCH_MAX_WIDGETS + 1), store, true));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS * 10);
    });
    expect(prefetched(result)).toEqual([]);
  });

  it("grants nothing without diagnostics, or when disabled", () => {
    const { store } = fakeStore();
    const withoutStore = renderHook(() => useIdlePrefetch(ids(3), undefined, true));
    const disabled = renderHook(() => useIdlePrefetch(ids(3), store, false));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS * 5);
    });
    expect(prefetched(withoutStore.result)).toEqual([]);
    expect(prefetched(disabled.result)).toEqual([]);
  });

  it("grants nothing while the tab is hidden", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const { store } = fakeStore();
    const { result } = renderHook(() => useIdlePrefetch(ids(3), store, true));
    act(() => {
      vi.advanceTimersByTime(PREFETCH_SETTLE_MS * 5);
    });
    expect(prefetched(result)).toEqual([]);
  });
});

describe("prefetchSupported", () => {
  it("is off with Save-Data and above the widget cap", () => {
    expect(prefetchSupported(3, undefined)).toBe(true);
    expect(prefetchSupported(3, {})).toBe(true);
    expect(prefetchSupported(3, { saveData: true })).toBe(false);
    expect(prefetchSupported(PREFETCH_MAX_WIDGETS + 1, {})).toBe(false);
  });
});

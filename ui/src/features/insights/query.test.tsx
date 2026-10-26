import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryScheduler, useWidgetQuery } from "./query";
import type { QueryRequest, QueryResult, Widget } from "./schema";

const widget: Widget = {
  id: "latency",
  title: "API latency",
  type: "timeseries",
  providerId: "prometheus",
  query: "latency",
  unit: "ms",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};
const bounds = { start: 1000, end: 2000, step: 15 };
const data: QueryResult = {
  series: [
    { name: "api", labels: {}, points: [{ timestamp: 1000, value: 12 }] },
  ],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("widget query lifecycle", () => {
  it("restores cached saved-query results when a dashboard variable returns to a previous value", async () => {
    const provider = vi.fn(async (request: QueryRequest): Promise<QueryResult> => ({
      series: [{ name: request.query, labels: { service: request.query }, points: [{ timestamp: 1000, value: request.query === "api" ? 101.2345 : 202.3456 }] }],
    }));
    const scheduler = createQueryScheduler(provider);
    const resolveService = (service: string) => (request: QueryRequest, signal: AbortSignal) => scheduler({ ...request, query: service, queryRef: undefined }, signal);
    const linked = { ...widget, query: "", queryRef: { id: "service-rate", bindings: [{ parameter: "service", source: "variable" as const, variable: "service" }] } };
    const { result, rerender } = renderHook(
      ({ fetcher }) => useWidgetQuery(linked, { ...bounds, fetcher }),
      { initialProps: { fetcher: resolveService("api") } },
    );
    await waitFor(() => expect(result.current.data?.series?.[0].points[0].value).toBe(101.2345));
    rerender({ fetcher: resolveService("controller") });
    await waitFor(() => expect(result.current.data?.series?.[0].points[0].value).toBe(202.3456));
    rerender({ fetcher: resolveService("api") });
    await waitFor(() => expect(result.current.data?.series?.[0].points[0].value).toBe(101.2345));
    expect(result.current.loading).toBe(false);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("debounces live query typing, cancels obsolete requests and never refetches styles", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(data);
    const { result, rerender } = renderHook(
      ({ value, debounceMs }) => useWidgetQuery(value, { ...bounds, fetcher, debounceMs }),
      { initialProps: { value: widget, debounceMs: 0 } },
    );
    await act(async () => {});
    expect(result.current.data).toEqual(data);
    const initialSignal = fetcher.mock.calls[0][1] as AbortSignal;
    rerender({ value: widget, debounceMs: 350 });
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender({ value: { ...widget, query: "latency_changed" }, debounceMs: 350 });
    expect(result.current.data).toBeUndefined();
    expect(initialSignal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    rerender({ value: { ...widget, query: "latency_final" }, debounceMs: 350 });
    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0].query).toBe("latency_final");
    expect(result.current.data).toEqual(data);
    rerender({ value: { ...widget, query: "latency_final", title: "New title", options: { background: "#123456" } }, debounceMs: 350 });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("forwards saved references with empty custom drafts, refetches changed mappings and cancels obsolete linked requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(data);
    const linked: Widget = {
      ...widget,
      query: "",
      queryRef: {
        id: "shared",
        bindings: [
          { parameter: "env", source: "constant", value: "production" },
        ],
      },
    };
    const { result, rerender } = renderHook(
      ({ value }) => useWidgetQuery(value, { ...bounds, fetcher }),
      { initialProps: { value: linked } },
    );
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(fetcher.mock.calls[0][0].queryRef).toEqual(linked.queryRef);
    rerender({
      value: {
        ...linked,
        title: "Other",
        layout: { ...linked.layout, w: 12 },
        queryRef: structuredClone(linked.queryRef),
      },
    });
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const firstSignal = fetcher.mock.calls[0][1] as AbortSignal;
    rerender({
      value: {
        ...linked,
        queryRef: {
          id: "shared",
          bindings: [
            { parameter: "env", source: "constant", value: "staging" },
          ],
        },
      },
    });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(fetcher.mock.calls[1][0].queryRef.bindings[0].value).toBe("staging");
  });

  it("does not refetch on layout, title or display-type changes", async () => {
    const fetcher = vi.fn().mockResolvedValue(data);
    const { result, rerender } = renderHook(
      ({ value }) => useWidgetQuery(value, { ...bounds, fetcher }),
      { initialProps: { value: widget } },
    );
    await waitFor(() => expect(result.current.data).toEqual(data));
    rerender({
      value: {
        ...widget,
        title: "New name",
        type: "bar",
        layout: { x: 3, y: 2, w: 3, h: 4 },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      {
        ...bounds,
        providerId: "prometheus",
        query: "latency",
        kind: "metrics",
      },
      expect.any(AbortSignal),
    );
  });

  it("aborts obsolete requests and ignores an upstream that resolves after cancellation", async () => {
    let resolveFirst!: (value: QueryResult) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(data);
    const { result, rerender } = renderHook(
      ({ value }) => useWidgetQuery(value, { ...bounds, fetcher }),
      { initialProps: { value: widget } },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const firstSignal: AbortSignal = fetcher.mock.calls[0][1];
    rerender({ value: { ...widget, query: "new_query" } });
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => resolveFirst({ series: [] }));
    expect(result.current.data).toEqual(data);
  });

  it("stops work when disabled and supports an explicit retry after errors", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Query timed out"))
      .mockResolvedValue(data);
    const { result, rerender } = renderHook(
      ({ enabled }) => useWidgetQuery(widget, { ...bounds, fetcher, enabled }),
      { initialProps: { enabled: false } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.error).toBe("Query timed out"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(result.current.error).toBeNull();
  });

  it("retains known observations when scrolled away but never reuses data for a different query", async () => {
    const fetcher = vi.fn().mockResolvedValue(data);
    const { result, rerender } = renderHook(
      ({ enabled, value }) =>
        useWidgetQuery(value, { ...bounds, fetcher, enabled }),
      { initialProps: { enabled: true, value: widget } },
    );
    await waitFor(() => expect(result.current.data).toEqual(data));
    rerender({ enabled: false, value: widget });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(data);
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender({
      enabled: false,
      value: { ...widget, query: "a_different_metric" },
    });
    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("polls sequentially, pauses while hidden and cancels on unmount", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "hidden", "get")
      .mockReturnValue(false);
    const fetcher = vi.fn().mockResolvedValue(data);
    const { unmount } = renderHook(() =>
      useWidgetQuery(widget, { ...bounds, fetcher, refreshInterval: 5000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const lastSignal: AbortSignal = fetcher.mock.calls[2][1];
    unmount();
    expect(lastSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("shared query scheduler", () => {
  const request: QueryRequest = {
    ...bounds,
    providerId: "prometheus",
    query: "latency",
    kind: "metrics",
  };
  const signal = () => new AbortController().signal;

  it("shares duplicate requests while keeping subscriber cancellation independent", async () => {
    let resolve!: (value: QueryResult) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<QueryResult>((done) => {
          resolve = done;
        }),
    );
    const schedule = createQueryScheduler(fetcher);
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = schedule(request, first.signal);
    const secondResult = schedule(request, second.signal);
    const rejected = expect(firstResult).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    first.abort();
    expect((fetcher.mock.calls[0][1] as AbortSignal).aborted).toBe(false);
    resolve(data);
    await rejected;
    await expect(secondResult).resolves.toEqual(data);
  });

  it("runs at most four requests at once and starts queued work as slots release", async () => {
    const resolvers: ((value: QueryResult) => void)[] = [];
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<QueryResult>((done) => {
          resolvers.push(done);
        }),
    );
    const schedule = createQueryScheduler(fetcher);
    const jobs = Array.from({ length: 6 }, (_, index) =>
      schedule({ ...request, query: `query-${index}` }, signal()),
    );
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(4);
    resolvers[0](data);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    resolvers[1](data);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    for (const resolve of resolvers) resolve(data);
    await expect(Promise.all(jobs)).resolves.toHaveLength(6);
  });

  it("does not start cancelled queued work and cancels the upstream when its last subscriber leaves", async () => {
    let resolve!: (value: QueryResult) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<QueryResult>((done) => {
          resolve = done;
        }),
    );
    const schedule = createQueryScheduler(fetcher, { concurrency: 1 });
    const activeController = new AbortController();
    const queueController = new AbortController();
    const activeResult = schedule(request, activeController.signal);
    const queuedResult = schedule(
      { ...request, query: "queued" },
      queueController.signal,
    );
    const activeRejection = expect(activeResult).rejects.toMatchObject({
      name: "AbortError",
    });
    const queueRejection = expect(queuedResult).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    queueController.abort();
    activeController.abort();
    expect((fetcher.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    resolve(data);
    await Promise.all([activeRejection, queueRejection]);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("expires and bounds the result cache and does not cache failed requests", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetcher = vi.fn().mockResolvedValue(data);
    const schedule = createQueryScheduler(fetcher, { cacheSize: 1 });
    await schedule(request, signal());
    await schedule(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(7000);
    await schedule(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
    await schedule({ ...request, query: "another" }, signal());
    await schedule(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockRejectedValueOnce(new Error("failure"));
    await expect(
      schedule({ ...request, query: "failed" }, signal()),
    ).rejects.toThrow("failure");
    await expect(
      schedule({ ...request, query: "failed" }, signal()),
    ).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("permits immediate retries from a rejection handler before slot cleanup", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("retry"))
      .mockResolvedValue(data);
    const schedule = createQueryScheduler(fetcher, { concurrency: 1 });
    await expect(
      schedule(request, signal()).catch(() => schedule(request, signal())),
    ).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

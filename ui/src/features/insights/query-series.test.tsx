import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryScheduler, createResolvedQueryFetcher, useWidgetQuery, type QueryFetcher, type QueryRetention, type RetainedQuery } from "./query";
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
const valued = (value: number): QueryResult => ({ series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value }] }] });
const first = valued(12);
const second = valued(34);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A fetcher that, like the insights app's resolved fetcher, names its query with an identity and a revision.
const withIdentity = (identity: string, revision: QueryFetcher, run: QueryFetcher = revision): QueryFetcher =>
  Object.assign((request: QueryRequest, signal: AbortSignal) => run(request, signal), { requestIdentity: () => identity, requestRevision: revision });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function retainedSlot() {
  let retained: RetainedQuery | undefined;
  return { read: () => retained, write: (value: RetainedQuery) => { retained = value; } } satisfies QueryRetention;
}

describe("query series", () => {
  it("keeps the previous result visible while the same series reloads for a new window, marked as loading", async () => {
    const later = deferred<QueryResult>();
    const scheduler: QueryFetcher = (request) => (request.end === 2000 ? Promise.resolve(first) : later.promise);
    const fetcher = createResolvedQueryFetcher(scheduler, (request) => request);
    const { result, rerender } = renderHook(({ end }) => useWidgetQuery(widget, { ...bounds, end, fetcher }), { initialProps: { end: 2000 } });
    await waitFor(() => expect(result.current.data).toBe(first));
    rerender({ end: 2600 });
    expect(result.current.data).toBe(first);
    expect(result.current.loading).toBe(true);
    await act(async () => later.resolve(second));
    expect(result.current.data).toBe(second);
    expect(result.current.loading).toBe(false);
  });

  it("starts empty for another series, and never shows the other series' result", async () => {
    const identities = new Map([["api", first], ["worker", second]]);
    const revision: QueryFetcher = async () => first;
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => useWidgetQuery(widget, { ...bounds, fetcher: withIdentity(identity, revision, async () => identities.get(identity)!) }),
      { initialProps: { identity: "api" } },
    );
    await waitFor(() => expect(result.current.data).toBe(first));
    rerender({ identity: "worker" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe(second));
  });

  it("keeps the same series' result across a revision change, such as a provider refresh", async () => {
    const pending = deferred<QueryResult>();
    const before: QueryFetcher = async () => first;
    const after: QueryFetcher = () => pending.promise;
    const { result, rerender } = renderHook(
      ({ revision }: { revision: QueryFetcher }) => useWidgetQuery(widget, { ...bounds, fetcher: withIdentity("api", revision) }),
      { initialProps: { revision: before } },
    );
    await waitFor(() => expect(result.current.data).toBe(first));
    rerender({ revision: after });
    expect(result.current.data).toBe(first);
    expect(result.current.loading).toBe(true);
    await act(async () => pending.resolve(second));
    expect(result.current.data).toBe(second);
  });

  it("treats a resolved variable change as another series, and a window-only change as the same one", async () => {
    const scheduler: QueryFetcher = async (request) => valued(request.query === "api" ? 12 : 34);
    const { result, rerender } = renderHook(
      ({ service, end }: { service: string; end: number }) => useWidgetQuery(widget, {
        ...bounds,
        end,
        fetcher: createResolvedQueryFetcher(scheduler, (request) => ({ ...request, query: service })),
      }),
      { initialProps: { service: "api", end: 2000 } },
    );
    await waitFor(() => expect(result.current.data).toEqual(first));
    const api = result.current.data;
    rerender({ service: "api", end: 2600 });
    expect(result.current.data).toBe(api);
    rerender({ service: "worker", end: 2600 });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual(second));
  });

  it("gives a resolved query one identity whatever its window, and a different one for a different query", () => {
    const scheduler: QueryFetcher = async () => first;
    const request: QueryRequest = { ...bounds, providerId: "prometheus", query: "latency", kind: "metrics" };
    const resolved = createResolvedQueryFetcher(scheduler, (value) => value);
    expect(resolved.requestIdentity?.({ ...request, start: 1, end: 2, step: 3 })).toBe(resolved.requestIdentity?.({ ...request, start: 9, end: 99, step: 9 }));
    const other = createResolvedQueryFetcher(scheduler, (value) => ({ ...value, query: "worker" }));
    expect(resolved.requestIdentity?.(request)).not.toBe(other.requestIdentity?.(request));
  });

  it("starts a remounted widget from its retained result for the same series, and never for another", async () => {
    const stored = new Map<string, RetainedQuery>();
    const retention: QueryRetention = { read: () => stored.get("latency"), write: (value) => { stored.set("latency", value); } };
    const revision: QueryFetcher = async () => first;
    const fetcher = withIdentity("api", revision);
    const mounted = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention }));
    await waitFor(() => expect(mounted.result.current.data).toBe(first));
    mounted.unmount();

    const pending = deferred<QueryResult>();
    const remountFetcher = withIdentity("api", () => pending.promise);
    const remounted = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher: remountFetcher, retention }));
    expect(remounted.result.current.data).toBe(first);
    expect(remounted.result.current.loading).toBe(true);
    await act(async () => pending.resolve(second));
    expect(remounted.result.current.data).toBe(second);

    const otherFetcher = withIdentity("worker", () => new Promise<QueryResult>(() => {}));
    const other = renderHook(() => useWidgetQuery({ ...widget, query: "worker" }, { ...bounds, fetcher: otherFetcher, retention }));
    expect(other.result.current.data).toBeUndefined();
  });

  it("keeps a failed widget's error through an automatic refresh, and clears it on a manual retry", async () => {
    const recovering = deferred<QueryResult>();
    const failing: QueryFetcher = () => Promise.reject(new Error("Query timed out"));
    const { result, rerender } = renderHook(
      ({ end, fetcher }: { end: number; fetcher: QueryFetcher }) => useWidgetQuery(widget, { ...bounds, end, fetcher }),
      { initialProps: { end: 2000, fetcher: withIdentity("api", failing) } },
    );
    await waitFor(() => expect(result.current.error).toBe("Query timed out"));
    rerender({ end: 2600, fetcher: withIdentity("api", () => recovering.promise) });
    expect(result.current.error).toBe("Query timed out");
    expect(result.current.loading).toBe(true);
    act(() => result.current.refresh());
    expect(result.current.error).toBeNull();
    await act(async () => recovering.resolve(second));
    expect(result.current.data).toBe(second);
  });

  it("writes only the outcome of the request that is still current", async () => {
    const writes: RetainedQuery[] = [];
    const retention: QueryRetention = { read: () => undefined, write: (value) => { writes.push(value); } };
    const slow = deferred<QueryResult>();
    const revision: QueryFetcher = (request) => (request.end === 2000 ? slow.promise : Promise.resolve(second));
    const fetcher = withIdentity("api", revision);
    const { rerender } = renderHook(({ end }) => useWidgetQuery(widget, { ...bounds, end, fetcher, retention }), { initialProps: { end: 2000 } });
    rerender({ end: 2600 });
    await waitFor(() => expect(writes).toHaveLength(1));
    await act(async () => slow.resolve(first));
    expect(writes.map((write) => write.result)).toEqual([second]);
  });

  it("reuses presentation remounts past the scheduler TTL, including an initially offscreen return", async () => {
    vi.useFakeTimers();
    const provider = vi.fn().mockResolvedValue(first);
    const scheduler = createQueryScheduler(provider);
    const fetcher = () => createResolvedQueryFetcher(scheduler, request => request);
    const retention = retainedSlot();
    const before = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher: fetcher(), retention }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(before.result.current.data).toBe(first);
    before.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    const focused = renderHook(() => useWidgetQuery({ ...widget, title: "Preview", options: { lineWidth: 3 } }, { ...bounds, fetcher: fetcher(), retention }));
    expect(focused.result.current.data).toBe(first);
    expect(focused.result.current.loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(1);
    focused.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    const returned = renderHook(({ enabled }) => useWidgetQuery(widget, { ...bounds, fetcher: fetcher(), retention, enabled }), { initialProps: { enabled: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    returned.rerender({ enabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(returned.result.current.data).toBe(first);
    expect(returned.result.current.loading).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
    provider.mockResolvedValue(second);
    await act(async () => { returned.result.current.refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(returned.result.current.data).toBe(second);
  });

  it.each(["query", "provider", "kind", "reference", "start", "end", "step", "binding", "revision"] as const)("refetches a retained outcome after changing its %s", async change => {
    vi.useFakeTimers();
    const provider = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
    const scheduler = createQueryScheduler(provider);
    const retention = retainedSlot();
    const fetcher = createResolvedQueryFetcher(scheduler, request => request);
    const before = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    before.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    const value: Widget = change === "query" ? { ...widget, query: "other" }
      : change === "provider" ? { ...widget, providerId: "other" }
      : change === "kind" ? { ...widget, type: "plugin", pluginId: "record-table", dataKind: "records" }
      : change === "reference" ? { ...widget, queryRef: { id: "saved", bindings: [] } } : widget;
    const nextBounds = change === "start" ? { ...bounds, start: bounds.start + 1 }
      : change === "end" ? { ...bounds, end: bounds.end + 1 }
      : change === "step" ? { ...bounds, step: bounds.step + 1 } : bounds;
    const nextFetcher = change === "revision" ? createResolvedQueryFetcher(createQueryScheduler(provider), request => request)
      : change === "binding" ? createResolvedQueryFetcher(scheduler, request => ({ ...request, query: "resolved-other" })) : fetcher;
    const after = renderHook(() => useWidgetQuery(value, { ...nextBounds, fetcher: nextFetcher, retention }));
    expect(after.result.current.loading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(after.result.current.data).toBe(second);
  });

  it("preserves the remaining poll interval across remounts and refreshes an overdue outcome", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const provider = vi.fn().mockResolvedValue(first);
    const fetcher = createResolvedQueryFetcher(createQueryScheduler(provider), request => request);
    const retention = retainedSlot();
    const mount = () => renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention, refreshInterval: 10_000 }));
    const before = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    before.unmount();
    const after = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_999); });
    expect(provider).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(provider).toHaveBeenCalledTimes(2);
    after.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it("retries a cancelled manual refresh after remounting and ignores its late result", async () => {
    vi.useFakeTimers();
    const pending = deferred<QueryResult>();
    const provider = vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => pending.promise).mockResolvedValue(second);
    const fetcher = createResolvedQueryFetcher(createQueryScheduler(provider), request => request);
    const retention = retainedSlot();
    const before = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    await act(async () => { before.result.current.refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(retention.read()?.request).toBeUndefined();
    before.unmount();
    expect((provider.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
    const after = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention }));
    expect(after.result.current.data).toBe(first);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(after.result.current.data).toBe(second);
    await act(async () => { pending.resolve(valued(99)); });
    expect(retention.read()?.result).toBe(second);
  });

  it("retains an exact failed outcome without retrying on focus, while allowing explicit retry", async () => {
    vi.useFakeTimers();
    const provider = vi.fn().mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(second);
    const fetcher = createResolvedQueryFetcher(createQueryScheduler(provider), request => request);
    const retention = retainedSlot();
    const before = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    before.unmount();
    const after = renderHook(() => useWidgetQuery(widget, { ...bounds, fetcher, retention }));
    expect(after.result.current.error).toBe("Unavailable");
    expect(after.result.current.loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(1);
    await act(async () => { after.result.current.refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(after.result.current.data).toBe(second);
    expect(after.result.current.error).toBeNull();
  });
});

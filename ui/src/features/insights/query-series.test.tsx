import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createResolvedQueryFetcher, useWidgetQuery, type QueryFetcher, type QueryRetention, type RetainedQuery } from "./query";
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

afterEach(() => cleanup());

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
});

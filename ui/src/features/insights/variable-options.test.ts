import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardVariable, QueryResult } from "./schema";
import {
  createVariableValueCache,
  normalizeVariableValues,
  planVariableSource,
  sourceQueryStep,
  useVariableOptions,
  variableValuesFromQuery,
  type VariableValueLoaders,
  variableValueScope,
} from "./variable-options";

const range = { start: 1_000_000, end: 1_003_600 };
const cluster: DashboardVariable = {
  name: "cluster",
  source: { type: "labelValues", providerId: "prom", label: "cluster" },
};
const service: DashboardVariable = {
  name: "service",
  label: "Service",
  source: { type: "labelValues", providerId: "prom", label: "service", selector: 'up{cluster={{cluster}}}' },
};

function loadersReturning(values: string[], truncated = false): VariableValueLoaders & { metadata: ReturnType<typeof vi.fn> } {
  return {
    scope: "live",
    metadata: vi.fn(async () => ({ values, truncated })),
    query: vi.fn(async () => ({ records: { columns: [], rows: [] } })),
  } as never;
}

describe("planVariableSource", () => {
  it("waits for a missing parent without planning a request", () => {
    expect(planVariableSource(service, {}, range, "live")).toEqual({ state: "needs_variable", parent: "cluster" });
  });

  it("interpolates parent values as quoted literals and keys on them and the range bucket", () => {
    const plan = planVariableSource(service, { cluster: "omega" }, range, "live");
    expect(plan?.state).toBe("fetch");
    const other = planVariableSource(service, { cluster: "delta" }, range, "live");
    expect(plan && other && plan.state === "fetch" && other.state === "fetch" && plan.key !== other.key).toBe(true);
    const sameBucket = planVariableSource(service, { cluster: "omega" }, { start: range.start + 5, end: range.end + 5 }, "live");
    expect(sameBucket && plan && sameBucket.state === "fetch" && plan.state === "fetch" && sameBucket.key === plan.key).toBe(true);
    const nextBucket = planVariableSource(service, { cluster: "omega" }, { start: range.start + 120, end: range.end }, "live");
    expect(nextBucket && plan && nextBucket.state === "fetch" && plan.state === "fetch" && nextBucket.key === plan.key).toBe(false);
  });

  it("keeps a quote inside a value from escaping its literal", async () => {
    const loaders = loadersReturning(["x"]);
    const plan = planVariableSource(service, { cluster: 'a"} or vector(1)' }, range, "live");
    if (plan?.state !== "fetch") throw new Error("expected a fetch plan");
    await plan.run(loaders, new AbortController().signal);
    const sent = loaders.metadata.mock.calls[0][0] as { selector: string };
    expect(sent.selector).toBe('up{cluster="a\\"} or vector(1)"}');
  });

  it("has no plan for a variable without a source", () => {
    expect(planVariableSource({ name: "plain" }, {}, range, "live")).toBeUndefined();
  });
});

describe("saved-query source requests", () => {
  it("hands the query loader the variable values the plan was keyed on", async () => {
    const query = vi.fn(async () => ({ records: { columns: [{ key: "service" }], rows: [] } }));
    const source: DashboardVariable = {
      name: "service",
      source: {
        type: "savedQuery",
        field: "service",
        queryRef: { id: "services", bindings: [{ parameter: "cluster", source: "variable", variable: "cluster" }] },
      },
    };
    const plan = planVariableSource(source, { cluster: "omega" }, range, "live");
    if (plan?.state !== "fetch") throw new Error("expected a fetch plan");
    await plan.run({ scope: "live", metadata: vi.fn(), query } as never, new AbortController().signal);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ variables: { cluster: "omega" } }), expect.anything());
  });
});

describe("normalizeVariableValues", () => {
  it("dedupes, drops values above the dashboard limit and marks truncation", () => {
    expect(normalizeVariableValues(["a", "b", "a"], 100)).toEqual({ values: ["a", "b"], truncated: false });
    expect(normalizeVariableValues(["a", "b", "c"], 2)).toEqual({ values: ["a", "b"], truncated: true });
    expect(normalizeVariableValues(["ok", "x".repeat(1025)], 100)).toEqual({ values: ["ok"], truncated: true });
  });
});

describe("variableValuesFromQuery", () => {
  it("reads distinct non-empty values of a records column", () => {
    const result: QueryResult = {
      records: { columns: [{ key: "service", type: "string" }], rows: [["api"], [""], ["api"], [null], ["worker"]] },
    };
    expect(variableValuesFromQuery(result, "service")).toEqual({ values: ["api", "worker"], truncated: false });
  });

  it("reads a series label and refuses trace results", () => {
    const series: QueryResult = {
      series: [{ name: "a", labels: { region: "east" }, points: [] }, { name: "b", labels: { region: "west" }, points: [] }],
    };
    expect(variableValuesFromQuery(series, "region").values).toEqual(["east", "west"]);
    expect(() => variableValuesFromQuery({ traces: [] }, "service")).toThrow("Trace results");
  });

  it("names a missing column", () => {
    expect(() => variableValuesFromQuery({ records: { columns: [{ key: "a", type: "string" }], rows: [] } }, "b")).toThrow("“b”");
  });
});

describe("createVariableValueCache", () => {
  it("expires entries 30 seconds after they were stored and evicts the least recently used", () => {
    let now = 0;
    const cache = createVariableValueCache({ now: () => now, ttlMs: 30_000, maxEntries: 2 });
    cache.set("a", { values: ["1"], truncated: false });
    cache.set("b", { values: ["2"], truncated: false });
    expect(cache.get("a")).toBeDefined();
    cache.set("c", { values: ["3"], truncated: false });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    now = 29_999;
    expect(cache.get("a")).toBeDefined();
    now = 30_000;
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("useVariableOptions", () => {
  it("loads a source only once it is activated and then serves it from the session cache", async () => {
    const loaders = loadersReturning(["api", "worker"]);
    const cache = createVariableValueCache();
    const { result } = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders, cache }));
    expect(result.current.snapshot("cluster")?.state).toBe("idle");
    act(() => result.current.activate("cluster"));
    await waitFor(() => expect(result.current.snapshot("cluster")?.state).toBe("ready"));
    expect(result.current.snapshot("cluster")?.values).toEqual(["api", "worker"]);
    expect(loaders.metadata).toHaveBeenCalledTimes(1);

    const again = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders, cache }));
    act(() => again.result.current.activate("cluster"));
    await waitFor(() => expect(again.result.current.snapshot("cluster")?.state).toBe("ready"));
    expect(loaders.metadata).toHaveBeenCalledTimes(1);
  });

  it("refetches a dependent source when its parent changes and aborts the superseded request", async () => {
    const signals: AbortSignal[] = [];
    const loaders: VariableValueLoaders = {
      scope: "live",
      metadata: vi.fn((request: { selector?: string }, signal: AbortSignal) => {
        signals.push(signal);
        if (!request.selector) return Promise.resolve({ values: ["cluster-list"] });
        return new Promise(() => {}); // never resolves; the test changes the parent first
      }) as never,
      query: vi.fn() as never,
    };
    const { result, rerender } = renderHook(
      ({ cluster: value }: { cluster?: string }) => useVariableOptions({
        variables: [service],
        values: value === undefined ? {} : { cluster: value },
        range,
        loaders,
        cache: createVariableValueCache(),
      }),
      { initialProps: { cluster: "omega" } },
    );
    act(() => result.current.activate("service"));
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ cluster: "delta" });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(result.current.snapshot("service")?.state).toBe("loading");
  });

  it("masks a parent's stale response and asks for the parent before loading", async () => {
    const { result, rerender } = renderHook(
      ({ values }: { values: Record<string, string> }) => useVariableOptions({
        variables: [cluster, service],
        values,
        range,
        loaders: loadersReturning(["x"]),
        cache: createVariableValueCache(),
      }),
      { initialProps: { values: {} as Record<string, string> } },
    );
    expect(result.current.snapshot("service")).toEqual({ state: "needs_variable", values: [], truncated: false, parent: "cluster" });
    rerender({ values: { cluster: "omega" } });
    act(() => result.current.activate("service"));
    expect(result.current.snapshot("service")?.state).toBe("loading");
  });

  it("reports a failure and retries the request on demand", async () => {
    const metadata = vi.fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({ values: ["api"] });
    const loaders = { scope: "live", metadata, query: vi.fn() } as never;
    const { result } = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders, cache: createVariableValueCache() }));
    act(() => result.current.activate("cluster"));
    await waitFor(() => expect(result.current.snapshot("cluster")?.state).toBe("failed"));
    act(() => result.current.retry("cluster"));
    await waitFor(() => expect(result.current.snapshot("cluster")?.state).toBe("ready"));
    expect(metadata).toHaveBeenCalledTimes(2);
  });

  it("keeps another source's request running when one source's inputs change", async () => {
    const regionSignals: AbortSignal[] = [];
    const loaders: VariableValueLoaders = {
      scope: "live",
      metadata: vi.fn((request: { label: string; selector?: string }, signal: AbortSignal) => {
        if (request.label === "region") {
          regionSignals.push(signal);
          return new Promise(() => {}); // a slow source that never answers in this test
        }
        return Promise.resolve({ values: ["x"] });
      }) as never,
      query: vi.fn() as never,
    };
    const region: DashboardVariable = { name: "region", source: { type: "labelValues", providerId: "prom", label: "region" } };
    const { result, rerender } = renderHook(
      ({ cluster: value }: { cluster: string }) => useVariableOptions({
        variables: [region, cluster, service],
        values: { cluster: value },
        range,
        loaders,
        cache: createVariableValueCache(),
      }),
      { initialProps: { cluster: "omega" } },
    );
    act(() => result.current.activate("region"));
    await waitFor(() => expect(regionSignals).toHaveLength(1));
    rerender({ cluster: "delta" });
    await waitFor(() => expect(result.current.snapshot("service")?.state).toBe("ready"));
    expect(regionSignals).toHaveLength(1);
    expect(regionSignals[0].aborted).toBe(false);
    expect(result.current.snapshot("region")?.state).toBe("loading");
  });

  it("resolves every source on the bar once any source is opened, so a dependent value is marked fresh", async () => {
    const { result } = renderHook(() => useVariableOptions({
      variables: [cluster, service],
      values: { cluster: "omega" },
      range,
      loaders: loadersReturning(["api"]),
      cache: createVariableValueCache(),
    }));
    expect(result.current.snapshot("service")?.state).toBe("idle");
    act(() => result.current.activate("cluster"));
    await waitFor(() => expect(result.current.snapshot("service")?.state).toBe("ready"));
    expect(result.current.snapshot("service")?.values).toEqual(["api"]);
  });

  it("reports an invalid source plan as invalid, not as a failed request", () => {
    const broken: DashboardVariable = {
      name: "service",
      source: { type: "labelValues", providerId: "prom", label: "service", selector: 'up{cluster="{{cluster}}"}' },
    };
    const { result } = renderHook(() => useVariableOptions({
      variables: [cluster, broken],
      values: { cluster: "omega" },
      range,
      loaders: loadersReturning(["x"]),
      cache: createVariableValueCache(),
    }));
    expect(result.current.snapshot("service")?.state).toBe("invalid");
  });

  it("reports an empty source as empty rather than failed", async () => {
    const { result } = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders: loadersReturning([]), cache: createVariableValueCache() }));
    act(() => result.current.activate("cluster"));
    await waitFor(() => expect(result.current.snapshot("cluster")?.state).toBe("empty"));
  });
});

describe("sourceQueryStep", () => {
  // The server refuses a metrics query at 5000 points per series, so a 31-day source must step coarser than 60 s.
  it("keeps a 31-day metrics source under the server's point limit", () => {
    const start = 1_700_000_000;
    const end = start + 31 * 24 * 60 * 60;
    const points = Math.floor((end - start) / sourceQueryStep(start, end));
    expect(points).toBeLessThan(5000);
    expect(points).toBeGreaterThan(0);
  });

  it("keeps a one-hour source at a fine step and never below one second", () => {
    expect(sourceQueryStep(0, 3600)).toBe(10);
    expect(sourceQueryStep(0, 10)).toBe(1);
  });

  it("never steps a source finer than its provider's minimum", () => {
    expect(sourceQueryStep(0, 3600, 15)).toBe(15);
    expect(sourceQueryStep(0, 3600, 30)).toBe(30);
  });
});

describe("variable option refresh and retry", () => {
  it("keeps the previous range bucket's values, marked refreshing, while the rolled-over bucket loads", async () => {
    const later = { start: range.start + 120, end: range.end + 120 };
    let resolveLater: (value: { values: string[] }) => void = () => {};
    const metadata = vi.fn()
      .mockResolvedValueOnce({ values: ["omega"] })
      .mockReturnValueOnce(new Promise((resolve) => { resolveLater = resolve; }));
    const loaders = { scope: "live", metadata, query: vi.fn() } as never;
    const cache = createVariableValueCache();
    const { result, rerender } = renderHook(
      ({ window }: { window: typeof range }) => useVariableOptions({ variables: [cluster], values: {}, range: window, loaders, cache }),
      { initialProps: { window: range } },
    );
    act(() => result.current.activate("cluster"));
    await waitFor(() => expect(result.current.snapshot("cluster")?.state).toBe("ready"));

    rerender({ window: later });
    const during = result.current.snapshot("cluster");
    expect(during).toMatchObject({ state: "ready", values: ["omega"], refreshing: true });
    expect(metadata).toHaveBeenCalledTimes(2);

    await act(async () => resolveLater({ values: ["delta"] }));
    await waitFor(() => expect(result.current.snapshot("cluster")).toMatchObject({ state: "ready", values: ["delta"] }));
    expect(result.current.snapshot("cluster")?.refreshing).toBeUndefined();
  });

  it("re-requests a failed source when the loaders change, once they can answer", async () => {
    const failing = { scope: "live", metadata: vi.fn(), query: vi.fn(async () => { throw new Error("Loading the saved-query library…"); }) } as never;
    const working = { scope: "live", metadata: vi.fn(), query: vi.fn(async () => ({ records: { columns: [{ key: "owner" }], rows: [["alice"]] } })) } as never;
    const savedQuery: DashboardVariable = { name: "owner", source: { type: "savedQuery", queryRef: { id: "sq-1" }, field: "owner" } };
    const { result, rerender } = renderHook(
      ({ loaders }: { loaders: VariableValueLoaders }) => useVariableOptions({ variables: [savedQuery], values: {}, range, loaders, cache: createVariableValueCache() }),
      { initialProps: { loaders: failing as VariableValueLoaders } },
    );
    act(() => result.current.activate("owner"));
    await waitFor(() => expect(result.current.snapshot("owner")).toMatchObject({ state: "failed" }));
    expect(result.current.snapshot("owner")?.error).toContain("saved-query library");

    rerender({ loaders: working as VariableValueLoaders });
    await waitFor(() => expect(result.current.snapshot("owner")).toMatchObject({ state: "ready", values: ["alice"] }));
    expect((working as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
  });

  it("does not share cached values across loader scopes, so a new principal scope refetches", async () => {
    const cache = createVariableValueCache();
    const first = loadersReturning(["old-user-value"]);
    const second = { ...loadersReturning(["new-user-value"]), scope: "live:2" } as VariableValueLoaders;
    const one = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders: first, cache }));
    act(() => one.result.current.activate("cluster"));
    await waitFor(() => expect(one.result.current.snapshot("cluster")?.state).toBe("ready"));
    const two = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders: second, cache }));
    act(() => two.result.current.activate("cluster"));
    await waitFor(() => expect(two.result.current.snapshot("cluster")?.values).toEqual(["new-user-value"]));
  });

  it("scopes cached values by principal, not by token renewal", async () => {
    // Two principals never share a scope; the same principal keeps one scope however often its token renews.
    expect(variableValueScope(false, '["alice",1]')).not.toBe(variableValueScope(false, '["bob",1]'));
    expect(variableValueScope(false, '["alice",1]')).toBe(variableValueScope(false, '["alice",1]'));
    expect(variableValueScope(true, '["alice",1]')).not.toBe(variableValueScope(false, '["alice",1]'));
    const cache = createVariableValueCache();
    const alice = { ...loadersReturning(["alice-value"]), scope: variableValueScope(false, '["alice",1]') } as VariableValueLoaders;
    const bob = { ...loadersReturning(["bob-value"]), scope: variableValueScope(false, '["bob",1]') } as VariableValueLoaders;
    const one = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders: alice, cache }));
    act(() => one.result.current.activate("cluster"));
    await waitFor(() => expect(one.result.current.snapshot("cluster")?.values).toEqual(["alice-value"]));
    const two = renderHook(() => useVariableOptions({ variables: [cluster], values: {}, range, loaders: bob, cache }));
    act(() => two.result.current.activate("cluster"));
    await waitFor(() => expect(two.result.current.snapshot("cluster")?.values).toEqual(["bob-value"]));
    expect(two.result.current.snapshot("cluster")?.values).not.toContain("alice-value");
  });
});

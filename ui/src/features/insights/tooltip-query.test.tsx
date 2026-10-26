import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  TooltipQueryProvider,
  buildTooltipRequest,
  useTooltipQuery,
  type TooltipQuerySource,
} from "./tooltip-query";
import { createQueryScheduler, type QueryFetcher } from "./query";
import type { Provider, QueryResult, SavedQuery, TooltipView } from "./schema";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import type { Series } from "./chart-data";

const providers: Provider[] = [
  {
    id: "prom",
    name: "Metrics",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  { id: "tempo", name: "Traces", type: "tempo", capabilities: ["traces"] },
];
const bounds = { start: 1000, end: 2000, step: 15 };
const source: TooltipQuerySource = {
  type: "query",
  providerId: "prom",
  query: "rate(requests_total{service={{service}}}[5m])",
  bindings: [{ variable: "service", label: "service" }],
};
const series: Series = {
  name: "api",
  labels: { service: "api" },
  points: [{ timestamp: 1000, value: 1 }],
};
const data: QueryResult = {
  series: [{ ...series, points: [{ timestamp: 1000, value: 111 }] }],
};
const wrapperFor = (fetcher: QueryFetcher) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TooltipQueryProvider fetcher={fetcher} providers={providers} {...bounds}>
        {children}
      </TooltipQueryProvider>
    );
  };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("tooltip query binding", () => {
  it("inserts a label exactly once as a quoted literal, retaining quotes, slashes, newlines and template-looking text", () => {
    const value = 'checkout"blue\\west\n{{text}}';
    const request = buildTooltipRequest(
      source,
      { ...series, labels: { service: value } },
      "metrics",
      { ...bounds, providers },
    );
    expect(request).toEqual({
      ...bounds,
      providerId: "prom",
      kind: "metrics",
      query: `rate(requests_total{service=${JSON.stringify(value)}}[5m])`,
    });
    expect(
      buildTooltipRequest(
        source,
        { ...series, labels: { service: "" } },
        "metrics",
        { ...bounds, providers },
      ).query,
    ).toContain('service=""');
  });
  it("rejects missing bindings, unsafe template placement, incompatible providers and invalid ranges without issuing requests", () => {
    const request = (change = {}, selected = series, env = {}) =>
      buildTooltipRequest({ ...source, ...change }, selected, "metrics", {
        ...bounds,
        providers,
        ...env,
      });
    expect(() => request({}, { ...series, labels: {} })).toThrow(/no label/);
    expect(() => request({ query: 'metric{service="{{service}}"}' })).toThrow(
      /quoted/,
    );
    expect(() => request({ query: "metric_{{service}}" })).toThrow();
    expect(() => request({ query: "# {{service}}\nup" })).toThrow();
    expect(() => request({ query: "metric{service={{missing}}}" })).toThrow(
      /tooltip variable/,
    );
    expect(() => request({ providerId: "missing" })).toThrow(/not configured/);
    expect(() => request({ providerId: "tempo" })).toThrow(
      /does not support metrics/,
    );
    expect(() => request({}, series, { end: 999 })).toThrow(/time range/);
    expect(() => request({}, series, { end: 1000 + 32 * 86400 })).toThrow(
      /time range/,
    );
    expect(
      buildTooltipRequest(
        {
          ...source,
          providerId: "tempo",
          query: "{ resource.service.name = {{service}} }",
        },
        series,
        "traces",
        { ...bounds, providers },
      ).kind,
    ).toBe("traces");
  });
});

describe("lazy tooltip query lifecycle", () => {
  it("masks old observations and cancels when the historical point changes within one series", async () => {
    let resolveOld!: (data: QueryResult) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue(data);
    const pointSource: TooltipQuerySource = {
      ...source,
      query: "up@{{time}} > {{value}}",
      bindings: [
        { variable: "time", field: "timestamp" },
        { variable: "value", field: "value" },
      ],
    };
    const { result, rerender, unmount } = renderHook(
      ({ point }) =>
        useTooltipQuery(pointSource, series, "metrics", true, point),
      {
        initialProps: {
          point: { timestamp: 1000125, value: -7.25 as number | null },
        },
        wrapper: wrapperFor(fetcher),
      },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0].query).toBe("up@1000.125 > -7.25");
    const oldSignal = fetcher.mock.calls[0][1] as AbortSignal;
    rerender({ point: { timestamp: 1001000, value: 0 } });
    expect(result.current.data).toBeUndefined();
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(fetcher.mock.calls[1][0].query).toBe("up@1001 > 0");
    await act(async () => resolveOld({ series: [] }));
    expect(result.current.data).toEqual(data);
    rerender({ point: { timestamp: 1002000, value: null } });
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatch(/no finite value/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    unmount();
  });
  it("does not query existing series or disabled/nested views and does not refetch for unrelated observations", async () => {
    const fetcher = vi.fn().mockResolvedValue(data);
    const { result, rerender } = renderHook(
      ({ value, enabled, selected }) =>
        useTooltipQuery(value, selected, "metrics", enabled),
      {
        initialProps: {
          value: undefined as typeof source | undefined,
          enabled: true,
          selected: series,
        },
        wrapper: wrapperFor(fetcher),
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ value: source, enabled: false, selected: series });
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ value: source, enabled: true, selected: series });
    await waitFor(() => expect(result.current.data).toEqual(data));
    rerender({
      value: { ...source },
      enabled: true,
      selected: { ...series, name: "Changed title", points: [] },
    });
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("masks stale results immediately, aborts old requests, ignores late completion and aborts on close", async () => {
    let resolveOld!: (data: QueryResult) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<QueryResult>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue(data);
    const { result, rerender, unmount } = renderHook(
      ({ selected }) => useTooltipQuery(source, selected, "metrics"),
      { initialProps: { selected: series }, wrapper: wrapperFor(fetcher) },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const oldSignal = fetcher.mock.calls[0][1] as AbortSignal;
    rerender({ selected: { ...series, labels: { service: "worker" } } });
    expect(result.current.data).toBeUndefined();
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(data));
    await act(async () => resolveOld({ series: [] }));
    expect(result.current.data).toEqual(data);
    rerender({ selected: { ...series, labels: {} } });
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatch(/no label/);
    expect(result.current.canRetry).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    rerender({ selected: series });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    const signal = fetcher.mock.calls[2][1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
  it("allows retry only after a provider failure and clears the error on recovery", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValue(data);
    const { result } = renderHook(
      () => useTooltipQuery(source, series, "metrics"),
      { wrapper: wrapperFor(fetcher) },
    );
    await waitFor(() =>
      expect(result.current.error).toBe("Provider unavailable"),
    );
    expect(result.current.canRetry).toBe(true);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
  });
  it("shares host scheduler work without one closing tooltip cancelling another subscriber", async () => {
    let resolve!: (data: QueryResult) => void;
    const upstream = vi.fn().mockImplementation(
      () =>
        new Promise<QueryResult>((done) => {
          resolve = done;
        }),
    );
    const fetcher = createQueryScheduler(upstream);
    const first = renderHook(() => useTooltipQuery(source, series, "metrics"), {
      wrapper: wrapperFor(fetcher),
    });
    const second = renderHook(
      () => useTooltipQuery(source, series, "metrics"),
      { wrapper: wrapperFor(fetcher) },
    );
    await waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    first.unmount();
    expect(upstream.mock.calls[0][1].aborted).toBe(false);
    await act(async () => resolve(data));
    await waitFor(() => expect(second.result.current.data).toEqual(data));
    second.unmount();
    const cached = renderHook(
      () => useTooltipQuery(source, series, "metrics"),
      { wrapper: wrapperFor(fetcher) },
    );
    await waitFor(() => expect(cached.result.current.data).toEqual(data));
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("reports a missing host boundary without attempting a query", () => {
    const { result } = renderHook(() =>
      useTooltipQuery(source, series, "metrics"),
    );
    expect(result.current.error).toMatch(/unavailable in this view/);
    expect(result.current.canRetry).toBe(false);
  });
});

describe("saved tooltip queries", () => {
  const saved: SavedQuery = {
    schemaVersion: 1,
    id: "shared",
    name: "Shared metric",
    providerId: "prom",
    kind: "metrics",
    query: "up{service={{service}},env={{env}}} @ {{at}} > {{value}}",
    parameters: [
      { name: "service", type: "string" },
      { name: "env", type: "string" },
      { name: "at", type: "number" },
      { name: "value", type: "number" },
    ],
  };
  const ref: NonNullable<TooltipView["source"]> = {
    type: "saved",
    ref: {
      id: "shared",
      bindings: [
        { parameter: "service", source: "label", label: "service" },
        { parameter: "env", source: "variable", variable: "environment" },
        { parameter: "at", source: "field", field: "timestamp" },
        { parameter: "value", source: "field", field: "value" },
      ],
    },
  };
  it("resolves linked parameters once, including literal braces and exact negative/fractional values", () => {
    const value = 'checkout"blue\\west\n{{text}}';
    const result = buildTooltipRequest(
      ref,
      { ...series, labels: { service: value } },
      "metrics",
      { ...bounds, providers },
      { timestamp: 1234567, value: -7.25 },
      { queries: [saved], values: { environment: "production" } },
    );
    expect(result.query).toBe(
      `up{service=${JSON.stringify(value)},env="production"} @ 1234.567 > -7.25`,
    );
    expect(result).not.toHaveProperty("queryRef");
  });
  it("reacts to applied dashboard values, masks stale data on missing refs and never falls back to a draft", async () => {
    const fetcher = vi.fn().mockResolvedValue(data);
    let values = { environment: "production" };
    let queries = [saved];
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <SavedQueryLibraryProvider
        queries={queries}
        values={values}
        variables={[{ name: "environment" }]}
      >
        <TooltipQueryProvider
          fetcher={fetcher}
          providers={providers}
          {...bounds}
        >
          {children}
        </TooltipQueryProvider>
      </SavedQueryLibraryProvider>
    );
    const { result, rerender } = renderHook(
      () =>
        useTooltipQuery(ref, series, "metrics", true, {
          timestamp: 1000,
          value: 0,
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(fetcher.mock.calls[0][0].query).toContain('env="production"');
    values = { environment: "staging" };
    rerender();
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0].query).toContain('env="staging"');
    queries = [];
    rerender();
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatch(/unavailable/);
    expect(result.current.canRetry).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not request while the library is loading, the tooltip is disabled, or existing widget data is selected", async () => {
    const fetcher = vi.fn().mockResolvedValue(data);
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <SavedQueryLibraryProvider
        queries={[saved]}
        values={{}}
        variables={[]}
        loading
      >
        <TooltipQueryProvider
          fetcher={fetcher}
          providers={providers}
          {...bounds}
        >
          {children}
        </TooltipQueryProvider>
      </SavedQueryLibraryProvider>
    );
    const { result, rerender } = renderHook(
      ({ source, enabled }) =>
        useTooltipQuery(source, series, "metrics", enabled),
      {
        wrapper: Wrapper,
        initialProps: { source: ref as TooltipView["source"], enabled: true },
      },
    );
    expect(result.current.loading).toBe(true);
    rerender({ source: ref, enabled: false });
    expect(result.current.loading).toBe(false);
    rerender({ source: { type: "widget" }, enabled: true });
    await act(async () => {});
    expect(result.current.error).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

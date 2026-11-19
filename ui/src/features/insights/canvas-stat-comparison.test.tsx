import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardCanvas } from "./canvas";
import { exampleProviders } from "./example";
import { createQueryScheduler, type QueryFetcher } from "./query";
import type { Dashboard, QueryRequest, QueryResult, Widget } from "./schema";

vi.mock("react-grid-layout", async () => {
  const { useRef } = await import("react");
  const core = await import("react-grid-layout/core");
  return {
    default: ({ children }: { children: ReactNode; layout: Layout }) => <div>{children}</div>,
    useContainerWidth: () => ({ width: 1100, containerRef: useRef(null), mounted: true }),
    verticalCompactor: core.verticalCompactor,
  };
});

// A three-hour range ending at 10800 s: the earlier window is the hour before the range's own first hour.
const END = 10_800, START = 7_200, HOUR = 3_600;
const provider = exampleProviders[0].id;
const rate = (id: string, options: Widget["options"] = {}): Widget =>
  ({ id, title: id, type: "stat", providerId: provider, query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 3, h: 2 }, options } as Widget);
const dashboard = (widgets: Widget[]) => ({ schemaVersion: 1, id: "cmp", title: "Cmp", timeRange: "1h", refreshInterval: 0, widgets } as unknown as Dashboard);
const earlier = (points: Array<[number, number]>) => ({ series: [{ name: "rate", labels: {}, points: points.map(([timestamp, value]) => ({ timestamp, value })) }] });

const answer = async (request: QueryRequest, signal: AbortSignal): Promise<QueryResult> => {
  void signal;
  if (request.start === START) return { series: [{ name: "rate", labels: {}, points: [{ timestamp: END * 1000 - 60_000, value: 112 }] }] };
  // The earlier window, [start - 1 h, start): one sample near its end.
  return earlier([[(START - 60) * 1000, 100]]);
};
const fetcher = vi.fn(answer);

it("keeps the pair on screen while a new range loads, and never pairs a new range with the previous earlier window", async () => {
  // Only the first range's two windows answer. A new range's requests never settle, so nothing new can arrive.
  const held = vi.fn(async (request: QueryRequest, signal: AbortSignal): Promise<QueryResult> => {
    if (request.start === START || request.start === START - HOUR) return fetcher(request, signal);
    return new Promise<QueryResult>(() => {});
  });
  const view = (end: number) => <DashboardCanvas dashboard={dashboard([rate("compare", { compare: { window: "previous", good: "up" } })])} providers={exampleProviders} fetcher={held} end={end} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />;
  const { rerender } = render(view(END));
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  rerender(view(END + 60));
  // The query hook's request-changed update runs a microtask later. The pair shown with the old reading stays; it is not replaced
  // by a loading slot or by a change computed from the new range's bounds.
  await act(() => new Promise(resolve => setTimeout(resolve, 30)));
  expect(screen.getByText("+12%")).toBeInTheDocument();
  expect(screen.queryByText("+100%")).toBeNull();
  expect(document.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta", "up");
});

it("does not show a new range's displayed result against the previous range's earlier window", async () => {
  // The new range's displayed result arrives first; its earlier window is still the previous range's.
  const newRange = vi.fn(async (request: QueryRequest, signal: AbortSignal): Promise<QueryResult> => {
    if (request.start === START || request.start === START - HOUR) return fetcher(request, signal);
    if (request.start === START + 60) return { series: [{ name: "rate", labels: {}, points: [{ timestamp: (END + 60) * 1000 - 60_000, value: 200 }] }] };
    return new Promise<QueryResult>(() => {});
  });
  const view = (end: number) => <DashboardCanvas dashboard={dashboard([rate("compare", { compare: { window: "previous", good: "up" } })])} providers={exampleProviders} fetcher={newRange} end={end} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />;
  const { rerender } = render(view(END));
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  rerender(view(END + 60));
  await act(() => new Promise(resolve => setTimeout(resolve, 30)));
  expect(screen.queryByText("+100%")).toBeNull();
  expect(document.querySelector("[data-stat-delta-state]")).toBeNull();
});

it("never shows the previous reading's change beside a newer reading while that reading reloads", async () => {
  // Range A pairs 112 with 100 (+12%). Range B's reading (200) answers, but its earlier window never does. Range C never answers.
  const staged = vi.fn(async (request: QueryRequest, signal: AbortSignal): Promise<QueryResult> => {
    if (request.start === START || request.start === START - HOUR) return answer(request, signal);
    if (request.start === START + 60) return { series: [{ name: "rate", labels: {}, points: [{ timestamp: (END + 60) * 1000 - 60_000, value: 200 }] }] };
    return new Promise<QueryResult>(() => {});
  });
  const view = (end: number) => <DashboardCanvas dashboard={dashboard([rate("stale", { compare: { window: "previous", good: "up" } })])} providers={exampleProviders} fetcher={staged} end={end} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />;
  const { rerender } = render(view(END));
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  rerender(view(END + 60));
  await waitFor(() => expect(screen.getByText("200", { exact: false })).toBeInTheDocument());
  rerender(view(END + 120));
  await act(() => new Promise(resolve => setTimeout(resolve, 30)));
  // The reading on screen is still B's 200; A's +12% was computed from 112 and must not reappear beside it.
  expect(screen.getByText("200", { exact: false })).toBeInTheDocument();
  expect(screen.queryByText("+12%")).toBeNull();
  expect(document.querySelector("[data-stat-delta]")?.textContent ?? "").not.toContain("+12%");
});

it("asks for no earlier window while the displayed stat has no sample", async () => {
  fetcher.mockImplementation(async (request: QueryRequest) => request.start === START ? { series: [] } : earlier([[(START - 60) * 1000, 100]]));
  mount([rate("none", { compare: { window: "previous" } })]);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ start: START }), expect.anything()));
  await act(() => new Promise(resolve => setTimeout(resolve, 30)));
  expect(fetcher.mock.calls.some(([request]) => request.start === START - HOUR)).toBe(false);
});

it("marks a change from a truncated earlier response as partial", async () => {
  fetcher.mockImplementation(async (request: QueryRequest) => request.start === START
    ? { series: [{ name: "rate", labels: {}, points: [{ timestamp: END * 1000 - 60_000, value: 112 }] }] }
    : { ...earlier([[(START - 60) * 1000, 100]]), truncated: true, truncation: { reason: "partial" } } as QueryResult);
  mount([rate("partial", { compare: { window: "previous", good: "up" } })]);
  await waitFor(() => expect(document.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta-state", "partial"));
  expect(document.querySelector("[data-stat-delta]")?.textContent).toContain("partial");
});

function mount2(source: QueryFetcher, widgets: Widget[]) {
  return render(<DashboardCanvas dashboard={dashboard(widgets)} providers={exampleProviders} fetcher={source} end={END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />);
}

function mount(widgets: Widget[]) {
  return render(<DashboardCanvas dashboard={dashboard(widgets)} providers={exampleProviders} fetcher={fetcher} end={END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />);
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", undefined);
  // Reset the implementation too, so a test that replaced it cannot carry over into the next one.
  fetcher.mockReset().mockImplementation(answer);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("fetches the earlier window once the displayed result has loaded, with the lens's bounds, and shows the change", async () => {
  mount([rate("compare", { compare: { window: "previous", good: "up" } })]);
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  const earlierCalls = fetcher.mock.calls.map(([request]) => request).filter(request => request.start !== START);
  expect(earlierCalls).toEqual([expect.objectContaining({ kind: "metrics", start: START - HOUR, end: START - 0.001, step: 12 })]);
  const chip = document.querySelector("[data-stat-delta]");
  expect(chip?.textContent).toContain("vs 1 h earlier: +12%, better");
  // The earlier sample is an hour before the range, so its title names the date as well as the time.
  expect(chip?.getAttribute("title")).toMatch(/earlier sample .*1970/);
});

it("keeps the change on screen while a refresh loads, and pairs the new reading once both windows settle", async () => {
  // Every request answers after a short delay: the earlier window first, then the displayed result, as a refresh would.
  const delayed = vi.fn(async (request: QueryRequest): Promise<QueryResult> => {
    // The displayed result ends at the range end; an earlier window ends before it.
    const isEarlier = request.end < END;
    await new Promise(resolve => setTimeout(resolve, isEarlier ? 10 : 40));
    return isEarlier ? earlier([[(START - 60) * 1000, 100]]) : { series: [{ name: "rate", labels: {}, points: [{ timestamp: request.end * 1000 - 60_000, value: 112 }] }] };
  });
  const view = (end: number) => <DashboardCanvas dashboard={dashboard([rate("refresh", { compare: { window: "previous", good: "up" } })])} providers={exampleProviders} fetcher={delayed} end={end} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />;
  const { rerender } = render(view(END));
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  // The reading stays 112 across the refresh, so the chip must never show its loading slot while that reading is on screen.
  const states: Array<string | null> = [];
  const observer = new MutationObserver(() => states.push(document.querySelector("[data-stat-delta]")?.getAttribute("data-stat-delta") ?? null));
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stat-delta"] });
  rerender(view(END + 30));
  await act(() => new Promise(resolve => setTimeout(resolve, 120)));
  observer.disconnect();
  expect(states).not.toContain("loading");
  expect(screen.getByText("+12%")).toBeInTheDocument();
  expect(screen.getByText("112", { exact: false })).toBeInTheDocument();
});

it("shares one earlier request between two stats that compare the same window", async () => {
  const scheduled = createQueryScheduler(fetcher);
  mount2(scheduled, [rate("first", { compare: { window: "previous", good: "up" } }), rate("second", { compare: { window: "previous", good: "up" } })]);
  await waitFor(() => expect(document.querySelectorAll("[data-stat-delta='up']")).toHaveLength(2));
  const earlierCalls = fetcher.mock.calls.filter(([request]) => request.start !== START);
  expect(earlierCalls).toHaveLength(1);
});

it("keeps a remounted stat's earlier window without asking for it again", async () => {
  const scheduled = createQueryScheduler(fetcher);
  const first = mount2(scheduled, [rate("again", { compare: { window: "previous", good: "up" } })]);
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  first.unmount();
  mount2(scheduled, [rate("again", { compare: { window: "previous", good: "up" } })]);
  await waitFor(() => expect(screen.getByText("+12%")).toBeInTheDocument());
  expect(fetcher.mock.calls.filter(([request]) => request.start !== START)).toHaveLength(1);
});

it("does not fetch an earlier window for a stat that does not compare", async () => {
  mount([rate("plain")]);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(fetcher.mock.calls.every(([request]) => request.start === START)).toBe(true);
  expect(document.querySelector("[data-stat-delta]")).toBeNull();
});

it("names an earlier window with no sample as unavailable, never as zero", async () => {
  fetcher.mockImplementation(async (request: QueryRequest) => request.start === START
    ? { series: [{ name: "rate", labels: {}, points: [{ timestamp: END * 1000 - 60_000, value: 112 }] }] }
    : { series: [] });
  mount([rate("empty", { compare: { window: "previous" } })]);
  await waitFor(() => expect(screen.getByText("No earlier sample")).toBeInTheDocument());
  expect(document.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta", "unavailable");
});

it("runs no earlier window when the range has no room before it", async () => {
  mount([{ ...rate("early", { compare: { window: "7d" } }), layout: { x: 0, y: 0, w: 3, h: 2 } } as Widget]);
  await waitFor(() => expect(document.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta-reason", "no_previous_range"));
  expect(fetcher.mock.calls.every(([request]) => request.start === START)).toBe(true);
});

it("waits for the displayed result before it asks for the earlier window", async () => {
  let release: (result: QueryResult) => void = () => {};
  fetcher.mockImplementation((request: QueryRequest) => request.start === START
    ? new Promise<QueryResult>(resolve => { release = resolve; })
    : Promise.resolve(earlier([[(START - 60) * 1000, 100]])));
  mount([rate("slow", { compare: { window: "previous" } })]);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0][0].start).toBe(START);
  release({ series: [{ name: "rate", labels: {}, points: [{ timestamp: END * 1000 - 60_000, value: 112 }] }] });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1][0]).toMatchObject({ start: START - HOUR, step: 12 });
});

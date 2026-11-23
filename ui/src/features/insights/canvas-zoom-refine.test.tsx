import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardCanvas } from "./canvas";
import { exampleProviders } from "./example";
import chartStyles from "./charts.module.css";
import type { Dashboard, Provider, QueryRequest, QueryResult, Widget } from "./schema";

vi.mock("react-grid-layout", async () => {
  const { useRef } = await import("react");
  const core = await import("react-grid-layout/core");
  return {
    default: ({ children }: { children: ReactNode; layout: Layout }) => <div>{children}</div>,
    useContainerWidth: () => ({ width: 1100, containerRef: useRef(null), mounted: true }),
    verticalCompactor: core.verticalCompactor,
  };
});

beforeEach(() => {
  // Without an observer every tile counts as visible, so its query runs at once.
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// A one-hour range ending at 10800 s, sampled each minute.
const END = 10_800, START = 7_200;
const widget: Widget = { id: "rate", title: "Rate", type: "timeseries", providerId: exampleProviders[0].id, query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 } } as Widget;
const dashboard = { schemaVersion: 1, id: "zoom", title: "Zoom", timeRange: "1h", refreshInterval: 0, widgets: [widget] } as unknown as Dashboard;
const points = Array.from({ length: 61 }, (_, index) => ({ timestamp: (START + index * 60) * 1000, value: index }));

/** Zooms the chart to its later part through the Compare dialog, the path a reader takes. */
function zoomToLaterPart() {
  fireEvent.click(screen.getByRole("button", { name: "Compare window for Rate" }));
  fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }));
}

async function renderZoomable(provider: Provider) {
  const fetcher = vi.fn<(request: QueryRequest, signal: AbortSignal) => Promise<QueryResult>>(async () => ({ series: [{ name: "rate", labels: {}, points }] }));
  render(<DashboardCanvas dashboard={dashboard} providers={[provider]} fetcher={fetcher} end={END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />);
  await waitFor(() => expect(document.querySelector("[data-series-count]")).not.toBeNull());
  return fetcher;
}

it("does not re-query a 1 h zoom when the provider minimum already sets the dashboard's planned step", async () => {
  // A one-hour range plans 12 s raw, which the 15 s provider minimum raises to 15 s; a zoom can only plan 15 s too.
  const fetcher = await renderZoomable({ ...exampleProviders[0], minStepSeconds: 15 });
  const before = fetcher.mock.calls.length;
  zoomToLaterPart();
  await new Promise(done => setTimeout(done, 400));
  expect(fetcher.mock.calls.length).toBe(before);
});

it("does not re-query a zoom for a provider that ignores its step", async () => {
  const fetcher = await renderZoomable(exampleProviders[0]);
  const before = fetcher.mock.calls.length;
  zoomToLaterPart();
  await new Promise(done => setTimeout(done, 400));
  expect(fetcher.mock.calls.length).toBe(before);
});

// A seven-day range sampled 300 times, so the dashboard plans a 30-minute step with a 15 s provider minimum.
const WEEK_END = 1_000_000, WEEK_START = WEEK_END - 604_800;
const weekDashboard = { schemaVersion: 1, id: "week", title: "Week", timeRange: "7d", refreshInterval: 0, widgets: [widget] } as unknown as Dashboard;
const weekPoints = Array.from({ length: 300 }, (_, index) => ({ timestamp: (WEEK_START + index * 2016) * 1000, value: index }));

async function renderWeek(provider: Provider) {
  const fetcher = vi.fn<(request: QueryRequest, signal: AbortSignal) => Promise<QueryResult>>(async () => ({ series: [{ name: "rate", labels: {}, points: weekPoints }] }));
  render(<DashboardCanvas dashboard={weekDashboard} providers={[provider]} fetcher={fetcher} end={WEEK_END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />);
  await waitFor(() => expect(document.querySelector("[data-series-count]")).not.toBeNull());
  return fetcher;
}

/** Zooms the chart from the sample at index `from` to its last sample, through the Compare dialog. */
function zoomFromSample(from: number) {
  fireEvent.click(screen.getByRole("button", { name: "Compare window for Rate" }));
  fireEvent.change(screen.getByLabelText("Window start"), { target: { value: String(from) } });
  fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }));
}

it("sends no re-query when a zoom's own policy step is no finer than the dashboard's planned step", async () => {
  const fetcher = await renderWeek({ ...exampleProviders[0], minStepSeconds: 15 });
  const before = fetcher.mock.calls.length;
  // Starting at sample 86 leaves five of the seven days: 1440 s raw, which the policy rounds to 1800 s, the planned step.
  zoomFromSample(86);
  await new Promise(done => setTimeout(done, 400));
  expect(fetcher.mock.calls.length).toBe(before);
});

it("still re-queries a zoom whose own policy step is finer than the dashboard's planned step", async () => {
  const fetcher = await renderWeek({ ...exampleProviders[0], minStepSeconds: 15 });
  const before = fetcher.mock.calls.length;
  // Starting at sample 258 leaves about one day: 282 s raw, which the policy rounds to 300 s, finer than the planned 1800 s.
  zoomFromSample(258);
  await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
  expect(fetcher.mock.calls.slice(before).some(([request]) => request.step === 300)).toBe(true);
});

/** Renders the one-hour dashboard with a dashboard range handler and returns the chart's plot, sized for a drag. */
async function renderBrushable(editing: boolean, onTimeRange: (window: { start: number; end: number }) => void) {
  const fetcher = vi.fn<(request: QueryRequest, signal: AbortSignal) => Promise<QueryResult>>(async () => ({ series: [{ name: "rate", labels: {}, points }] }));
  render(<DashboardCanvas dashboard={dashboard} providers={[exampleProviders[0]]} fetcher={fetcher} end={END} editing={editing} selected="" onSelect={vi.fn()} onLayout={vi.fn()} onTimeRange={onTimeRange} />);
  await waitFor(() => expect(document.querySelector("[data-series-count]")).not.toBeNull());
  const plot = document.querySelector<HTMLElement>(`.${chartStyles.plot}`)!;
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 180));
  return plot;
}

function dragAcross(plot: HTMLElement) {
  const pointer = (clientX: number, buttons = 0) => ({ clientX, clientY: 60, button: 0, buttons, isPrimary: true, pointerId: 1, pointerType: "mouse" });
  fireEvent.pointerDown(plot, pointer(100));
  fireEvent.pointerMove(plot, pointer(300, 1));
  fireEvent.pointerUp(plot, pointer(300));
}

it("sends a chart drag to the dashboard range when the dashboard is not being edited", async () => {
  const onTimeRange = vi.fn();
  const plot = await renderBrushable(false, onTimeRange);
  dragAcross(plot);
  expect(onTimeRange).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-chart-window-start]")).toBeNull();
});

it("keeps a chart drag local while the dashboard is being edited", async () => {
  const onTimeRange = vi.fn();
  const plot = await renderBrushable(true, onTimeRange);
  dragAcross(plot);
  expect(onTimeRange).not.toHaveBeenCalled();
  expect(document.querySelector("[data-chart-window-start]")).not.toBeNull();
});

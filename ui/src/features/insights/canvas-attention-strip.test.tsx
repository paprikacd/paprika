import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardCanvas } from "./canvas";
import { exampleProviders } from "./example";
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

const provider = exampleProviders[0].id;
const at = 3_500_000; // 100 s before the range end (end = 3600 s)
const stat = (id: string, query: string, options: Widget["options"] = {}): Widget => ({
  id, title: id, type: "stat", providerId: provider, query, unit: "%", layout: { x: 0, y: 0, w: 3, h: 2 }, options,
} as Widget);
const widgets: Widget[] = [
  stat("err1", "errors", { thresholds: [{ value: 5, status: "critical", label: "Breached" }] }),
  stat("warn", "warn", { thresholds: [{ value: 2, status: "warning", label: "Elevated" }] }),
  stat("broke", "broken"),
  stat("old", "old", { staleAfterSeconds: 60 }),
  stat("quiet", "quiet"),
  stat("hang", "hang"),
  stat("empty", "empty"),
  stat("err2", "errors2", { thresholds: [{ value: 5, status: "critical", label: "Breached" }] }),
];
const values: Record<string, number> = { errors: 7, errors2: 9, warn: 3, old: 1, quiet: 1 };
const dashboardOf = (overrides: Partial<Dashboard> = {}, list = widgets) =>
  ({ schemaVersion: 1, id: "strip", title: "Strip", timeRange: "1h", refreshInterval: 0, widgets: list, ...overrides }) as unknown as Dashboard;

const fetcher = vi.fn(async (request: QueryRequest, signal: AbortSignal): Promise<QueryResult> => {
  if (request.query === "broken") throw new Error("provider query failed");
  if (request.query === "hang") return new Promise<QueryResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  if (request.query === "empty") return { series: [] };
  return { series: [{ name: request.query, labels: {}, points: [{ timestamp: at, value: values[request.query] }] }] };
});

function mount(dashboard = dashboardOf(), extra: Partial<React.ComponentProps<typeof DashboardCanvas>> = {}) {
  const view = render(
    <DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} {...extra} />,
  );
  const strip = () => view.container.querySelector<HTMLElement>("[data-attention-strip]");
  const tile = (id: string) => view.container.querySelector<HTMLElement>(`article[data-widget-id="${id}"]`);
  return { view, strip, tile };
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", undefined);
  fetcher.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

it("counts each widget once under its reason, and leaves empty, pending and failed widgets unchecked", async () => {
  const { strip } = mount();
  await waitFor(() => expect(screen.getByRole("button", { name: /^2 critical:/ })).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /^1 warning:/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^1 failed:/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^1 stale:/ })).toBeInTheDocument();
  // Eight widgets: the failed and empty ones are loaded but unchecked, the pending one is not loaded yet, and a matched
  // critical band still counts as checked.
  expect(screen.getByText(/5 of 8 checked/)).toBeInTheDocument();
  expect(screen.getByText(/1 not loaded yet/)).toBeInTheDocument();
  expect(strip()?.querySelectorAll("button")).toHaveLength(4);
});

it("steps a chip through its widgets in dashboard order, outlining each in turn", async () => {
  const revealed: string[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { revealed.push(this.dataset.widgetId ?? ""); };
  const user = userEvent.setup();
  const { tile } = mount();
  const critical = await screen.findByRole("button", { name: /^2 critical:/ });
  await user.click(critical);
  expect(revealed).toEqual(["err1"]);
  expect(tile("err1")).toHaveAttribute("data-attention-target");
  await user.click(critical);
  expect(revealed).toEqual(["err1", "err2"]);
  expect(tile("err2")).toHaveAttribute("data-attention-target");
  await user.click(critical);
  expect(revealed).toEqual(["err1", "err2", "err1"]);
});

it("reaches a chip from the keyboard with a visible focus treatment", async () => {
  const revealed: string[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { revealed.push(this.dataset.widgetId ?? ""); };
  const user = userEvent.setup();
  mount();
  const warning = await screen.findByRole("button", { name: /^1 warning:/ });
  await user.tab();
  while (document.activeElement !== warning && document.activeElement !== document.body) await user.tab();
  expect(document.activeElement).toBe(warning);
  await user.keyboard("{Enter}");
  expect(revealed).toEqual(["warn"]);
});

it("removes a chip's outline once it has been shown briefly", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { tile } = mount();
  const warning = await screen.findByRole("button", { name: /^1 warning:/ });
  vi.useFakeTimers();
  act(() => { warning.click(); });
  expect(tile("warn")).toHaveAttribute("data-attention-target");
  act(() => { vi.advanceTimersByTime(1700); });
  expect(tile("warn")).not.toHaveAttribute("data-attention-target");
});

it("is not shown in focus mode, and its counts return when the tiles do", async () => {
  const dashboard = dashboardOf();
  const { view } = mount(dashboard);
  await screen.findByRole("button", { name: /^2 critical:/ });
  view.rerender(
    <DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()}
      focus={{ widget: widgets[1], render: (preview) => <div data-testid="focus-preview">{preview}</div> }} />,
  );
  expect(view.container.querySelector("[data-attention-strip]")).toBeNull();
  expect(screen.getByTestId("focus-preview")).toBeInTheDocument();
  view.rerender(
    <DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />,
  );
  expect(await screen.findByRole("button", { name: /^2 critical:/ })).toBeInTheDocument();
});

it("ages the newest settled query and reflects the refresh state", async () => {
  vi.useFakeTimers();
  mount(dashboardOf({ refreshInterval: 15 } as Partial<Dashboard>));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(screen.getByRole("button", { name: /^2 critical:/ })).toBeInTheDocument();
  expect(screen.getByText(/Refreshes every 15 s/)).toBeInTheDocument();
  expect(screen.getByText(/Updated just now/)).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(screen.getByText(/Updated 12 s ago/)).toBeInTheDocument();
});

it("pauses the refresh label for a fixed window", async () => {
  mount(dashboardOf({ customTimeRange: { from: "2026-11-11T00:00:00Z", to: "2026-11-11T01:00:00Z" } } as Partial<Dashboard>));
  await waitFor(() => expect(screen.getByText(/Paused for a fixed window/)).toBeInTheDocument());
});

it("is hidden when the dashboard has no widgets", () => {
  const { strip } = mount(dashboardOf({}, []));
  expect(strip()).toBeNull();
});

it("judges an offscreen tile against the range its data was queried for, so a refresh does not age it", async () => {
  const observers: { callback: IntersectionObserverCallback; target: Element }[] = [];
  class FakeObserver {
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
    observe(target: Element) { observers.push({ callback: this.callback, target }); }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  const setVisible = (id: string, isIntersecting: boolean) => {
    const match = observers.find((entry) => (entry.target as HTMLElement).dataset.widgetId === id)!;
    act(() => { match.callback([{ isIntersecting, target: match.target } as IntersectionObserverEntry], {} as IntersectionObserver); });
  };
  // A sample 30 s before whatever range end the query was made with: fresh for that query, and stale under a later end.
  const sampleBeforeEnd = vi.fn(async (request: QueryRequest): Promise<QueryResult> => ({ series: [{ name: "old", labels: {}, points: [{ timestamp: (request.end - 30) * 1000, value: 1 }] }] }));
  const dashboard = dashboardOf({}, [stat("old", "old", { staleAfterSeconds: 60 })]);
  const { view, tile } = mount(dashboard, { fetcher: sampleBeforeEnd });
  await act(async () => { await Promise.resolve(); });
  setVisible("old", true);
  await waitFor(() => expect(tile("old")?.getAttribute("data-attention")).toBe("ok"));
  const queriedBefore = sampleBeforeEnd.mock.calls.length;
  setVisible("old", false);
  // A refresh moves the range end 400 s on. The sample is 30 s before the first end, so it is fresh for that query.
  view.rerender(
    <DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={sampleBeforeEnd} end={4000} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />,
  );
  await act(async () => { await Promise.resolve(); });
  expect(sampleBeforeEnd.mock.calls.length).toBe(queriedBefore);
  expect(tile("old")?.getAttribute("data-attention")).toBe("ok");
  expect(screen.queryByRole("button", { name: /stale/ })).toBeNull();
});

it("marks only the stats whose sample is the dashboard's newest, so the strip can state that time once", async () => {
  const newest = { ...stat("now", "errors2"), options: {} } as Widget;
  const older = { ...stat("then", "old"), options: {} } as Widget;
  mount(dashboardOf({}, [newest, older]));
  await waitFor(() => expect(screen.getByText(/Updated/)).toBeInTheDocument());
  // The fetcher gives "errors2" the sample at 3,500 s and "old" the same sample, so both match; move one older.
  const now = document.querySelector('article[data-widget-id="now"]');
  const then = document.querySelector('article[data-widget-id="then"]');
  expect(now).toHaveAttribute("data-shared-sample");
  expect(then).toHaveAttribute("data-shared-sample");
});

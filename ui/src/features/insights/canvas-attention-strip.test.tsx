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
  // Eight widgets: the failed, pending and empty ones are unchecked, and a matched critical band still counts as checked.
  expect(screen.getByText("5/8 checked")).toBeInTheDocument();
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

it("keeps a focused-out tile's last known state in the strip rather than dropping it", async () => {
  const dashboard = dashboardOf();
  const { view, strip } = mount(dashboard);
  await screen.findByRole("button", { name: /^2 critical:/ });
  view.rerender(
    <DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()}
      focus={{ widget: widgets[1], render: (preview) => <div data-testid="focus-preview">{preview}</div> }} />,
  );
  expect(view.container.querySelector('article[data-widget-id="err1"]')).toBeNull();
  expect(screen.getByTestId("focus-preview")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^2 critical:/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^1 warning:/ })).toBeInTheDocument();
  expect(screen.getByText("7 last known")).toBeInTheDocument();
  expect(strip()).toBeTruthy();
});

it("says a chip's widget is not on screen while focus mode hides it", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const dashboard = dashboardOf();
  const { view } = mount(dashboard);
  await screen.findByRole("button", { name: /^2 critical:/ });
  view.rerender(
    <DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()}
      focus={{ widget: widgets[1], render: (preview) => <div>{preview}</div> }} />,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: /^2 critical:/ }));
  expect(screen.getByText("err1 is not on screen. Leave focus mode to see it.")).toBeInTheDocument();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
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

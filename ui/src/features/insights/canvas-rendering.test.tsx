import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { DashboardCanvas } from "./canvas";
import { exampleDashboard, exampleProviders } from "./example";
import type { QueryResult, Widget } from "./schema";

const probe = vi.hoisted(() => ({ render: vi.fn(), layout: [] as Layout }));
vi.mock("./charts", () => ({
  WidgetVisualization: (props: { widget: Widget; result?: QueryResult }) => {
    probe.render(props);
    return <output data-testid="reading">{props.result?.series?.[0].points[0].value}</output>;
  },
}));
vi.mock("react-grid-layout", async () => {
  const { useRef } = await import("react");
  const core = await import("react-grid-layout/core");
  return {
    default: ({ children, layout }: { children: ReactNode; layout: Layout }) => { probe.layout = layout; return <div>{children}<span className="react-resizable-handle" data-testid="resize" /></div>; },
    useContainerWidth: () => ({ width: 1100, containerRef: useRef(null), mounted: true }),
    verticalCompactor: core.verticalCompactor,
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); probe.render.mockClear(); });

it("keeps the focused query engaged when its chart is offscreen, without querying other tiles", async () => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  const widget = exampleDashboard.widgets[0];
  const fetcher = vi.fn(async () => ({ series: [{ name: "primary", labels: {}, points: [{ timestamp: 3500000, value: 42 }] }] }));
  const props = { dashboard: exampleDashboard, providers: exampleProviders, fetcher, end: 3600, editing: true, selected: widget.id, onSelect: vi.fn(), onLayout: vi.fn() };
  const view = render(<DashboardCanvas {...props} />);
  expect(fetcher).not.toHaveBeenCalled();
  const focus = { widget, render: (preview: ReactNode) => <section>{preview}</section> };
  view.rerender(<DashboardCanvas {...props} focus={focus} />);
  await waitFor(() => expect(screen.getByTestId("reading")).toHaveTextContent("42"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  view.rerender(<DashboardCanvas {...props} focus={{ ...focus, widget: { ...widget, query: "updated_query" } }} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher).toHaveBeenLastCalledWith(expect.objectContaining({ query: "updated_query" }), expect.any(AbortSignal));
  view.rerender(<DashboardCanvas {...props} active={false} focus={{ ...focus, widget: { ...widget, query: "paused_query" } }} />);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("moves loaded charts without rebuilding them, while size, style, data and callback changes remain live", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  let dashboard = { ...exampleDashboard, widgets: [{ ...exampleDashboard.widgets[0], layout: { x: 0, y: 0, w: 6, h: 4 } }] };
  let value = 42;
  const fetcher = vi.fn(async () => ({ series: [{ name: "primary", labels: {}, points: [{ timestamp: 3500000, value }] }] }));
  const props = { providers: exampleProviders, fetcher, end: 3600, editing: true, onSelect: vi.fn(), onLayout: vi.fn() };
  const view = render(<DashboardCanvas {...props} dashboard={dashboard} />);
  await waitFor(() => expect(screen.getByTestId("reading")).toHaveTextContent("42"));
  const count = probe.render.mock.calls.length;
  dashboard = { ...dashboard, widgets: dashboard.widgets.map(widget => ({ ...widget, layout: { ...widget.layout, x: 6, y: 4 } })) };
  view.rerender(<DashboardCanvas {...props} dashboard={dashboard} />);
  expect(probe.layout[0]).toMatchObject({ x: 6, y: 4 });
  expect(probe.render).toHaveBeenCalledTimes(count);
  expect(fetcher).toHaveBeenCalledTimes(1);

  dashboard = { ...dashboard, widgets: dashboard.widgets.map(widget => ({ ...widget, color: "#2867b9", layout: { ...widget.layout, h: 5 } })) };
  view.rerender(<DashboardCanvas {...props} dashboard={dashboard} />);
  expect(probe.render.mock.calls.at(-1)?.[0].widget).toMatchObject({ color: "#2867b9", layout: { h: 5 } });
  expect(probe.render.mock.calls.length).toBeGreaterThan(count);
  const selected = vi.fn();
  value = 73;
  view.rerender(<DashboardCanvas {...props} end={3700} onSelect={selected} dashboard={dashboard} />);
  await waitFor(() => expect(screen.getByTestId("reading")).toHaveTextContent("73"));
  fireEvent.click(screen.getByRole("button", { name: `Edit ${dashboard.widgets[0].title}` }));
  expect(selected).toHaveBeenCalledWith(dashboard.widgets[0].id);
  expect(props.onSelect).not.toHaveBeenCalled();
});

it("suppresses native selection only on edit handles and clears a gesture when editing ends", () => {
  const dashboard = { ...exampleDashboard, widgets: [exampleDashboard.widgets[0]] };
  const props = { dashboard, providers: exampleProviders, fetcher: vi.fn(), end: 3600, onSelect: vi.fn(), onLayout: vi.fn(), active: false };
  const view = render(<DashboardCanvas {...props} editing />);
  expect(fireEvent.mouseDown(document.querySelector(".insights-drag-handle")!, { button: 0 })).toBe(false);
  expect(fireEvent.mouseDown(screen.getByTestId("resize"), { button: 0 })).toBe(false);
  expect(fireEvent.mouseDown(screen.getByRole("heading", { name: dashboard.widgets[0].title }), { button: 0 })).toBe(true);
  const canvas = screen.getByTestId("dashboard-canvas");
  canvas.setAttribute("data-layout-interacting", "true");
  canvas.setAttribute("data-layout-resizing", "true");
  view.rerender(<DashboardCanvas {...props} editing={false} />);
  expect(canvas).not.toHaveAttribute("data-layout-interacting");
  expect(canvas).not.toHaveAttribute("data-layout-resizing");
});

it("keeps chart DOM and focus in place during editing, then restores visual reading order for viewing", () => {
  const first = { ...exampleDashboard.widgets[0], id: "first", title: "First", layout: { x: 0, y: 0, w: 12, h: 4 } };
  const second = { ...first, id: "second", title: "Second", layout: { ...first.layout, y: 4 } };
  const dashboard = { ...exampleDashboard, widgets: [second, first] };
  const props = { providers: exampleProviders, fetcher: vi.fn(), end: 3600, onSelect: vi.fn(), onLayout: vi.fn(), active: false };
  const view = render(<DashboardCanvas {...props} dashboard={dashboard} editing />);
  const order = () => screen.getAllByRole("article").map(node => node.getAttribute("aria-label"));
  expect(order()).toEqual(["First", "Second"]);
  const focused = screen.getByRole("article", { name: "First" }); focused.focus();
  const moved = { ...dashboard, widgets: [{ ...second, layout: { ...second.layout, y: 0 } }, { ...first, layout: { ...first.layout, y: 4 } }] };
  view.rerender(<DashboardCanvas {...props} dashboard={moved} editing />);
  expect(order()).toEqual(["First", "Second"]);
  expect(document.activeElement).toBe(focused);
  view.rerender(<DashboardCanvas {...props} dashboard={moved} editing={false} />);
  expect(order()).toEqual(["Second", "First"]);
});

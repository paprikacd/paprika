import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Dashboard, QueryResult, Widget } from "./schema";
import type { DrilldownContext } from "./drilldown";
import { DashboardCanvas } from "./canvas";

const query = vi.hoisted(() => ({ data: {} as QueryResult }));
vi.mock("./query", () => ({
  useWidgetQuery: () => ({ data: query.data, loading: false, error: null }),
}));
vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));

const bindings = [{ variable: "service", source: "label" as const, value: "service" }];
const timeseries: Widget = {
  id: "latency",
  title: "Latency",
  type: "timeseries",
  providerId: "prom",
  query: "latency",
  unit: "ms",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  selectionBindings: bindings,
};
type SeriesRow = NonNullable<QueryResult["series"]>[number];
const point = (value: number) => [{ timestamp: 1000, value }];
const api: SeriesRow = { name: "api", labels: { service: "api" }, points: point(7) };
const worker: SeriesRow = { name: "worker", labels: { service: "worker" }, points: point(12) };
const unlabelled: SeriesRow = { name: "batch", labels: {}, points: point(3) };

function Canvas({ current, onSelection, variables }: { current: Widget; onSelection: (widget: Widget, context: DrilldownContext) => void; variables?: Record<string, string> }) {
  const dashboard: Dashboard = {
    schemaVersion: 1,
    id: "overview",
    title: "Overview",
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [current],
    variables: [{ name: "service" }],
  };
  return (
    <DashboardCanvas
      dashboard={dashboard}
      active
      referenceCompact={false}
      providers={[{ id: "prom", name: "Prometheus", type: "prometheus", capabilities: ["metrics"] }]}
      fetcher={vi.fn()}
      end={3600}
      editing={false}
      onSelect={vi.fn()}
      onLayout={vi.fn()}
      onDrilldown={vi.fn()}
      onSelection={onSelection}
      variables={variables}
    />
  );
}

const legend = () => screen.getByRole("list", { name: "Latest values by series" });
const entry = (name: string) => within(legend()).getByText(name).closest("button")!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("timeseries legend entries filter the dashboard only on deliberate activation", () => {
  const setup = (widget: Widget = timeseries, series = [api, worker]) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series };
    const selected = vi.fn();
    render(<Canvas current={widget} onSelection={selected} />);
    return selected;
  };

  it("renders the legend as buttons only when the widget has selection bindings", () => {
    setup();
    expect(within(legend()).getAllByRole("button")).toHaveLength(2);
  });

  it("keeps a legend without selection bindings a static list", () => {
    setup({ ...timeseries, selectionBindings: undefined });
    expect(within(legend()).queryAllByRole("button")).toHaveLength(0);
    expect(legend().querySelector("[tabindex]")).toBeNull();
  });

  it("puts one legend entry in the tab order", () => {
    setup();
    const stops = within(legend()).getAllByRole("button").filter(button => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it("arrow keys move focus between entries without selecting", () => {
    const selected = setup();
    act(() => entry("api").focus());
    fireEvent.keyDown(entry("api"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(entry("worker"));
    expect(entry("worker")).toHaveAttribute("tabindex", "0");
    expect(entry("api")).toHaveAttribute("tabindex", "-1");
    expect(selected).not.toHaveBeenCalled();
  });

  it("focus alone never selects", () => {
    const selected = setup();
    act(() => entry("worker").focus());
    expect(selected).not.toHaveBeenCalled();
  });

  it("Enter on an entry selects that series with its labels", async () => {
    const selected = setup();
    const user = userEvent.setup();
    act(() => entry("worker").focus());
    await user.keyboard("{Enter}");
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(timeseries, expect.objectContaining({ series: "worker", labels: { service: "worker" } }));
  });

  it("a click selects the series once", () => {
    const selected = setup();
    fireEvent.click(entry("api"));
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(timeseries, expect.objectContaining({ series: "api", labels: { service: "api" } }));
  });

  it("an entry whose series lacks the bound label is disabled with the reason and does not select", () => {
    const selected = setup(timeseries, [api, unlabelled]);
    const batch = entry("batch");
    expect(batch).toHaveAttribute("aria-disabled", "true");
    expect(batch).toHaveAccessibleDescription("Selected signal has no label “service”");
    fireEvent.click(batch);
    expect(selected).not.toHaveBeenCalled();
  });
});

describe("the pinned tooltip filters the dashboard only through its action", () => {
  const setup = (widget: Widget = timeseries) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [api, worker] };
    const selected = vi.fn();
    render(<Canvas current={widget} onSelection={selected} />);
    return selected;
  };
  // Enter on the focused chart pins its nearest observation, as a plot click does.
  const pin = () => {
    const chart = screen.getByRole("img", { name: "Latency" });
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "Enter" });
  };
  const filterAction = () => screen.getByRole("button", { name: /^Filter dashboard by / });

  it("pinning a plot point shows the action but does not select", () => {
    const selected = setup();
    pin();
    expect(filterAction()).toBeEnabled();
    expect(selected).not.toHaveBeenCalled();
  });

  it("the action selects the pinned series with its labels and no timestamp", () => {
    const selected = setup();
    pin();
    const action = filterAction();
    const name = action.textContent!.replace("Filter dashboard by ", "");
    fireEvent.click(action);
    expect(selected).toHaveBeenCalledOnce();
    const [, context] = selected.mock.calls[0];
    expect(context.series).toBe(name);
    expect(context.labels).toEqual({ service: name });
    expect(context).not.toHaveProperty("timestamp");
  });

  it("the action is disabled with the reason when the pinned series lacks the bound label", () => {
    const selected = setup({ ...timeseries, selectionBindings: [{ variable: "region", source: "label", value: "region" }] });
    pin();
    const action = filterAction();
    expect(action).toBeDisabled();
    expect(action.parentElement).toHaveTextContent("Selected signal has no label “region”");
    fireEvent.click(action);
    expect(selected).not.toHaveBeenCalled();
  });
});

describe("the pinned tooltip action for the applied series", () => {
  it("states the filter is applied and does not select again", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [api] };
    const selected = vi.fn();
    render(<Canvas current={timeseries} onSelection={selected} variables={{ service: "api" }} />);
    const chart = screen.getByRole("img", { name: "Latency" });
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(screen.queryByRole("button", { name: /^Filter dashboard by / })).toBeNull();
    const applied = screen.getByRole("button", { name: "Filtered by api" });
    expect(applied).toBeDisabled();
    expect(applied).toHaveAttribute("aria-current", "true");
    expect(applied).toHaveAttribute("data-filter-active");
    fireEvent.click(applied);
    expect(selected).not.toHaveBeenCalled();
  });
});

describe("the timeseries legend entry whose selection the variables hold is the applied filter", () => {
  it("marks only that entry", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [api, worker] };
    render(<Canvas current={timeseries} onSelection={vi.fn()} variables={{ service: "worker" }} />);
    expect(entry("worker")).toHaveAttribute("data-filter-active");
    expect(entry("worker")).toHaveAttribute("aria-current", "true");
    expect(entry("api")).not.toHaveAttribute("data-filter-active");
  });

  it("marks nothing when the variables do not hold a selection", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [api, worker] };
    render(<Canvas current={timeseries} onSelection={vi.fn()} variables={{ service: "other" }} />);
    expect(entry("worker")).not.toHaveAttribute("data-filter-active");
    expect(entry("api")).not.toHaveAttribute("data-filter-active");
  });
});


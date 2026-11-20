import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const bar: Widget = {
  id: "traffic",
  title: "Traffic",
  type: "bar",
  providerId: "prom",
  query: "traffic",
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

const legend = () => screen.getByRole("list", { name: "Latest values by category" });
const entry = (name: string) => within(legend()).getByText(name).closest("button")!;
const chart = () => screen.getByRole("img", { name: "Traffic" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bar legend entries and bars filter the dashboard only on deliberate activation", () => {
  const setup = (widget: Widget = bar, series = [api, worker]) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series };
    const selected = vi.fn();
    render(<Canvas current={widget} onSelection={selected} />);
    return selected;
  };

  it("renders the legend as buttons only when the widget has selection bindings", () => {
    setup();
    expect(within(legend()).getAllByRole("button")).toHaveLength(2);
    cleanup();
    setup({ ...bar, selectionBindings: undefined });
    expect(within(legend()).queryAllByRole("button")).toHaveLength(0);
  });

  it("arrow keys move focus between legend entries without selecting", () => {
    const selected = setup();
    act(() => entry("api").focus());
    fireEvent.keyDown(entry("api"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(entry("worker"));
    expect(entry("worker")).toHaveAttribute("tabindex", "0");
    expect(selected).not.toHaveBeenCalled();
  });

  it("Enter on a legend entry selects its series with its labels", async () => {
    const selected = setup();
    const user = userEvent.setup();
    act(() => entry("worker").focus());
    await user.keyboard("{Enter}");
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(bar, expect.objectContaining({ series: "worker", labels: { service: "worker" } }));
  });

  it("a legend click selects once", () => {
    const selected = setup();
    fireEvent.click(entry("api"));
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(bar, expect.objectContaining({ series: "api" }));
  });

  it("a legend entry whose series lacks the bound label is disabled with the reason", () => {
    const selected = setup(bar, [api, unlabelled]);
    expect(entry("batch")).toHaveAttribute("aria-disabled", "true");
    expect(entry("batch")).toHaveAccessibleDescription("Selected signal has no label “service”");
    fireEvent.click(entry("batch"));
    expect(selected).not.toHaveBeenCalled();
  });

  it("focusing a bar with the arrow keys only previews it", () => {
    const selected = setup();
    act(() => chart().focus());
    fireEvent.keyDown(chart(), { key: "ArrowRight" });
    expect(selected).not.toHaveBeenCalled();
  });

  it("Enter on a bar selects and pins it", () => {
    const selected = setup();
    act(() => chart().focus());
    fireEvent.keyDown(chart(), { key: "Enter" });
    expect(selected).toHaveBeenCalledOnce();
    expect(selected.mock.calls[0][1]).toEqual(expect.objectContaining({ series: expect.stringMatching(/^(api|worker)$/) }));
  });
});

describe("the bar legend entry whose selection the variables hold is the applied filter", () => {
  it("marks only that entry", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [api, worker] };
    render(<Canvas current={bar} onSelection={vi.fn()} variables={{ service: "api" }} />);
    const legend = screen.getByRole("list", { name: "Latest values by category" });
    const entryButton = (name: string) => within(legend).getByText(name).closest("button")!;
    expect(entryButton("api")).toHaveAttribute("data-filter-active");
    expect(entryButton("api")).toHaveAttribute("aria-current", "true");
    expect(entryButton("worker")).not.toHaveAttribute("data-filter-active");
  });
});


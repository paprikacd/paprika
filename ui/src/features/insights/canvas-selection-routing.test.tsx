import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Dashboard, QueryResult, Widget } from "./schema";
import type { DrilldownContext } from "./drilldown";
import { DashboardCanvas } from "./canvas";

// The gate and the built-in renderer are replaced so the canvas wiring can be observed without
// depending on which types are selectable today.
const gate = vi.hoisted(() => ({ selectable: true }));
const query = vi.hoisted(() => ({ data: {} as QueryResult }));
vi.mock("./selection-support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./selection-support")>()),
  supportsDashboardSelection: () => gate.selectable,
}));
vi.mock("./chart-renderers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chart-renderers")>()),
  BuiltinWidgetRenderer: (props: {
    onContextChange?: (context: DrilldownContext) => void;
    onActivate?: (context: DrilldownContext) => void;
  }) => (
    <div>
      <span data-testid="activate-wired">{String(!!props.onActivate)}</span>
      <button type="button" onClick={() => props.onContextChange?.(context)}>focus context</button>
      <button type="button" onClick={() => props.onActivate?.(context)}>activate mark</button>
    </div>
  ),
}));
vi.mock("./query", () => ({
  useWidgetQuery: () => ({ data: query.data, loading: false, error: null }),
}));
vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));

const context: DrilldownContext = { series: "api", labels: { service: "api" }, value: 7 };
const table: Widget = {
  id: "requests",
  title: "Requests",
  type: "table",
  providerId: "prom",
  query: "requests",
  unit: "req/s",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  selectionBindings: [{ variable: "service", source: "label", value: "service" }],
};

function Canvas({ onSelection }: { onSelection: (widget: Widget, context: DrilldownContext) => void }) {
  const dashboard: Dashboard = {
    schemaVersion: 1,
    id: "overview",
    title: "Overview",
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [table],
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
    />
  );
}

afterEach(() => {
  gate.selectable = true;
  vi.unstubAllGlobals();
});

describe("canvas routing of dashboard selection", () => {
  it("routes a deliberate activation of a built-in mark to the dashboard selection", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 1000, value: 7 }] }] };
    const selected = vi.fn();
    render(<Canvas onSelection={selected} />);
    expect(screen.getByTestId("activate-wired")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "activate mark" }));
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(table, context);
  });

  it("keeps a focus or hover context local and does not change the dashboard", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 1000, value: 7 }] }] };
    const selected = vi.fn();
    render(<Canvas onSelection={selected} />);
    fireEvent.click(screen.getByRole("button", { name: "focus context" }));
    expect(selected).not.toHaveBeenCalled();
  });

  it("does not wire activation when the mark has no selection capability", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    gate.selectable = false;
    query.data = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 1000, value: 7 }] }] };
    const selected = vi.fn();
    render(<Canvas onSelection={selected} />);
    expect(screen.getByTestId("activate-wired")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "activate mark" }));
    expect(selected).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Dashboard, QueryResult, Widget } from "./schema";
import type { DrilldownContext } from "./drilldown";
import { DashboardCanvas } from "./canvas";
import { TraceFetcherProvider } from "./trace-waterfall";

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
const table: Widget = {
  id: "requests",
  title: "Requests",
  type: "table",
  providerId: "prom",
  query: "requests",
  unit: "req/s",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  selectionBindings: bindings,
};
const traces: Widget = { ...table, id: "slow", title: "Slow traces", type: "traces" };
const series = (name: string, value: number) => ({
  name,
  labels: { service: name },
  points: [{ timestamp: 1000, value }],
});
const traceId = "0123456789abcdef0123456789abcdef";
const trace = {
  traceId,
  service: "api",
  operation: "GET /orders",
  durationMs: 12,
  startTime: 1000,
  status: "ok",
};

function Canvas({
  current,
  onSelection,
  fetchTrace,
  variables,
}: {
  current: Widget;
  onSelection: (widget: Widget, context: DrilldownContext) => void;
  fetchTrace?: (id: string, signal: AbortSignal) => Promise<QueryResult>;
  variables?: Record<string, string>;
}) {
  const dashboard: Dashboard = {
    schemaVersion: 1,
    id: "overview",
    title: "Overview",
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [current],
    variables: [{ name: "service" }],
  };
  const canvas = (
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
  return fetchTrace ? <TraceFetcherProvider fetchTrace={fetchTrace}>{canvas}</TraceFetcherProvider> : canvas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("table rows select the dashboard only on deliberate activation", () => {
  const setup = (variables?: Record<string, string>) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [series("api", 7), series("worker", 12)] };
    const selected = vi.fn();
    render(<Canvas current={table} onSelection={selected} variables={variables} />);
    return selected;
  };

  it("focus sets only the drilldown context and does not change the dashboard", () => {
    const selected = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    fireEvent.focus(worker);
    expect(selected).not.toHaveBeenCalled();
    expect(worker).not.toHaveAttribute("data-filter-active");
  });

  it("hover never selects", () => {
    const selected = setup();
    fireEvent.mouseOver(screen.getByText("worker"));
    expect(selected).not.toHaveBeenCalled();
  });

  it("a row click applies the selection once and marks the applied row", () => {
    const selected = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    fireEvent.click(worker);
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(table, expect.objectContaining({ labels: { service: "worker" } }));
    // The mark follows the dashboard's variables, not the click: the variables have not changed in this test.
    expect(worker).not.toHaveAttribute("data-filter-active");
  });

  it("a row whose series lacks the bound label sets only the context and does not fail the selection", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [series("api", 7), { name: "batch", labels: {}, points: [{ timestamp: 1000, value: 3 }] }] };
    const selected = vi.fn();
    render(<Canvas current={table} onSelection={selected} />);
    fireEvent.click(screen.getByText("batch").closest("tr")!);
    expect(selected).not.toHaveBeenCalled();
  });

  it("the row whose selection the variables hold is the applied filter", () => {
    setup({ service: "worker" });
    const worker = screen.getByText("worker").closest("tr")!;
    expect(worker).toHaveAttribute("data-filter-active");
    expect(worker).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("api").closest("tr")).not.toHaveAttribute("data-filter-active");
  });

  it("Enter on a focused row applies the selection once", () => {
    const selected = setup();
    fireEvent.keyDown(screen.getByText("worker").closest("tr")!, { key: "Enter" });
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(table, expect.objectContaining({ labels: { service: "worker" } }));
  });

  it("focusing the series name button only previews it", () => {
    const selected = setup();
    fireEvent.focus(screen.getByRole("button", { name: "Inspect series worker" }));
    expect(selected).not.toHaveBeenCalled();
  });

  it("the series name button applies the selection once, not again from the row", () => {
    const selected = setup();
    fireEvent.click(screen.getByRole("button", { name: "Inspect series worker" }));
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(table, expect.objectContaining({ labels: { service: "worker" } }));
  });
});

describe("trace rows select the dashboard only on deliberate activation", () => {
  const setup = (fetchTrace?: (id: string, signal: AbortSignal) => Promise<QueryResult>, variables?: Record<string, string>) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { traces: [trace] };
    const selected = vi.fn();
    render(<Canvas current={traces} onSelection={selected} fetchTrace={fetchTrace} variables={variables} />);
    return selected;
  };

  it("focus never selects", () => {
    const selected = setup();
    fireEvent.focus(screen.getByRole("row", { name: /GET \/orders/ }));
    expect(selected).not.toHaveBeenCalled();
  });

  it("a row click applies the trace labels once and marks the row", () => {
    const selected = setup();
    const row = screen.getByRole("row", { name: /GET \/orders/ });
    fireEvent.click(row);
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(traces, expect.objectContaining({
      labels: { traceId, service: "api", operation: "GET /orders", status: "ok" },
    }));
    expect(row).not.toHaveAttribute("data-filter-active");
  });

  it("the trace whose service the variables hold is the applied filter", () => {
    setup(undefined, { service: "api" });
    expect(screen.getByRole("row", { name: /GET \/orders/ })).toHaveAttribute("data-filter-active");
    expect(screen.getByRole("row", { name: /GET \/orders/ })).toHaveAttribute("aria-current", "true");
  });

  it("the waterfall toggle, by click or Enter, expands the trace without changing the dashboard", () => {
    const selected = setup(vi.fn(() => new Promise<QueryResult>(() => undefined)));
    const toggle = screen.getByRole("button", { name: "View waterfall" });
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(selected).not.toHaveBeenCalled();
  });
});

describe("heatmap cells select the dashboard only on deliberate activation", () => {
  const heatmap: Widget = { ...table, id: "heat", title: "Heat", type: "heatmap" };
  const setup = (variables?: Record<string, string>) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [series("api", 7), series("worker", 12)] };
    const selected = vi.fn();
    render(<Canvas current={heatmap} onSelection={selected} variables={variables} />);
    return selected;
  };

  it("the cell whose selection the variables hold is the applied filter", () => {
    setup({ service: "api" });
    expect(screen.getByRole("button", { name: /^api:/ })).toHaveAttribute("data-filter-active");
    expect(screen.getByRole("button", { name: /^api:/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /^worker:/ })).not.toHaveAttribute("data-filter-active");
  });

  it("arrow-key movement between cells only sets the drilldown context", () => {
    const selected = setup();
    const api = screen.getByRole("button", { name: /^api:/ });
    const worker = screen.getByRole("button", { name: /^worker:/ });
    fireEvent.focus(api);
    fireEvent.keyDown(api, { key: "ArrowRight" });
    expect(document.activeElement).toBe(worker);
    expect(selected).not.toHaveBeenCalled();
  });

  it("a click and an Enter each apply the selection once and pin the cell", async () => {
    const user = userEvent.setup();
    const selected = setup();
    const api = screen.getByRole("button", { name: /^api:/ });
    await user.click(api);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenLastCalledWith(heatmap, expect.objectContaining({ labels: { service: "api" } }));
    expect(api).toHaveAttribute("aria-pressed", "true");
    const worker = screen.getByRole("button", { name: /^worker:/ });
    worker.focus();
    await user.keyboard("{Enter}");
    expect(selected).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenLastCalledWith(heatmap, expect.objectContaining({ labels: { service: "worker" } }));
    expect(worker).toHaveAttribute("aria-pressed", "true");
  });

  it("a second activation of the same cell unpins it and sends the same selection again", async () => {
    const user = userEvent.setup();
    const selected = setup();
    const api = screen.getByRole("button", { name: /^api:/ });
    await user.click(api);
    await user.click(api);
    expect(api).toHaveAttribute("aria-pressed", "false");
    expect(selected).toHaveBeenCalledTimes(2);
    expect(selected.mock.calls[1][1]).toEqual(selected.mock.calls[0][1]);
  });
});

describe("focus after a selection that re-renders its own source", () => {
  const setup = () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [series("api", 7), series("worker", 12)] };
    const selected = vi.fn();
    const view = render(<Canvas current={table} onSelection={selected} />);
    return { selected, rerender: view.rerender };
  };

  it("moves focus to the tile when the activated row is removed by the re-render", () => {
    const { selected, rerender } = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    worker.focus();
    fireEvent.click(worker);
    expect(selected).toHaveBeenCalledOnce();
    // The selection filters this table by service, so the row that was activated is no longer in its data.
    query.data = { series: [series("api", 7)] };
    rerender(<Canvas current={table} onSelection={selected} variables={{ service: "worker" }} />);
    expect(document.activeElement).toBe(screen.getByRole("article", { name: "Requests" }));
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Dashboard filtered. Focus moved to Requests.");
  });

  it("keeps focus on the activated row when the row stays", () => {
    const { selected, rerender } = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    worker.focus();
    fireEvent.click(worker);
    expect(selected).toHaveBeenCalledOnce();
    rerender(<Canvas current={table} onSelection={selected} variables={{ service: "worker" }} />);
    expect(document.activeElement).toBe(screen.getByText("worker").closest("tr"));
  });
  it("leaves focus where the user put it when they moved to another control while the selection loaded", () => {
    const { selected, rerender } = setup();
    const outside = document.createElement("button");
    outside.textContent = "Elsewhere";
    document.body.appendChild(outside);
    try {
      const worker = screen.getByText("worker").closest("tr")!;
      worker.focus();
      fireEvent.click(worker);
      expect(selected).toHaveBeenCalledOnce();
      outside.focus();
      query.data = { series: [series("api", 7)] };
      rerender(<Canvas current={table} onSelection={selected} variables={{ service: "worker" }} />);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it("refocuses the tile when focus fell to the page while the selection loaded", () => {
    const { selected, rerender } = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    worker.focus();
    fireEvent.click(worker);
    expect(selected).toHaveBeenCalledOnce();
    // Focus drops to the page with no other control taking it (relatedTarget is null), so the wait stays open.
    (document.activeElement as HTMLElement).blur();
    query.data = { series: [series("api", 7)] };
    rerender(<Canvas current={table} onSelection={selected} variables={{ service: "api" }} />);
    expect(document.activeElement?.tagName).toBe("ARTICLE");
  });

  it("drops the tile's fallback tab stop once that focus leaves the tile", () => {
    const { selected, rerender } = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    worker.focus();
    fireEvent.click(worker);
    expect(selected).toHaveBeenCalledOnce();
    (document.activeElement as HTMLElement).blur();
    query.data = { series: [series("api", 7)] };
    rerender(<Canvas current={table} onSelection={selected} variables={{ service: "api" }} />);
    const tile = document.activeElement as HTMLElement;
    expect(tile.tagName).toBe("ARTICLE");
    expect(tile).toHaveAttribute("tabindex", "-1");
    tile.blur();
    // Without the tab stop, a later click on blank tile area cannot focus the tile.
    expect(tile).not.toHaveAttribute("tabindex");
  });

  it("does not wait for a re-render when the activated row is already the applied filter", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [series("api", 7), series("worker", 12)] };
    const selected = vi.fn();
    const { rerender } = render(<Canvas current={table} onSelection={selected} variables={{ service: "worker" }} />);
    const worker = screen.getByText("worker").closest("tr")!;
    worker.focus();
    fireEvent.click(worker);
    (document.activeElement as HTMLElement).blur();
    // A later refresh drops the row while the variables stay the same: nothing the activation did removed it.
    query.data = { series: [series("api", 7)] };
    rerender(<Canvas current={table} onSelection={selected} variables={{ service: "worker" }} />);
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByText("Dashboard filtered. Focus moved to Requests.")).toBeNull();
  });

  it("keeps focus on another control in the tile that the user moved to while the selection loaded", () => {
    const { selected, rerender } = setup();
    const worker = screen.getByText("worker").closest("tr")!;
    worker.focus();
    fireEvent.click(worker);
    expect(selected).toHaveBeenCalledOnce();
    const api = screen.getByText("api").closest("tr")!;
    api.focus();
    query.data = { series: [series("api", 7)] };
    rerender(<Canvas current={table} onSelection={selected} variables={{ service: "worker" }} />);
    expect(document.activeElement).toBe(screen.getByText("api").closest("tr"));
  });

  it("does not refocus the tile later when the activated row is removed after focus has left the tile", () => {
    const { selected, rerender } = setup();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      const worker = screen.getByText("worker").closest("tr")!;
      worker.focus();
      fireEvent.click(worker);
      expect(selected).toHaveBeenCalledOnce();
      // Focus moves to another control, then leaves the page: the row's blur must end the wait, or a later refresh that drops the row would pull focus back to the tile.
      outside.focus();
      outside.blur();
      query.data = { series: [series("api", 7)] };
      rerender(<Canvas current={table} onSelection={selected} variables={{ service: "api" }} />);
      expect(document.activeElement).toBe(document.body);
    } finally {
      outside.remove();
    }
  });
});

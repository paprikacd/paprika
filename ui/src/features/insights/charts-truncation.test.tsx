import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import chartStyles from "./charts.module.css";
import type { QueryResult, Widget } from "./schema";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";

afterEach(cleanup);

const timeseries: Widget = { id: "latency", title: "API latency", type: "timeseries", providerId: "prometheus", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 } };
const series: QueryResult["series"] = [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] }];
const traceRow = (status: string) => ({ traceId: "a1", service: "checkout", operation: "POST /orders", durationMs: 12, startTime: 1000, status });

describe("row-limit presentation", () => {
  it("shows a row cap as a neutral fact with no warning colour or status role", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={{ series, truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "series" } }} />);
    const fact = screen.getByText("First 100 series shown");
    expect(fact).toHaveClass(chartStyles.limitFact);
    expect(fact).not.toHaveAttribute("role", "status");
    expect(container.querySelector(`.${chartStyles.limitNotice}`)).toBeNull();
  });

  it("keeps the amber notice for a partial response with its own copy", () => {
    render(<WidgetVisualization widget={timeseries} result={{ series, truncated: true, truncation: { reason: "partial" } }} />);
    expect(screen.getByRole("status")).toHaveTextContent("The data source returned a partial response.");
    expect(screen.getByRole("status")).toHaveClass(chartStyles.limitNotice);
  });

  it("keeps the amber notice for provider warnings with its own copy", () => {
    render(<WidgetVisualization widget={timeseries} result={{ series, truncated: true, truncation: { reason: "provider_warning" } }} />);
    expect(screen.getByRole("status")).toHaveTextContent("The data source returned warnings for this query.");
  });

  it("gives a plugin no host notice for a row cap, and the plugin keeps its own neutral footer", () => {
    registerDefaultWidgetPlugins();
    const plugin: Widget = { ...timeseries, type: "plugin", pluginId: "status-grid", dataKind: "metrics" } as Widget;
    const { container } = render(<WidgetVisualization widget={plugin} result={{ series, truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "series" } }} />);
    // The plugin rendered: its footer is present, so the absence below is not vacuous.
    expect(screen.getByText("Source row limit reached · narrow the query to see others")).toBeInTheDocument();
    expect(container.querySelector("[data-truncation]")).toBeNull();
    expect(container.querySelector(`.${chartStyles.limitFact}`)).toBeNull();
    expect(container.querySelector(`.${chartStyles.limitNotice}`)).toBeNull();
  });
});

describe("single gauge row-limit presentation", () => {
  it("prints the neutral row-limit footer, because a single gauge has no bank footer of its own", () => {
    registerDefaultWidgetPlugins();
    const gauge: Widget = { ...timeseries, type: "plugin", pluginId: "threshold-gauge", dataKind: "metrics" } as Widget;
    const { container } = render(<WidgetVisualization widget={gauge} result={{ series, truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "series" } }} />);
    expect(screen.getByText("Source row limit reached · narrow the query to see others")).toBeInTheDocument();
    expect(container.querySelector("[data-truncation]")).toBeNull();
  });
});

describe("stat row-limit presentation", () => {
  it("shows no Partial chip for a row-capped stat, but keeps it for a partial one", () => {
    const stat: Widget = { ...timeseries, type: "stat" };
    const { rerender } = render(<WidgetVisualization widget={stat} result={{ series, truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "series" } }} />);
    expect(screen.queryByText("Partial")).toBeNull();
    rerender(<WidgetVisualization widget={stat} result={{ series, truncated: true, truncation: { reason: "partial" } }} />);
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });
});

describe("trace status column", () => {
  const traceWidget: Widget = { ...timeseries, type: "traces" };

  it("shows the Status column when one row reports a status, and the tooltip omits an unreported one", () => {
    const unreported = { ...traceRow("unknown"), traceId: "quiet" };
    const reported = { ...traceRow("error"), traceId: "failed", operation: "GET /failed" };
    render(<WidgetVisualization widget={traceWidget} result={{ traces: [unreported, reported] }} />);
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: "Inspect trace quiet" }));
    const tip = screen.getByRole("tooltip");
    expect(within(tip).queryByText(/^unknown$/i)).toBeNull();
    expect(screen.queryByText("Search results do not report trace status")).toBeNull();
  });

  it("hides the Status column when no row reports a status", () => {
    render(<WidgetVisualization widget={traceWidget} result={{ traces: [traceRow("unknown"), traceRow("")] }} />);
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
    expect(screen.getByText("Search results do not report trace status")).toBeInTheDocument();
  });

  it("keeps the status note outside the scrolling table region", () => {
    render(<WidgetVisualization widget={traceWidget} result={{ traces: [traceRow("unknown")] }} />);
    const note = screen.getByText("Search results do not report trace status");
    expect(note.closest('[role="region"]')).toBeNull();
  });

  it("shows the Status column when one row reports an error", () => {
    render(<WidgetVisualization widget={traceWidget} result={{ traces: [traceRow("unknown"), traceRow("error")] }} />);
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByText("Search results do not report trace status")).toBeNull();
  });
});

describe("query failure frame", () => {
  it("names the source and offers Edit query for an invalid query in edit mode", () => {
    const onEditQuery = vi.fn();
    const onRetry = vi.fn();
    const { container } = render(<WidgetVisualization widget={timeseries} error="The data source rejected this query. Check the expression and time bounds." errorCode="invalid_query" providerName="Metrics" onEditQuery={onEditQuery} onRetry={onRetry} />);
    expect(container.querySelector('[data-query-failure="invalid_query"]')).not.toBeNull();
    expect(screen.getByText("Query failed")).toBeInTheDocument();
    expect(screen.getByText("Source: Metrics")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit query for API latency" }));
    expect(onEditQuery).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Retry query/ })).toBeInTheDocument();
  });

  it("offers no Edit query in view mode, where the editor is not open", () => {
    render(<WidgetVisualization widget={timeseries} error="The data source could not complete this query. Retry, or check its connection." errorCode="provider_error" providerName="Metrics" />);
    expect(screen.queryByRole("button", { name: /^Edit query/ })).toBeNull();
    expect(screen.getByText("Source: Metrics")).toBeInTheDocument();
  });

  it("offers no Edit query for an access or capacity failure, and names no source without a provider", () => {
    const { rerender, container } = render(<WidgetVisualization widget={timeseries} error="Access to this data source was refused." errorCode="forbidden" providerName="Metrics" onEditQuery={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Edit query/ })).toBeNull();
    rerender(<WidgetVisualization widget={timeseries} error="Query capacity is busy; retry shortly." errorCode="rate_limited" onEditQuery={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Edit query/ })).toBeNull();
    expect(screen.queryByText(/^Source:/)).toBeNull();
    expect(container.querySelector('[data-query-failure="rate_limited"]')).not.toBeNull();
  });

  it("keeps the frame for a failure with no code, without a source or edit action", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} error="Query failed at the data source." onEditQuery={() => {}} />);
    expect(container.querySelector("[data-query-failure]")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit query/ })).toBeNull();
    expect(screen.getByText("Query failed at the data source.")).toBeInTheDocument();
  });
});

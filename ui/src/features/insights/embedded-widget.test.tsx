import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InsightsClient } from "./client";
import EmbeddedWidget from "./embedded-widget";
import type { Dashboard, QueryRequest } from "./schema";

const canvas = vi.hoisted(() => ({
  fetcher: undefined as undefined | ((request: QueryRequest, signal: AbortSignal) => Promise<unknown>),
}));

// The canvas is mocked: the test checks the tile's dashboard and the query the widget sends, not chart drawing.
vi.mock("./canvas", () => ({
  DashboardCanvas: ({ dashboard, fetcher }: {
    dashboard: Dashboard;
    fetcher: (request: QueryRequest, signal: AbortSignal) => Promise<unknown>;
  }) => {
    canvas.fetcher = fetcher;
    return (
      <output>
        {dashboard.widgets.map((widget) => `${widget.title}:${widget.drilldowns ? "links" : "no-links"}`).join(",")}
      </output>
    );
  },
}));

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "service-overview",
  title: "Service overview",
  timeRange: "1h",
  refreshInterval: 0,
  variables: [{ name: "service", defaultValue: "checkout" }],
  widgets: [
    {
      id: "requests",
      title: "Request rate",
      type: "stat",
      providerId: "prom",
      query: "sum(rate(http_requests_total{service={{service}}}[5m]))",
      unit: "req/s",
      drilldowns: [{ id: "open", title: "Open", dashboardId: "service-overview" }],
      layout: { x: 0, y: 0, w: 4, h: 2 },
    },
  ],
};

function clientFor(): { client: InsightsClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ series: [] }));
  const client = {
    get: vi.fn(async () => ({ dashboard })),
    providers: vi.fn(async () => [{ id: "prom", name: "Prometheus", type: "prometheus", capabilities: ["metrics"] }]),
    listSavedQueries: vi.fn(async () => []),
    query,
  } as unknown as InsightsClient;
  return { client, query };
}

describe("embedded widget", () => {
  it("renders the one widget read-only and sends its query with the declared link variables", async () => {
    const { client, query } = clientFor();
    render(
      <EmbeddedWidget
        client={client}
        dashboardId="service-overview"
        widgetId="requests"
        variables={{ service: "payments", undeclared: "ignored" }}
        href="/dashboard/insights/?dashboard=service-overview"
      />,
    );
    expect(await screen.findByText("Request rate:no-links")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard/insights/?dashboard=service-overview");
    await canvas.fetcher!({ providerId: "prom", kind: "metrics", query: dashboard.widgets[0].query, start: 1, end: 2, step: 1 }, new AbortController().signal);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'sum(rate(http_requests_total{service="payments"}[5m]))' }),
      expect.anything(),
      { replayCapacity: false },
    );
  });

  it("says when the widget has been removed from the dashboard", async () => {
    const { client } = clientFor();
    render(
      <EmbeddedWidget
        client={client}
        dashboardId="service-overview"
        widgetId="gone"
        variables={{}}
        href="/dashboard/insights/?dashboard=service-overview"
      />,
    );
    expect(await screen.findByText(/This widget is no longer on the dashboard/)).toBeInTheDocument();
  });

  it("shows loading, then the load failure", async () => {
    const { client } = clientFor();
    let reject!: (error: Error) => void;
    (client.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    render(<EmbeddedWidget client={client} dashboardId="service-overview" widgetId="requests" variables={{}} href="/x" />);
    expect(screen.getByText("Loading metrics…")).toBeInTheDocument();
    reject(new Error("Dashboard not found"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard not found");
  });

  it("takes the host's appearance and only its own height on the host page", async () => {
    const { client } = clientFor();
    render(<EmbeddedWidget client={client} dashboardId="service-overview" widgetId="requests" variables={{}} href="/x" theme="light" />);
    const tile = (await screen.findByText("Request rate:no-links")).closest("[data-insights-theme]") as HTMLElement;
    expect(tile).toHaveAttribute("data-insights-theme", "light");
    // The Insights page root is a full-viewport flex row; inside a console page it must not be.
    expect(parseFloat(tile.style.minHeight)).toBe(0);
    expect(tile.style.display).toBe("block");
  });
});

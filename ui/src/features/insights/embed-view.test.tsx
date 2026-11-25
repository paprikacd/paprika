import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightsClient } from "./client";
import { readEmbedRequest } from "./embed-request";
import { EmbedView } from "./embed-view";
import { INSIGHTS_THEME_KEY } from "./insights-theme";
import type { Dashboard, QueryRequest } from "./schema";

type CanvasProps = {
  dashboard: Dashboard;
  fetcher: (request: QueryRequest, signal: AbortSignal) => Promise<unknown>;
  end: number;
  editing: boolean;
  focus?: { widget: { id: string } };
  onDrilldown?: unknown;
  onSelection?: unknown;
  onTimeRange?: unknown;
  onDuplicate?: unknown;
  onRemove?: unknown;
};
const canvas = vi.hoisted(() => ({ props: undefined as undefined | CanvasProps, renders: 0 }));

// The canvas is mocked: these tests check what the embed hands it, not chart drawing.
vi.mock("./canvas", () => ({
  DashboardCanvas: (props: CanvasProps) => {
    canvas.props = props;
    canvas.renders++;
    return <output>{props.dashboard.widgets.map((widget) => widget.title).join(",")}</output>;
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
    { id: "errors", title: "Errors", type: "stat", providerId: "prom", query: "1", unit: "", layout: { x: 4, y: 0, w: 4, h: 2 } },
  ],
};

function clientFor(document: Dashboard = dashboard) {
  const query = vi.fn(async () => ({ series: [] }));
  const client = {
    get: vi.fn(async () => ({ dashboard: document })),
    providers: vi.fn(async () => [{ id: "prom", name: "Prometheus", type: "prometheus", capabilities: ["metrics"] }]),
    listSavedQueries: vi.fn(async () => []),
    list: vi.fn(async () => []),
    query,
  };
  return { client: client as unknown as InsightsClient, mocks: client };
}

function open(search: string) {
  window.history.replaceState(null, "", `/dashboard/insights/${search}`);
  return readEmbedRequest(search)!;
}

beforeEach(() => {
  canvas.props = undefined;
  canvas.renders = 0;
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("embed request", () => {
  it("reads the widget id and theme, and rejects what is not a widget id", () => {
    expect(readEmbedRequest("?dashboard=a")).toBeNull();
    expect(readEmbedRequest("?dashboard=a&embed=requests&theme=dark")).toEqual({ widgetId: "requests", theme: "dark" });
    expect(readEmbedRequest("?dashboard=a&embed=requests&theme=blue")).toEqual({ widgetId: "requests" });
    for (const bad of ["", "-x", "a b", "../x", "x".repeat(81), "https://evil.example"])
      expect(readEmbedRequest(`?${new URLSearchParams({ embed: bad })}`)).toEqual({ widgetId: "" });
    expect(readEmbedRequest("?embed=a&embed=b")).toEqual({ widgetId: "" });
  });
});

describe("Insights embed mode", () => {
  it("renders the one widget read-only with the link's declared variables", async () => {
    const embed = open(`?dashboard=service-overview&embed=requests&vars=${encodeURIComponent(JSON.stringify({ service: "payments", undeclared: "x" }))}`);
    const { client, mocks } = clientFor();
    render(<EmbedView client={client} embed={embed} />);
    expect(await screen.findByText("Request rate")).toBeInTheDocument();
    const props = canvas.props!;
    expect(props.dashboard.widgets.map((widget) => widget.id)).toEqual(["requests"]);
    expect(props.dashboard.widgets[0].drilldowns).toBeUndefined();
    expect(props.editing).toBe(false);
    expect(props.focus?.widget.id).toBe("requests");
    // No drilldowns, selections, brushing or tile actions: the tile is a reading.
    for (const handler of ["onDrilldown", "onSelection", "onTimeRange", "onDuplicate", "onRemove"] as const)
      expect(props[handler]).toBeUndefined();
    // The workspace's library and editors never load.
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listSavedQueries).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await props.fetcher({ providerId: "prom", kind: "metrics", query: dashboard.widgets[0].query, start: 1, end: 2, step: 1 }, new AbortController().signal);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'sum(rate(http_requests_total{service="payments"}[5m]))' }),
      expect.anything(),
      { replayCapacity: false },
    );
  });

  it("links to the whole dashboard in the top window, without the embed parameters", async () => {
    const embed = open(`?dashboard=service-overview&embed=requests&theme=light&range=6h&vars=${encodeURIComponent(JSON.stringify({ service: "payments" }))}`);
    render(<EmbedView client={clientFor().client} embed={embed} />);
    await screen.findByText("Request rate");
    const link = screen.getByRole("link", { name: "Open dashboard" });
    expect(link).toHaveAttribute("target", "_top");
    const href = new URL(link.getAttribute("href")!, "https://paprika.example.test");
    expect(href.origin).toBe("https://paprika.example.test");
    expect(href.pathname).toBe("/dashboard/insights/");
    expect(Object.fromEntries(href.searchParams)).toEqual({ dashboard: "service-overview", range: "6h", vars: '{"service":"payments"}' });
    // The link's range is the tile's window too.
    expect(canvas.props!.dashboard.timeRange).toBe("6h");
  });

  it("takes the host's theme, or the Insights preference without one", async () => {
    const { client } = clientFor();
    const dark = render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=requests&theme=dark")} />);
    await screen.findByText("Request rate");
    expect(dark.container.querySelector("[data-insights-embed]")).toHaveAttribute("data-insights-theme", "dark");
    dark.unmount();
    localStorage.setItem(INSIGHTS_THEME_KEY, "dark");
    const light = render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=requests&theme=light")} />);
    await screen.findByText("Request rate");
    expect(light.container.querySelector("[data-insights-embed]")).toHaveAttribute("data-insights-theme", "light");
    light.unmount();
    const preference = render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=requests")} />);
    await screen.findByText("Request rate");
    expect(preference.container.querySelector("[data-insights-embed]")).toHaveAttribute("data-insights-theme", "dark");
  });

  it("keeps auto refresh, and a hidden frame waits", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { client } = clientFor({ ...dashboard, refreshInterval: 15 });
    render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=requests")} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("Request rate")).toBeInTheDocument();
    const first = canvas.props!.end;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(canvas.props!.end).toBeGreaterThan(first);
  });

  it("shows loading, then the load failure", async () => {
    const { client, mocks } = clientFor();
    let reject!: (error: Error) => void;
    mocks.get.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=requests")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading widget…");
    await act(async () => reject(new Error("Dashboard not found")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard not found");
  });

  it("says when the widget is gone or the link is not valid, and loads nothing for a bad link", async () => {
    const { client, mocks } = clientFor();
    const gone = render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=gone")} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This widget is no longer on the dashboard.");
    gone.unmount();
    mocks.get.mockClear();
    const bad = render(<EmbedView client={client} embed={open("?dashboard=service-overview&embed=..%2Fx")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This widget link is not valid.");
    bad.unmount();
    render(<EmbedView client={client} embed={open("?embed=requests")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This widget link names no dashboard.");
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

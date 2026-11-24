import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const provider = exampleProviders[0].id;
const source = { queryRef: { id: "events" }, timestampColumn: "date", labelColumn: "label" };
const ownSource = { queryRef: { id: "own-events" }, timestampColumn: "date", labelColumn: "label" };
const END = 10_800;
const timeseries = (id: string, options: Widget["options"] = {}, annotationSource?: Widget["annotationSource"]): Widget =>
  ({ id, title: id, type: "timeseries", providerId: provider, query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 }, options, ...(annotationSource ? { annotationSource } : {}) }) as Widget;
const dashboard = (widgets: Widget[], annotationSource = source): Dashboard =>
  ({ schemaVersion: 1, id: "ev", title: "Events", timeRange: "1h", refreshInterval: 0, annotationSource, widgets }) as unknown as Dashboard;
// The samples span the event, so the event falls inside the plotted window.
const metrics: QueryResult = { series: [{ name: "rate", labels: {}, points: [{ timestamp: (END - 600) * 1000, value: 3 }, { timestamp: (END - 60) * 1000, value: 4 }] }] };
const records = (label: string): QueryResult => ({
  records: { columns: [{ key: "date", type: "string" }, { key: "label", type: "string" }], rows: [[new Date((END - 120) * 1000).toISOString(), label]] },
});

function answerer() {
  return vi.fn(async (request: QueryRequest): Promise<QueryResult> => {
    if (request.kind !== "records") return metrics;
    return records(request.queryRef?.id === "own-events" ? "Own event" : "Dashboard event");
  });
}

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
}

const eventCount = (container: HTMLElement, widgetId: string) =>
  container.querySelectorAll(`[data-widget-id="${widgetId}"] [data-annotation-timestamp]`).length;

describe("the dashboard's recorded events", () => {
  it("queries the dashboard source once and shares it with each time-based widget", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetcher = answerer();
    const { container } = render(
      <DashboardCanvas dashboard={dashboard([timeseries("first"), timeseries("second")])} providers={exampleProviders} fetcher={fetcher} end={END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />,
    );
    await settle();
    expect(fetcher.mock.calls.filter(([request]) => request.kind === "records")).toHaveLength(1);
    expect(eventCount(container, "first")).toBe(1);
    expect(eventCount(container, "second")).toBe(1);
  });

  it("lets a widget's own source win, and hides the dashboard's events when a widget opts out", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetcher = answerer();
    const { container } = render(
      <DashboardCanvas
        dashboard={dashboard([timeseries("own", {}, ownSource), timeseries("quiet", { showEvents: false })])}
        providers={exampleProviders}
        fetcher={fetcher}
        end={END}
        editing={false}
        selected=""
        onSelect={vi.fn()}
        onLayout={vi.fn()}
      />,
    );
    await settle();
    expect(container.querySelector('[data-widget-id="own"]')?.textContent).toContain("Own event");
    expect(container.querySelector('[data-widget-id="own"]')?.textContent).not.toContain("Dashboard event");
    expect(eventCount(container, "quiet")).toBe(0);
  });
});

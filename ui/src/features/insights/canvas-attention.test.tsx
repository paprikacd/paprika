import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Layout } from "react-grid-layout";
import { DashboardCanvas } from "./canvas";
import { exampleProviders } from "./example";
import type { Dashboard, QueryResult, Widget } from "./schema";

vi.mock("react-grid-layout", async () => {
  const { useRef } = await import("react");
  const core = await import("react-grid-layout/core");
  return {
    default: ({ children }: { children: ReactNode; layout: Layout }) => <div>{children}</div>,
    useContainerWidth: () => ({ width: 1100, containerRef: useRef(null), mounted: true }),
    verticalCompactor: core.verticalCompactor,
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const statWidget: Widget = {
  id: "error-ratio", title: "Error ratio", type: "stat", providerId: exampleProviders[0].id, query: "error_ratio", unit: "%",
  layout: { x: 0, y: 0, w: 3, h: 2 },
  options: { thresholds: [{ value: 0, status: "ok", label: "Healthy" }, { value: 5, status: "critical", label: "Breached", color: "#b4473d" }] },
} as Widget;
const dashboard = { schemaVersion: 1, id: "attention", title: "Attention", timeRange: "1h", refreshInterval: 0, widgets: [statWidget] } as unknown as Dashboard;

function renderWith(value: number) {
  vi.stubGlobal("IntersectionObserver", undefined);
  const fetcher = vi.fn(async (): Promise<QueryResult> => ({ series: [{ name: "api", labels: {}, points: [{ timestamp: 3_500_000, value }] }] }));
  const view = render(<DashboardCanvas dashboard={dashboard} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />);
  return { view, tile: () => view.container.querySelector<HTMLElement>('[data-widget-id="error-ratio"]') };
}

it("marks a tile whose band is critical with its attention, a chip and the rail colour", async () => {
  const { tile } = renderWith(7);
  await waitFor(() => expect(tile()?.getAttribute("data-attention")).toBe("critical"));
  expect(tile()?.querySelector('[data-stat-chip="critical"]')).toHaveTextContent("Breached");
  expect(tile()?.getAttribute("style") ?? "").toContain("--attention-mark");
});

it("leaves a healthy tile at ok with no chip and no rail colour", async () => {
  const { tile } = renderWith(1);
  await waitFor(() => expect(tile()?.getAttribute("data-attention")).toBe("ok"));
  expect(tile()?.querySelector("[data-stat-chip]")).toBeNull();
  expect(tile()?.getAttribute("style") ?? "").not.toContain("--attention-mark");
});

it("reports a tile whose shared source is unavailable as failed, not pending", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const { SourceStatusContext } = await import("./source-status");
  const orphan = { ...statWidget, providerId: "not-in-the-catalog" };
  const fetcher = vi.fn(async (): Promise<QueryResult> => ({ series: [] }));
  const view = render(
    <SourceStatusContext.Provider value="unavailable">
      <DashboardCanvas dashboard={{ ...dashboard, widgets: [orphan] }} providers={exampleProviders} fetcher={fetcher} end={3600} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />
    </SourceStatusContext.Provider>,
  );
  const tile = view.container.querySelector<HTMLElement>('[data-widget-id="error-ratio"]');
  await waitFor(() => expect(tile?.getAttribute("data-attention")).toBe("failed"));
  expect(fetcher).not.toHaveBeenCalled();
});

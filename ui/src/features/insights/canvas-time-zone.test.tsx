import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DashboardCanvas } from "./canvas";
import { exampleDashboard, exampleProviders } from "./example";
import type { Dashboard, QueryResult, Widget } from "./schema";

vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="saved-grid">{children}</div>,
  useContainerWidth: () => ({ width: 1100, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Hourly samples from 14:00Z to 17:00Z on 3 October 2026, across Melbourne's spring-forward change.
const melbourneDay: QueryResult = { series: [{ name: "load", labels: {}, points: [14, 15, 16, 17].map((hour) => ({ timestamp: Date.UTC(2026, 9, 3, hour), value: hour - 13 })) }] };
const widget: Widget = { id: "load", title: "Melbourne load", type: "timeseries", providerId: "example-prometheus", query: "load", unit: "req", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { timeAxis: "calendar" } };

function dashboardWith(timeZone?: string): Dashboard {
  const dashboard = structuredClone(exampleDashboard);
  dashboard.widgets = [widget];
  dashboard.customTimeRange = { from: "2026-10-03T13:00:00Z", to: "2026-10-03T18:00:00Z" };
  if (timeZone) dashboard.timeZone = timeZone;
  else delete dashboard.timeZone;
  return dashboard;
}
function axisLabels(name: string) {
  const tile = screen.getByRole("article", { name });
  return [...tile.querySelectorAll("text")].map((node) => node.textContent ?? "");
}

it("labels a calendar axis in the dashboard's own time zone", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const props = { dashboard: dashboardWith("Australia/Melbourne"), providers: exampleProviders, fetcher: vi.fn().mockResolvedValue(melbourneDay), end: 3600, onSelect: vi.fn(), onLayout: vi.fn(), editing: false };
  render(<DashboardCanvas {...props} />);
  await waitFor(() => expect(axisLabels("Melbourne load")).toEqual(expect.arrayContaining(["Oct 4", "01:00", "03:00", "04:00"])), { timeout: 4000 });
  expect(axisLabels("Melbourne load")).not.toContain("02:00");
});

it("falls back to the viewer's zone when the dashboard names none", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const runtimeOptions = Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...runtimeOptions, timeZone: "UTC" });
  const props = { dashboard: dashboardWith(), providers: exampleProviders, fetcher: vi.fn().mockResolvedValue(melbourneDay), end: 3600, onSelect: vi.fn(), onLayout: vi.fn(), editing: false };
  render(<DashboardCanvas {...props} />);
  await waitFor(() => expect(axisLabels("Melbourne load")).toEqual(expect.arrayContaining(["14:00", "15:00", "16:00", "17:00"])), { timeout: 4000 });
  expect(axisLabels("Melbourne load")).not.toEqual(expect.arrayContaining(["Oct 4"]));
});

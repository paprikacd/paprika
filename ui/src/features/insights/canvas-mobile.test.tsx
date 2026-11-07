import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DashboardCanvas } from "./canvas";
import { exampleDashboard, exampleProviders } from "./example";

const viewport = vi.hoisted(() => ({ width: 320 }));
vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="saved-grid">{children}</div>,
  useContainerWidth: () => ({ width: viewport.width, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); viewport.width = 320; });
it("uses intrinsic phone reading flow only in view mode and retains extra results and saved geometry", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const dashboard = structuredClone(exampleDashboard);
  const before = JSON.stringify(dashboard);
  const fetcher = vi.fn().mockResolvedValue({ series: [
    { name: "primary", labels: {}, points: [{ timestamp: 3500000, value: 42 }] },
    { name: "secondary", labels: {}, points: [{ timestamp: 3500000, value: 17 }] },
  ] });
  const onLayout = vi.fn();
  const props = { dashboard, providers: exampleProviders, fetcher, end: 3600, onSelect: vi.fn(), onLayout };
  const { rerender } = render(<DashboardCanvas {...props} editing={false} />);
  expect(screen.queryByTestId("saved-grid")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByText("secondary").length).toBeGreaterThan(0));
  expect(screen.getByRole("article", { name: "Request rate" })).toHaveAttribute("data-intrinsic-stat", "true");
  expect(screen.getAllByText(/Latest valid sample/).length).toBeGreaterThan(0);
  rerender(<DashboardCanvas {...props} editing />);
  expect(screen.getByTestId("saved-grid")).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Request rate" })).not.toHaveAttribute("data-intrinsic-stat");
  rerender(<DashboardCanvas {...props} editing={false} />);
  expect(screen.queryByTestId("saved-grid")).not.toBeInTheDocument();
  expect(JSON.stringify(dashboard)).toBe(before);
  expect(onLayout).not.toHaveBeenCalled();
});

it.each(["background", "side"] as const)("gives short %s sparkline stats natural phone flow without rewriting tall, desktop or editor layouts", async placement => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const dashboard = structuredClone(exampleDashboard);
  dashboard.widgets = dashboard.widgets.slice(0, 2).map((widget, index) => ({
    ...widget, unit: "requests per second per active worker", layout: { ...widget.layout, h: index ? 3 : 2 },
    options: { showSparkline: true, sparklinePlacement: placement, staleAfterSeconds: 10 },
  }));
  const before = JSON.stringify(dashboard);
  const fetcher = vi.fn().mockResolvedValue({ series: [
    { name: "primary", labels: {}, points: [{ timestamp: 3500000, value: 42 }, { timestamp: 3550000, value: null }] },
    { name: "secondary", labels: {}, points: [{ timestamp: 3500000, value: 17 }] },
  ] });
  const onLayout = vi.fn();
  const props = { dashboard, providers: exampleProviders, fetcher, end: 3600, onSelect: vi.fn(), onLayout };
  const { rerender } = render(<DashboardCanvas {...props} editing={false} />);
  const short = screen.getByRole("article", { name: "Request rate" });
  const tall = screen.getByRole("article", { name: "P95 latency" });
  await waitFor(() => expect(short.querySelector("[data-stat-sparkline]")).toBeInTheDocument());
  expect(short).toHaveAttribute("data-intrinsic-stat", "true");
  expect(short.parentElement?.style.height).toBe("");
  expect(tall).not.toHaveAttribute("data-intrinsic-stat");
  expect(tall.parentElement?.style.height).toBe("206px");
  expect(within(short).getByText(/Latest valid sample/)).toBeVisible();
  expect(within(short).getByText("Last valid · latest missing")).toBeVisible();
  expect(within(short).getByText(/before range end/)).toBeVisible();
  expect(within(short).getByText("secondary")).toBeVisible();
  expect(within(short).getAllByText("requests per second per active worker").length).toBeGreaterThan(0);
  rerender(<DashboardCanvas {...props} editing />);
  expect(screen.getByTestId("saved-grid")).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Request rate" })).not.toHaveAttribute("data-intrinsic-stat");
  viewport.width = 1100;
  rerender(<DashboardCanvas {...props} editing={false} />);
  expect(screen.getByTestId("saved-grid")).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Request rate" })).not.toHaveAttribute("data-intrinsic-stat");
  expect(JSON.stringify(dashboard)).toBe(before);
  expect(onLayout).not.toHaveBeenCalled();
});

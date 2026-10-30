import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DashboardCanvas } from "./canvas";
import { exampleDashboard, exampleProviders } from "./example";

vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="saved-grid">{children}</div>,
  useContainerWidth: () => ({ width: 320, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));
afterEach(() => vi.unstubAllGlobals());
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

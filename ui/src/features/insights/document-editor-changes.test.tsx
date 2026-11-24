import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./document-editor";
import { serializeDashboard, type Dashboard } from "./schema";

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "a",
  title: "Original",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [
    { id: "a", title: "Widget a", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 3, h: 3 } },
  ],
};

describe("dashboard source editor field changes", () => {
  it("lists the layout field that a moved widget changes", async () => {
    render(<DocumentEditor dashboard={dashboard} onApply={vi.fn()} onClose={vi.fn()} />);
    const next = { ...dashboard, widgets: [{ ...dashboard.widgets[0], layout: { x: 6, y: 0, w: 3, h: 3 } }] } as Dashboard;
    fireEvent.change(screen.getByLabelText("Dashboard source"), { target: { value: serializeDashboard(next, "yaml") } });
    expect(screen.getByText("Against the canvas: 0 added · 1 changed · 0 removed")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Widget a · moved/ }));
    expect(screen.getByText("layout.x")).toBeInTheDocument();
  });
});

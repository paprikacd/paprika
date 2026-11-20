import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardManager } from "./dashboard-library";
import type { BundleImportResult } from "./bundle-import";
import type { PortableImportProps } from "./portable-import-panel";
import { serializeDashboardLibrary } from "./workspace-transfer";
import type { Dashboard, Provider } from "./schema";

function dashboard(id: string, providerId: string): Dashboard {
  return {
    schemaVersion: 1,
    id,
    title: `Dashboard ${id}`,
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [
      {
        id: "widget",
        title: "Availability",
        type: "stat",
        providerId,
        query: "up",
        unit: "",
        layout: { x: 0, y: 0, w: 3, h: 3 },
      },
    ],
  };
}
const providers: Provider[] = [
  {
    id: "B",
    name: "Provider B",
    type: "prometheus",
    capabilities: ["metrics"],
  },
];

describe("dashboard library import forwarding", () => {
  it("forwards onImportBundle to the import panel and calls it for a reviewed import", async () => {
    const result: BundleImportResult = {
      added: 1,
      totalAdded: 1,
      failed: [],
      errors: [],
      queriesAdded: 0,
      queriesReused: 0,
      dashboardsKept: 0,
      dashboardsReplaced: 0,
      queriesReplaced: 0,
      complete: true,
    };
    const onImportBundle = vi
      .fn<PortableImportProps["onImportBundle"] & {}>()
      .mockResolvedValue(result);
    const active = dashboard("active", "B");
    render(
      <DashboardManager
        dashboard={active}
        dashboards={[active]}
        providers={providers}
        busy={false}
        onApply={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onImportBundle={onImportBundle}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Library import source"), {
      target: {
        value: serializeDashboardLibrary([dashboard("alpha", "A")], "yaml"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Connect A" }));
    fireEvent.click(screen.getByRole("option", { name: "Provider B" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0]).toMatchObject({
      bundle: { dashboards: [expect.objectContaining({ id: "alpha" })] },
      providerMapping: { A: "B" },
    });
  });
});

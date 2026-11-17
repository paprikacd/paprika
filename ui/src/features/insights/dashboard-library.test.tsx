import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardManager } from "./dashboard-library";
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
  {
    id: "C",
    name: "Provider C",
    type: "prometheus",
    capabilities: ["metrics"],
  },
];
function setup(
  onImport: (
    documents: Dashboard[],
  ) => Promise<{ added: number; failed: Dashboard[]; errors: string[] }>,
) {
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
      onImport={onImport}
      onClose={vi.fn()}
    />,
  );
}
function review(documents: Dashboard[]) {
  fireEvent.change(screen.getByLabelText("Library import source"), {
    target: { value: serializeDashboardLibrary(documents, "yaml") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
}

describe("dashboard library import retries", () => {
  it("preserves the original mapping on partial retry and does not resubmit successful dashboards", async () => {
    const onImport = vi
      .fn<
        (
          documents: Dashboard[],
        ) => Promise<{ added: number; failed: Dashboard[]; errors: string[] }>
      >()
      .mockImplementationOnce(async (documents) => ({
        added: 1,
        failed: [documents[0]],
        errors: ["Temporary failure"],
      }))
      .mockResolvedValueOnce({ added: 1, failed: [], errors: [] });
    setup(onImport);
    review([dashboard("alpha", "A"), dashboard("beta", "B")]);
    fireEvent.click(screen.getByRole("combobox", { name: "Connect A" }));
    fireEvent.click(screen.getByRole("option", { name: "Provider B" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Connect B" }));
    fireEvent.click(screen.getByRole("option", { name: "Provider C" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2 as new" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(
      onImport.mock.calls[0][0].map((item) => [
        item.id,
        item.widgets[0].providerId,
      ]),
    ).toEqual([
      ["alpha", "B"],
      ["beta", "C"],
    ]);
    const retry = await screen.findByRole("button", {
      name: "Import 1 as new",
    });
    expect(retry).toBeEnabled();
    expect(screen.queryByLabelText("Connect B")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Connect A" }),
    ).toHaveTextContent("Provider B");
    fireEvent.click(retry);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(
      onImport.mock.calls[1][0].map((item) => [
        item.id,
        item.widgets[0].providerId,
      ]),
    ).toEqual([["alpha", "B"]]);
    await waitFor(() =>
      expect(screen.queryByLabelText("Import review")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Library import source")).toHaveValue("");
  });

  it("keeps a failed import immediately retryable when the target provider was not an original source", async () => {
    const onImport = vi
      .fn<
        (
          documents: Dashboard[],
        ) => Promise<{ added: number; failed: Dashboard[]; errors: string[] }>
      >()
      .mockImplementationOnce(async (documents) => ({
        added: 0,
        failed: documents,
        errors: ["Temporary failure"],
      }))
      .mockResolvedValueOnce({ added: 1, failed: [], errors: [] });
    setup(onImport);
    review([dashboard("alpha", "A")]);
    fireEvent.click(screen.getByRole("combobox", { name: "Connect A" }));
    fireEvent.click(screen.getByRole("option", { name: "Provider C" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await screen.findByText("Temporary failure");
    expect(
      screen.getByRole("combobox", { name: "Connect A" }),
    ).toHaveTextContent("Provider C");
    const retry = screen.getByRole("button", { name: "Import 1 as new" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(onImport.mock.calls[1][0][0].widgets[0].providerId).toBe("C");
  });
});

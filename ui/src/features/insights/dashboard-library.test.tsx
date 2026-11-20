import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
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
        onDetailsChange={vi.fn()}
        onDetailsEnd={vi.fn()}
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

function managerProps(active: Dashboard) {
  return {
    dashboard: active,
    dashboards: [active],
    providers,
    busy: false,
    onApply: vi.fn(),
    onDetailsChange: vi.fn(),
    onDetailsEnd: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onImportBundle: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("dashboard manager details", () => {
  it("writes typed details to the draft as they change, with no Apply button", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    expect(screen.queryByRole("button", { name: "Apply dashboard details" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed" } });
    expect(props.onDetailsChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "active", title: "Renamed" }),
      "manage:title",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Notes" } });
    expect(props.onDetailsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Notes" }),
      "manage:description",
    );
  });

  it("shows an inline error for a blank name and keeps the last valid name in the draft", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "   " } });
    expect(props.onDetailsChange).not.toHaveBeenCalled();
    // The error shows while typing, but it is announced only once the field loses focus.
    expect(screen.getByText("Enter a name for this dashboard.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(screen.getByRole("textbox", { name: "Name" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name for this dashboard.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("   ");
  });

  it("treats a folder's trailing slash as pending while typing, and writes each completed segment", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    const folder = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.change(folder, { target: { value: "Ops/" } });
    expect(folder).toHaveValue("Ops/");
    expect(folder).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onDetailsChange).not.toHaveBeenCalled();
    fireEvent.change(folder, { target: { value: "Ops/Pay" } });
    expect(folder).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onDetailsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ folder: "Ops/Pay" }),
      "manage:folder",
    );
  });

  it("announces a folder error that is still unfinished when its field loses focus", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    const folder = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.change(folder, { target: { value: "Ops/" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // A genuine error (an empty middle segment) shows while typing but is not announced.
    fireEvent.change(folder, { target: { value: "Ops//Pay" } });
    expect(folder).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(folder, { target: { value: "Ops/" } });
    fireEvent.blur(folder);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(props.onDetailsChange).not.toHaveBeenCalledWith(expect.objectContaining({ folder: "Ops/" }), expect.anything());
    // The draft keeps the last valid folder: none was written.
    expect(folder).toHaveValue("Ops/");
  });

  it("keeps the picked folder in the draft when an existing folder is chosen from the list", () => {
    const folderDocument = { ...dashboard("filed", "B"), folder: "Ops/Payments" };
    const changes: Array<{ folder?: string; group: string }> = [];
    function Host() {
      const [active, setActive] = useState(dashboard("active", "B"));
      return (
        <DashboardManager
          {...managerProps(active)}
          dashboard={active}
          dashboards={[active, folderDocument]}
          onDetailsChange={(next, group) => {
            changes.push({ folder: next.folder, group });
            setActive(next);
          }}
        />
      );
    }
    render(<Host />);
    const folder = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.change(folder, { target: { value: "Ops/" } });
    fireEvent.change(folder, { target: { value: "Ops/P" } });
    fireEvent.click(screen.getByRole("option", { name: "Ops/Payments" }));
    expect(folder).toHaveValue("Ops/Payments");
    // Picking an option writes that folder once, and the field's search text is not written as a clear.
    expect(changes.at(-1)).toEqual({ folder: "Ops/Payments", group: "manage:folder" });
    expect(changes.some((change) => change.folder === undefined)).toBe(false);
  });

  it("announces an unfinished folder at once when it is committed from the list", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    const folder = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.change(folder, { target: { value: "Ops/" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Ops\// }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(props.onDetailsChange).not.toHaveBeenCalledWith(expect.objectContaining({ folder: "Ops/" }), expect.anything());
  });

  it("normalizes folder segments and groups folder edits under their own name", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), { target: { value: "Prod / Payments" } });
    expect(props.onDetailsChange).toHaveBeenCalledWith(
      expect.objectContaining({ folder: "Prod/Payments" }),
      "manage:folder",
    );
  });

  it("calls onDetailsEnd when a detail field loses focus", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    render(<DashboardManager {...props} />);
    fireEvent.blur(screen.getByRole("textbox", { name: "Name" }));
    expect(props.onDetailsEnd).toHaveBeenCalled();
  });

  it("shows a draft title changed elsewhere, such as by undo", () => {
    const active = dashboard("active", "B");
    const props = managerProps(active);
    const { rerender } = render(<DashboardManager {...props} />);
    rerender(<DashboardManager {...props} dashboard={{ ...active, title: "From undo" }} />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("From undo");
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./document-editor";
import {
  serializeDashboard,
  type Dashboard,
  type SavedQueryEntry,
} from "./schema";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import {
  downloadDocument,
  parseDashboardBundle,
  serializeDashboardBundle,
} from "./workspace-transfer";

vi.mock("./workspace-transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-transfer")>()),
  downloadDocument: vi.fn(),
}));

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "a",
  title: "Original",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
};

describe("dashboard source editor", () => {
  it("converts valid YAML edits to JSON and applies the same document", () => {
    const onApply = vi.fn();
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    const next = { ...dashboard, title: "Modified" };
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: serializeDashboard(next, "yaml") },
    });
    fireEvent.click(screen.getByRole("button", { name: /^JSON$/ }));
    expect(
      JSON.parse(
        (screen.getByLabelText("Dashboard source") as HTMLTextAreaElement)
          .value,
      ),
    ).toEqual(next);
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(onApply).toHaveBeenCalledWith(next);
  });

  it("does not apply malformed or aliased source", () => {
    const onApply = vi.fn();
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: 'title: &title "x"\ndescription: *title' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("protects newer canvas edits until the latest document is loaded", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    const next = { ...dashboard, title: "Updated canvas" };
    rerender(
      <DocumentEditor dashboard={next} onApply={onApply} onClose={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "Apply to canvas" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Load latest canvas" }));
    expect(screen.getByLabelText("Dashboard source")).toHaveValue(
      serializeDashboard(next, "yaml"),
    );
    expect(
      screen.getByRole("button", { name: "Apply to canvas" }),
    ).toBeEnabled();
  });

  it("exports the edited dashboard with its exact saved-query dependency and no transport metadata", () => {
    const query: SavedQueryEntry = {
      schemaVersion: 1,
      id: "available",
      name: "Availability",
      providerId: "metrics",
      kind: "metrics",
      query: "up",
      etag: '"latest"',
    };
    const linked: Dashboard = {
      ...dashboard,
      widgets: [
        {
          id: "stat",
          title: "Health",
          type: "stat",
          providerId: "metrics",
          query: "up",
          queryRef: { id: query.id },
          unit: "",
          layout: { x: 0, y: 0, w: 3, h: 3 },
        },
      ],
    };
    render(
      <SavedQueryLibraryProvider queries={[query]} variables={[]} values={{}}>
        <DocumentEditor
          dashboard={linked}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      </SavedQueryLibraryProvider>,
    );
    const edited = { ...linked, title: "Edited before export" };
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: serializeDashboard(edited, "yaml") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const output = vi.mocked(downloadDocument).mock.lastCall!;
    expect(parseDashboardBundle(output[0], "yaml")).toEqual({
      dashboards: [edited],
      savedQueries: [
        {
          schemaVersion: 1,
          id: "available",
          name: "Availability",
          providerId: "metrics",
          kind: "metrics",
          query: "up",
        },
      ],
    });
  });

  it("keeps unlinked exports as ordinary dashboard documents", () => {
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(vi.mocked(downloadDocument).mock.lastCall?.[0]).toBe(
      serializeDashboard(dashboard, "yaml"),
    );
  });

  it("routes bundle uploads through review and preserves the source draft behind it", async () => {
    const onApply = vi.fn();
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    const edited = serializeDashboard(
      { ...dashboard, title: "Unapplied draft" },
      "yaml",
    );
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: edited },
    });
    const source = serializeDashboardBundle(
      {
        dashboards: [
          { ...dashboard, id: "external", title: "External dashboard" },
        ],
        savedQueries: [],
      },
      "json",
    );
    fireEvent.change(screen.getByLabelText("Import dashboard document"), {
      target: {
        files: [
          {
            name: "bundle.json",
            size: source.length,
            text: async () => source,
          },
        ],
      },
    });
    await screen.findByRole("heading", { name: "Review dashboard import" });
    expect(
      screen.getByRole("heading", { name: "Review dashboard import" }),
    ).toHaveFocus();
    expect(screen.getByText("External dashboard")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to source" }));
    expect(screen.getByLabelText("Dashboard source")).toHaveValue(edited);
    expect(screen.getByLabelText("Dashboard source")).toHaveFocus();
  });

  it("routes pasted bundle Apply to review instead of silently dropping query definitions", () => {
    const onApply = vi.fn();
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: {
        value: serializeDashboardBundle(
          { dashboards: [dashboard], savedQueries: [] },
          "yaml",
        ),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(
      screen.getByRole("heading", { name: "Review dashboard import" }),
    ).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("reports the actionable bundle dependency error for invalid pasted bundles", () => {
    const onApply = vi.fn();
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^JSON$/ }));
    const source = JSON.stringify({
      kind: "PaprikaDashboardLibrary",
      schemaVersion: 1,
      dashboards: [
        {
          ...dashboard,
          widgets: [
            {
              id: "health",
              title: "Health",
              type: "stat",
              providerId: "metrics",
              query: "up",
              queryRef: { id: "missing-query" },
              unit: "",
              layout: { x: 0, y: 0, w: 3, h: 3 },
            },
          ],
        },
      ],
      savedQueries: [],
    });
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: source },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "references saved query “missing-query”, which is missing from the bundle",
    );
    expect(screen.getByLabelText("Dashboard source")).toHaveValue(source);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("ignores a stale file read after the user edits the source", async () => {
    let finish!: (value: string) => void;
    const read = new Promise<string>((resolve) => {
      finish = resolve;
    });
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Import dashboard document"), {
      target: { files: [{ name: "old.yaml", size: 100, text: () => read }] },
    });
    const edited = serializeDashboard(
      { ...dashboard, title: "Newer draft" },
      "yaml",
    );
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: edited },
    });
    await act(async () =>
      finish(serializeDashboard({ ...dashboard, title: "Old file" }, "yaml")),
    );
    expect(screen.getByLabelText("Dashboard source")).toHaveValue(edited);
  });

  it("preserves the source draft when a selected file cannot be read", async () => {
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Import dashboard document"), {
      target: {
        files: [
          {
            name: "failed.yaml",
            size: 100,
            text: async () => {
              throw new Error("Disk unavailable");
            },
          },
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Disk unavailable"),
    );
    expect(screen.getByLabelText("Dashboard source")).toHaveValue(
      serializeDashboard(dashboard, "yaml"),
    );
  });

  it("keeps the import review mounted while a write is pending", async () => {
    let finish!: (value: import("./bundle-import").BundleImportResult) => void;
    const pending = new Promise<import("./bundle-import").BundleImportResult>(
      (resolve) => {
        finish = resolve;
      },
    );
    const onClose = vi.fn();
    render(
      <DocumentEditor
        dashboard={dashboard}
        onApply={vi.fn()}
        onClose={onClose}
        onImportBundle={() => pending}
      />,
    );
    const source = serializeDashboardBundle(
      { dashboards: [dashboard], savedQueries: [] },
      "yaml",
    );
    fireEvent.change(screen.getByLabelText("Dashboard source"), {
      target: { value: source },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate document" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    expect(
      screen.getByRole("button", { name: "Back to source" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close source editor" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review a different document" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Close source editor" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    await act(async () =>
      finish({
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
      }),
    );
    expect(
      screen.getByRole("button", { name: "Back to source" }),
    ).toBeEnabled();
  });
});

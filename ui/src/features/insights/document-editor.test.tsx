import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentEditor } from "./document-editor";
import { parseCheckReport } from "./client";
import { CheckFinding, CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb";
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
    const reviewHeading = await screen.findByRole("heading", {
      name: "Review dashboard import",
    });
    await waitFor(() => expect(reviewHeading).toHaveFocus());
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

// The live bodies from internal/insights TestCheckWireGolden.
const checkGolden = JSON.parse(
  readFileSync(join(process.cwd(), "src/features/insights/testdata/checks-contract.golden.json"), "utf8"),
) as { save: Record<string, unknown>; checkedSave: Record<string, unknown> & { checks: Record<string, unknown> } };

describe("dashboard source checks", () => {
  it("is absent without a checker, and Apply stays local", () => {
    const onApply = vi.fn();
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Check" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(onApply).toHaveBeenCalledWith(dashboard);
  });

  it("runs the check on demand and lists its findings without blocking typing", async () => {
    const checkDocument = vi.fn().mockResolvedValue(parseCheckReport(checkGolden.save));
    render(<DocumentEditor dashboard={dashboard} onApply={vi.fn()} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const region = await screen.findByRole("region", { name: "Dashboard checks" });
    expect(within(region).getByText("2 errors")).toBeInTheDocument();
    expect(checkDocument).toHaveBeenCalledWith(expect.objectContaining({ id: "a", title: "Original" }), expect.any(AbortSignal));
    // Typing is never gated on the check.
    fireEvent.change(screen.getByLabelText("Dashboard source"), { target: { value: serializeDashboard({ ...dashboard, title: "Typing" }, "yaml") } });
    expect((screen.getByLabelText("Dashboard source") as HTMLTextAreaElement).value).toContain("Typing");
    expect(screen.queryByRole("region", { name: "Dashboard checks" })).not.toBeInTheDocument();
  });

  it("keeps a save the server would reject on the canvas draft, with its findings shown", async () => {
    const onApply = vi.fn();
    const checkDocument = vi.fn().mockResolvedValue(parseCheckReport(checkGolden.save));
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(await screen.findByRole("region", { name: "Dashboard checks" })).toBeInTheDocument();
    expect(checkDocument).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("applies after a check that has only warnings", async () => {
    const onApply = vi.fn();
    const checkDocument = vi.fn().mockResolvedValue(parseCheckReport(checkGolden.checkedSave.checks));
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(dashboard));
    // Warnings stay visible on the draft after it is applied.
    expect(within(screen.getByRole("region", { name: "Dashboard checks" })).getByText("1 warning")).toBeInTheDocument();
  });

  it("applies when the check itself is unavailable, and says so", async () => {
    const onApply = vi.fn();
    const checkDocument = vi.fn().mockRejectedValue(new Error("offline"));
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Could not check this dashboard: offline");
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(dashboard));
  });

  it("cancels a running check when the source is edited, and clears its findings", async () => {
    let signal: AbortSignal | undefined;
    const checkDocument = vi.fn((_: unknown, abort?: AbortSignal) => {
      signal = abort;
      return new Promise<never>(() => {});
    });
    render(<DocumentEditor dashboard={dashboard} onApply={vi.fn()} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Checking dashboard…")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Dashboard source"), { target: { value: serializeDashboard({ ...dashboard, title: "Edited" }, "yaml") } });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText("Checking dashboard…")).not.toBeInTheDocument();
  });
});

const widgetDashboard: Dashboard = {
  ...dashboard,
  widgets: [{ id: "a", title: "Widget a", type: "stat", providerId: "prometheus", query: "up", unit: "", layout: { x: 0, y: 0, w: 3, h: 3 } }],
};
const warning = new CheckReport({
  issues: [new CheckFinding({ ruleId: "stat.density", severity: Severity.WARNING, source: Source.LINT, widgetId: "a", pointer: "/widgets/0", message: "Too dense.", fix: "Remove one." })],
  total: 1,
  warningCount: 1,
});

describe("dashboard source checks: refusal, staleness and timing", () => {
  it("announces a refused apply and moves focus to the findings", async () => {
    const onApply = vi.fn();
    const checkDocument = vi.fn().mockResolvedValue(parseCheckReport(checkGolden.save));
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 errors. Fix them before applying."));
    expect(screen.getByRole("heading", { name: "2 errors" })).toHaveFocus();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("does not show a draft as valid after its check found errors, even on Validate", async () => {
    const checkDocument = vi.fn().mockResolvedValue(parseCheckReport(checkGolden.save));
    render(<DocumentEditor dashboard={dashboard} onApply={vi.fn()} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 errors"));
    fireEvent.click(screen.getByRole("button", { name: "Validate document" }));
    expect(screen.getByRole("status")).not.toHaveTextContent("Valid dashboard");
    expect(screen.getByRole("status")).toHaveTextContent("2 errors. Fix them before applying.");
  });

  it("does not apply an older draft over a canvas that changed during its check", async () => {
    let resolve!: (report: CheckReport) => void;
    const checkDocument = vi.fn(() => new Promise<CheckReport>((done) => { resolve = done; }));
    const onApply = vi.fn();
    const view = (current: Dashboard) => (
      <DocumentEditor dashboard={current} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />
    );
    const { rerender } = render(view(dashboard));
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    rerender(view({ ...dashboard, title: "Changed on canvas" }));
    expect(screen.getByText(/The canvas changed while this editor was open/)).toBeInTheDocument();
    await act(async () => { resolve(new CheckReport({})); });
    expect(onApply).not.toHaveBeenCalled();
  });

  it("gives up on a check that never settles after ten seconds, and lets Apply proceed", async () => {
    vi.useFakeTimers();
    try {
      const onApply = vi.fn();
      const checkDocument = vi.fn(() => new Promise<CheckReport>(() => {}));
      render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
      fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
      expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByRole("status")).toHaveTextContent("The check did not finish within 10 seconds.");
      expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeEnabled();
      expect(onApply).toHaveBeenCalledWith(dashboard);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies an identical draft on the answer it just received, without checking again", async () => {
    const checkDocument = vi.fn().mockResolvedValue(warning);
    const onApply = vi.fn();
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByRole("region", { name: "Dashboard checks" });
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(dashboard));
    expect(checkDocument).toHaveBeenCalledTimes(1);
  });

  it("waits for a check already running on the same draft instead of starting another", async () => {
    let resolve!: (report: CheckReport) => void;
    const checkDocument = vi.fn(() => new Promise<CheckReport>((done) => { resolve = done; }));
    const onApply = vi.fn();
    render(<DocumentEditor dashboard={dashboard} onApply={onApply} onClose={vi.fn()} checkDocument={checkDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect(checkDocument).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(new CheckReport({})); });
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(dashboard));
  });

  it("passes Show widget from a finding to the caller", async () => {
    const onFocusWidget = vi.fn();
    const checkDocument = vi.fn().mockResolvedValue(warning);
    render(
      <DocumentEditor dashboard={widgetDashboard} onApply={vi.fn()} onClose={vi.fn()} checkDocument={checkDocument} onFocusWidget={onFocusWidget} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show widget Widget a" }));
    expect(onFocusWidget).toHaveBeenCalledWith("a");
  });
});

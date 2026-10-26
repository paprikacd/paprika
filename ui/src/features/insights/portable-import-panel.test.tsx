import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortableImportPanel } from "./portable-import-panel";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import {
  serializeDashboardBundle,
  type DashboardBundle,
} from "./workspace-transfer";
import type {
  BundleImportRequest,
  BundleImportResult,
  BundleImportReview,
} from "./bundle-import";
import type { Dashboard, Provider, SavedQueryEntry } from "./schema";

const query: SavedQueryEntry = {
  schemaVersion: 1,
  id: "availability",
  name: "Service availability",
  providerId: "source",
  kind: "metrics",
  query: "up",
};
const document: Dashboard = {
  schemaVersion: 1,
  id: "imported",
  title: "Imported dashboard",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [
    {
      id: "health",
      title: "Health",
      type: "stat",
      providerId: "dormant",
      query: "old",
      queryRef: { id: query.id },
      unit: "",
      layout: { x: 0, y: 0, w: 3, h: 3 },
    },
  ],
};
const bundle: DashboardBundle = {
  dashboards: [document],
  savedQueries: [query],
};
const providers: Provider[] = [
  {
    id: "destination",
    name: "Production Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "alternative",
    name: "Other Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
];
const complete: BundleImportResult = {
  added: 1,
  totalAdded: 1,
  failed: [],
  errors: [],
  queriesAdded: 1,
  queriesReused: 0,
  dashboardsKept: 0,
  dashboardsReplaced: 0,
  queriesReplaced: 0,
  complete: true,
};
function renderPanel(
  onImportBundle = vi
    .fn<(request: BundleImportRequest) => Promise<BundleImportResult>>()
    .mockResolvedValue(complete),
  queries: SavedQueryEntry[] = [],
  initialBundle = bundle,
  onReviewBundle?: (bundle: DashboardBundle) => Promise<BundleImportReview>,
) {
  const view = (entries: SavedQueryEntry[]) => (
    <SavedQueryLibraryProvider queries={entries} variables={[]} values={{}}>
      <PortableImportPanel
        providers={providers}
        initialDocument={{
          source: serializeDashboardBundle(initialBundle, "yaml"),
          format: "yaml",
        }}
        onImportBundle={onImportBundle}
        onRefreshQueries={async () => {}}
        onReviewBundle={onReviewBundle}
      />
    </SavedQueryLibraryProvider>
  );
  const rendered = render(view(queries));
  return {
    onImportBundle,
    rerender: (entries: SavedQueryEntry[]) => rendered.rerender(view(entries)),
  };
}
function connect(name = "Production Prometheus") {
  fireEvent.click(screen.getByRole("combobox", { name: "Connect source" }));
  fireEvent.click(screen.getByRole("option", { name }));
}

describe("portable dashboard import review", () => {
  it("reviews query providers and preserves new query IDs without silently choosing copy", async () => {
    const { onImportBundle } = renderPanel();
    expect(
      screen.getByRole("button", { name: "Import 1 as new" }),
    ).toBeDisabled();
    connect();
    expect(
      screen.getByText(/New query. Its ID will be preserved/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0]).toMatchObject({
      bundle,
      providerMapping: { source: "destination" },
      queryChoices: {},
    });
    expect(onImportBundle.mock.calls[0][0].sessionId).toBeTruthy();
    await screen.findByText(/1 dashboard decision completed/);
    expect(screen.queryByLabelText("Import review")).not.toBeInTheDocument();
  });

  it("compares definitions after provider remapping and offers explicit copy for identical queries", async () => {
    const { onImportBundle } = renderPanel(undefined, [
      { ...query, providerId: "destination", etag: '"version"' },
    ]);
    connect();
    const choice = screen.getByRole("combobox", {
      name: "Import query Service availability",
    });
    expect(choice).toHaveTextContent("Keep existing");
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("option", { name: /^Create a copy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0].queryChoices).toEqual({
      availability: "copy",
    });
  });

  it("copies conflicting definitions and explains that existing queries are preserved", async () => {
    const { onImportBundle } = renderPanel(undefined, [
      { ...query, providerId: "destination", query: "up == 1" },
    ]);
    connect();
    expect(
      screen.getByText(/This ID belongs to a different query/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", {
        name: "Import query Service availability",
      }),
    ).toHaveTextContent("Create a copy");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0].queryChoices).toEqual({
      availability: "copy",
    });
  });

  it("keeps the full original bundle and session across partial retries while allowing mapping repair", async () => {
    const second = { ...document, id: "second", title: "Second dashboard" };
    const input = { ...bundle, dashboards: [document, second] };
    const onImport = vi
      .fn<(request: BundleImportRequest) => Promise<BundleImportResult>>()
      .mockResolvedValueOnce({
        added: 1,
        totalAdded: 1,
        failed: [second],
        errors: ["Connection changed"],
        queriesAdded: 1,
        queriesReused: 0,
        dashboardsKept: 0,
        dashboardsReplaced: 0,
        queriesReplaced: 0,
        complete: false,
      })
      .mockResolvedValueOnce({ ...complete, totalAdded: 2 });
    renderPanel(onImport, [], input);
    connect();
    fireEvent.click(screen.getByRole("button", { name: "Import 2 as new" }));
    await screen.findByText("Connection changed");
    expect(
      screen.getByText(/Changes apply to remaining dashboards/),
    ).toBeInTheDocument();
    connect("Other Prometheus");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(onImport.mock.calls[1][0].sessionId).toBe(
      onImport.mock.calls[0][0].sessionId,
    );
    expect(onImport.mock.calls[1][0].bundle).toEqual(input);
    expect(onImport.mock.calls[1][0].providerMapping).toEqual({
      source: "alternative",
    });
  });

  it("refreshes a failed query review without losing its retry session", async () => {
    const onImport = vi
      .fn<(request: BundleImportRequest) => Promise<BundleImportResult>>()
      .mockResolvedValueOnce({
        ...complete,
        added: 0,
        totalAdded: 0,
        failed: [document],
        errors: ["Saved query changed"],
        complete: false,
      })
      .mockResolvedValueOnce(complete);
    const { rerender } = renderPanel(onImport, [
      { ...query, providerId: "destination" },
    ]);
    connect();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await screen.findByText("Saved query changed");
    rerender([{ ...query, providerId: "destination", query: "rate(up[5m])" }]);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh query library" }),
    );
    await screen.findByText(/Comparison refreshed/);
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(onImport.mock.calls[1][0].sessionId).toBe(
      onImport.mock.calls[0][0].sessionId,
    );
    expect(onImport.mock.calls[1][0].queryChoices).toEqual({
      availability: "copy",
    });
  });

  it("does not submit stale reuse when the visible review now requires a copy", async () => {
    const { onImportBundle, rerender } = renderPanel(undefined, [
      { ...query, providerId: "destination" },
    ]);
    connect();
    expect(
      screen.getByRole("combobox", {
        name: "Import query Service availability",
      }),
    ).toHaveTextContent("Keep existing");
    rerender([{ ...query, providerId: "destination", query: "up == 1" }]);
    expect(
      screen.getByText(/This ID belongs to a different query/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0].queryChoices).toEqual({
      availability: "copy",
    });
  });
});

function choose(label: string, value: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(
    screen.getByRole("option", { name: new RegExp(`^${value}`) }),
  );
}
async function waitForComparison() {
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", {
        name: "Import dashboard Imported dashboard",
      }),
    ).toBeEnabled(),
  );
}
const currentQuery = { ...query, providerId: "destination", query: "up == 1" };
const saved = (
  overrides: Partial<BundleImportReview> = {},
): BundleImportReview => ({
  dashboards: [
    {
      document: { ...document, title: "Saved dashboard" },
      etag: '"dashboard-v1"',
    },
  ],
  queries: [{ document: currentQuery, etag: '"query-v1"' }],
  ...overrides,
});

describe("reviewed import decisions", () => {
  it("never defaults to Replace, sends authoritative revisions, and shows all affected dashboards", async () => {
    const external = { ...document, id: "external", title: "On-call overview" };
    const onReview = vi
      .fn()
      .mockResolvedValue(
        saved({ dashboards: [...saved().dashboards, { document: external }] }),
      );
    const { onImportBundle } = renderPanel(undefined, [], bundle, onReview);
    await waitForComparison();
    connect();
    expect(
      screen.getByRole("combobox", {
        name: "Import dashboard Imported dashboard",
      }),
    ).toHaveTextContent("Create a copy");
    expect(
      screen.getByRole("combobox", {
        name: "Import query Service availability",
      }),
    ).toHaveTextContent("Create a copy");
    choose("Import dashboard Imported dashboard", "Replace existing");
    choose("Import query Service availability", "Replace existing");
    const impact = screen.getByRole("note", {
      name: "Replacement impact for Service availability",
    });
    expect(within(impact).getByText("Saved dashboard")).toBeInTheDocument();
    expect(within(impact).getByText("On-call overview")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Apply import choices" }),
    );
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0]).toMatchObject({
      dashboardChoices: { imported: "replace" },
      queryChoices: { availability: "replace" },
      dashboardBaselines: {
        imported: { etag: '"dashboard-v1"', fingerprint: expect.any(String) },
      },
      queryBaselines: {
        availability: { etag: '"query-v1"', fingerprint: expect.any(String) },
      },
    });
  });

  it("keeps a dashboard without requiring or importing any of its incoming query dependencies", async () => {
    const { onImportBundle } = renderPanel(undefined, [], bundle, async () =>
      saved(),
    );
    await waitForComparison();
    choose("Import dashboard Imported dashboard", "Keep existing");
    expect(
      screen.queryByRole("combobox", { name: "Connect source" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Saved query review"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Apply import choices" }),
    );
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0]).toMatchObject({
      dashboardChoices: { imported: "keep" },
      queryChoices: {},
      providerMapping: {},
    });
  });

  it("offers Keep before an unavailable incoming source is mapped and still compares the original incoming definition", async () => {
    const { onImportBundle } = renderPanel(undefined, [], bundle, async () =>
      saved(),
    );
    await waitForComparison();
    choose("Import query Service availability", "Keep existing");
    expect(
      screen.queryByRole("combobox", { name: "Connect source" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Compare changes for Service availability/,
      }),
    );
    const comparison = screen.getByRole("region", {
      name: /Compare changes for Service availability/,
    });
    expect(within(comparison).getByText('"source"')).toBeInTheDocument();
    expect(within(comparison).getByText('"destination"')).toBeInTheDocument();
    expect(within(comparison).getByText('"up"')).toBeInTheDocument();
    expect(within(comparison).getByText('"up == 1"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0].queryChoices).toEqual({
      availability: "keep",
    });
  });

  it("preserves explicit Replace when mapping a provider and blocks incompatible query replacement", async () => {
    renderPanel(undefined, [], bundle, async () => saved());
    await waitForComparison();
    choose("Import dashboard Imported dashboard", "Replace existing");
    connect();
    expect(
      screen.getByRole("combobox", {
        name: "Import dashboard Imported dashboard",
      }),
    ).toHaveTextContent("Replace existing");
    choose("Import query Service availability", "Replace existing");
    connect("Other Prometheus");
    expect(
      screen.getByRole("combobox", {
        name: "Import dashboard Imported dashboard",
      }),
    ).toHaveTextContent("Replace existing");
    expect(
      screen.getByRole("combobox", {
        name: "Import query Service availability",
      }),
    ).toHaveTextContent("Replace existing");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "data source and kind cannot be replaced",
    );
    expect(
      screen.getByRole("button", { name: "Apply import choices" }),
    ).toBeDisabled();
  });

  it("refreshes stale revisions, clears Replace consent, and preserves the same retry session", async () => {
    const onImport = vi
      .fn<(request: BundleImportRequest) => Promise<BundleImportResult>>()
      .mockRejectedValueOnce(new Error("Dashboard changed after review"))
      .mockResolvedValueOnce(complete);
    const onReview = vi
      .fn()
      .mockResolvedValueOnce(saved())
      .mockResolvedValueOnce(
        saved({
          dashboards: [{ document, etag: '"dashboard-v2"' }],
          queries: [{ document: currentQuery, etag: '"query-v2"' }],
        }),
      );
    renderPanel(onImport, [], bundle, onReview);
    await waitForComparison();
    connect();
    choose("Import dashboard Imported dashboard", "Replace existing");
    choose("Import query Service availability", "Replace existing");
    fireEvent.click(
      screen.getByRole("button", { name: "Apply import choices" }),
    );
    await screen.findByText("Dashboard changed after review");
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await screen.findByText(/Comparison refreshed/);
    expect(
      screen.getByRole("combobox", {
        name: "Import dashboard Imported dashboard",
      }),
    ).toHaveTextContent("Keep existing");
    choose("Import dashboard Imported dashboard", "Replace existing");
    expect(
      screen.getByRole("combobox", {
        name: "Import query Service availability",
      }),
    ).toHaveTextContent("Create a copy");
    choose("Import query Service availability", "Replace existing");
    fireEvent.click(
      screen.getByRole("button", { name: "Apply import choices" }),
    );
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(onImport.mock.calls[1][0].sessionId).toBe(
      onImport.mock.calls[0][0].sessionId,
    );
    expect(onImport.mock.calls[1][0].dashboardBaselines?.imported.etag).toBe(
      '"dashboard-v2"',
    );
    expect(onImport.mock.calls[1][0].queryBaselines?.availability.etag).toBe(
      '"query-v2"',
    );
  });

  it("keeps typed zero, false, null, and absent fields distinct in the expandable diff", async () => {
    const current: Dashboard = {
      ...document,
      widgets: [
        {
          ...document.widgets[0],
          type: "plugin",
          pluginId: "gauge",
          dataKind: "metrics",
          config: { count: 0, enabled: false, empty: null },
        },
      ],
    };
    const incoming: Dashboard = {
      ...current,
      widgets: [
        {
          ...current.widgets[0],
          config: { count: 1, enabled: true, empty: "", added: 0 },
        },
      ],
    };
    renderPanel(
      undefined,
      [],
      { ...bundle, dashboards: [incoming] },
      async () => saved({ dashboards: [{ document: current, etag: '"old"' }] }),
    );
    await waitForComparison();
    expect(
      screen.queryByText("widgets[id=health].config.enabled"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Compare changes for Imported dashboard/,
      }),
    );
    const comparison = screen.getByRole("region", {
      name: /Compare changes for Imported dashboard/,
    });
    expect(
      within(comparison).getByText("widgets[id=health].config.enabled"),
    ).toBeInTheDocument();
    const before = within(comparison)
      .getAllByLabelText("Current value")
      .map((element) => element.textContent);
    expect(before).toEqual(
      expect.arrayContaining(["0", "false", "null", "Not present"]),
    );
    expect(
      within(comparison)
        .getAllByLabelText("Incoming value")
        .map((element) => element.textContent),
    ).toContain('""');
  });

  it("lets a new query explicitly create a copy and does not read inherited ID properties as actions", async () => {
    const unusual = { ...query, id: "constructor" };
    const input = {
      dashboards: [
        {
          ...document,
          id: "constructor",
          widgets: [
            { ...document.widgets[0], queryRef: { id: "constructor" } },
          ],
        },
      ],
      savedQueries: [unusual],
    };
    const { onImportBundle } = renderPanel(undefined, [], input);
    connect();
    expect(
      screen.getByRole("combobox", {
        name: "Import query Service availability",
      }),
    ).toHaveTextContent("Create query");
    choose("Import query Service availability", "Create a copy");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledOnce());
    expect(onImportBundle.mock.calls[0][0]).toMatchObject({
      dashboardChoices: { constructor: "copy" },
      queryChoices: { constructor: "copy" },
    });
  });

  it("locks copy destinations only after a reported write attempt while retaining Keep-to-Replace recovery", async () => {
    const second = { ...document, id: "second", title: "Second dashboard" };
    const onImport = vi
      .fn<(request: BundleImportRequest) => Promise<BundleImportResult>>()
      .mockResolvedValue({
        ...complete,
        complete: false,
        failed: [document, second],
        totalAdded: 0,
        dashboardTargetsLocked: true,
      });
    renderPanel(
      onImport,
      [],
      { ...bundle, dashboards: [document, second] },
      async () =>
        saved({
          dashboards: [
            ...saved().dashboards,
            { document: second, etag: '"second"' },
          ],
        }),
    );
    await waitForComparison();
    connect();
    choose("Import dashboard Imported dashboard", "Replace existing");
    fireEvent.click(
      screen.getByRole("button", { name: "Apply import choices" }),
    );
    await screen.findByText(/Dashboard copy destinations are fixed/);
    fireEvent.click(
      screen.getByRole("combobox", {
        name: "Import dashboard Imported dashboard",
      }),
    );
    expect(
      screen.getByRole("option", { name: /^Create a copy/ }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("option", { name: /^Keep existing/ }));
    fireEvent.click(
      screen.getByRole("combobox", {
        name: "Import dashboard Second dashboard",
      }),
    );
    expect(
      screen.getByRole("option", { name: /^Replace existing/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("option", { name: /^Keep existing/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("ignores a late saved snapshot after a new source review replaces it", async () => {
    let finish!: (value: BundleImportReview) => void;
    const old = new Promise<BundleImportReview>((resolve) => {
      finish = resolve;
    });
    const onReview = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ dashboards: [], queries: [] });
    const rendered = render(
      <PortableImportPanel
        providers={providers}
        onReviewBundle={onReview}
        initialDocument={{
          source: serializeDashboardBundle(bundle, "json"),
          format: "json",
        }}
      />,
    );
    // Closing the old Code review unmounts it while its saved-version request is pending.
    rendered.unmount();
    render(
      <PortableImportPanel
        providers={providers}
        onReviewBundle={onReview}
        initialDocument={{
          source: serializeDashboardBundle(bundle, "json"),
          format: "json",
        }}
      />,
    );
    await waitForComparison();
    await act(async () => finish(saved()));
    expect(screen.getByText(/New dashboard/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Compare changes for Imported dashboard/,
      }),
    ).not.toBeInTheDocument();
  });
});

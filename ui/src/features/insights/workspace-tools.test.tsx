import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dashboardRange, TimeRangeControl } from "./time-range";
import { dashboardTree, DashboardTree } from "./dashboard-library";
import {
  parseDashboardLibrary,
  remapDashboardProviders,
  requiredProviders,
  serializeDashboardLibrary,
} from "./workspace-transfer";
import type { Dashboard } from "./schema";
import { exampleDashboard, exampleProviders } from "./example";

describe("portable dashboard workspaces", () => {
  it.each(["json", "yaml"] as const)(
    "round-trips folders, chart settings, and absolute dates through a %s library",
    (format) => {
      const documents = [
        {
          ...exampleDashboard,
          customTimeRange: {
            from: "2026-10-20T12:00:00Z",
            to: "2026-10-20T13:00:00Z",
          },
        },
      ];
      expect(
        parseDashboardLibrary(
          serializeDashboardLibrary(documents, format),
          format,
        ),
      ).toEqual(documents);
    },
  );
  it("accepts a single dashboard but rejects ambiguous or unsafe libraries", () => {
    expect(
      parseDashboardLibrary(JSON.stringify(exampleDashboard), "json"),
    ).toEqual([exampleDashboard]);
    expect(() =>
      parseDashboardLibrary(
        serializeDashboardLibrary([exampleDashboard, exampleDashboard], "json"),
        "json",
      ),
    ).toThrow(/Duplicate dashboard ID/);
    expect(() =>
      parseDashboardLibrary(
        "x: &a []\nkind: PaprikaDashboardLibrary\nschemaVersion: 1\ndashboards: *a",
        "yaml",
      ),
    ).toThrow();
    expect(() =>
      parseDashboardLibrary(
        JSON.stringify({
          kind: "PaprikaDashboardLibrary",
          schemaVersion: 1,
          dashboards: [],
          script: "alert(1)",
        }),
        "json",
      ),
    ).toThrow();
  });
  it("requires a compatible provider for every imported widget and does not mutate the input", () => {
    const imported = {
      ...exampleDashboard,
      widgets: exampleDashboard.widgets.map((widget) => ({
        ...widget,
        providerId: widget.type === "traces" ? "old-tempo" : "old-prom",
      })),
    };
    expect(() =>
      remapDashboardProviders(
        [imported],
        { "old-tempo": "example-prometheus", "old-prom": "example-prometheus" },
        exampleProviders,
      ),
    ).toThrow(/compatible/);
    const [mapped] = remapDashboardProviders(
      [imported],
      { "old-tempo": "example-tempo", "old-prom": "example-prometheus" },
      exampleProviders,
    );
    expect(mapped.widgets).toEqual(exampleDashboard.widgets);
    expect(imported.widgets[0].providerId).toBe("old-prom");
  });
  it("preserves dormant custom providers for linked widgets while remapping active custom tooltip providers", () => {
    const document: Dashboard = {
      ...exampleDashboard,
      widgets: [
        {
          ...exampleDashboard.widgets[0],
          providerId: "unavailable-draft",
          query: "retained_custom_query",
          queryRef: { id: "shared" },
          options: {
            tooltipView: {
              type: "traces",
              source: { type: "query", providerId: "old-tempo", query: "{}" },
            },
          },
        },
      ],
    };
    const original = structuredClone(document);
    expect([...requiredProviders([document])]).toEqual([
      ["old-tempo", new Set(["traces"])],
    ]);
    expect(() =>
      remapDashboardProviders([document], {}, exampleProviders),
    ).toThrow(/tooltip provider old-tempo/);
    const mapped = remapDashboardProviders(
      [document],
      {
        "unavailable-draft": "example-prometheus",
        "old-tempo": "example-tempo",
      },
      exampleProviders,
    )[0];
    expect(mapped.widgets[0]).toMatchObject({
      providerId: "unavailable-draft",
      query: "retained_custom_query",
      queryRef: { id: "shared" },
      options: { tooltipView: { source: { providerId: "example-tempo" } } },
    });
    expect(document).toEqual(original);
    const linkedOnly: Dashboard = {
      ...document,
      widgets: [
        {
          ...document.widgets[0],
          options: {
            tooltipView: {
              type: "stat",
              source: { type: "saved", ref: { id: "child" } },
            },
          },
        },
      ],
    };
    expect(requiredProviders([linkedOnly]).size).toBe(0);
    expect(remapDashboardProviders([linkedOnly], {}, [])).toEqual([linkedOnly]);
  });
  it("builds a sorted nested filetree and searches folder paths", () => {
    const documents = [
      {
        ...exampleDashboard,
        id: "a",
        title: "Workers",
        folder: "Production/Payments",
      },
      {
        ...exampleDashboard,
        id: "b",
        title: "API",
        folder: "Production/Payments",
      },
      { ...exampleDashboard, id: "c", title: "Root", folder: undefined },
    ];
    expect(
      dashboardTree(documents).folders[0].folders[0].dashboards.map(
        (item) => item.title,
      ),
    ).toEqual(["API", "Workers"]);
    expect(dashboardTree(documents, "payments").dashboards).toEqual([]);
    const open = vi.fn();
    render(
      <DashboardTree
        dashboards={documents}
        activeId="b"
        search=""
        onOpen={open}
        onMove={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "API" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Production" }));
    expect(
      screen.queryByRole("button", { name: "API" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Production" }));
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    expect(open).toHaveBeenCalledWith(documents[0]);
  });
});

describe("absolute date ranges", () => {
  it("uses exact UTC bounds instead of a moving preset", () => {
    const dashboard = {
      ...exampleDashboard,
      customTimeRange: {
        from: "2026-10-20T12:00:00Z",
        to: "2026-10-20T13:00:00Z",
      },
    };
    expect(dashboardRange(dashboard, 42)).toEqual({
      start: 1792497600,
      end: 1792501200,
    });
    expect(dashboardRange(exampleDashboard, 10000)).toEqual({
      start: 6400,
      end: 10000,
    });
  });
  it("validates custom ranges and removes fixed dates when a preset is selected", () => {
    const change = vi.fn();
    render(<TimeRangeControl dashboard={exampleDashboard} onChange={change} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose custom time range" }),
    );
    fireEvent.change(screen.getByLabelText("Range start"), {
      target: { value: "2026-10-20T12:00" },
    });
    fireEvent.change(screen.getByLabelText("Range end"), {
      target: { value: "2026-10-19T12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply time range" }));
    expect(screen.getByRole("alert")).toHaveTextContent("end after the start");
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Range end"), {
      target: { value: "2026-10-20T13:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply time range" }));
    expect(change).toHaveBeenCalledWith({
      timeRange: "1h",
      customTimeRange: {
        from: new Date("2026-10-20T12:00").toISOString(),
        to: new Date("2026-10-20T13:00").toISOString(),
      },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Time range" }));
    fireEvent.click(screen.getByRole("option", { name: "Last 24 hours" }));
    expect(change).toHaveBeenLastCalledWith({
      timeRange: "24h",
      customTimeRange: undefined,
    });
  });
});

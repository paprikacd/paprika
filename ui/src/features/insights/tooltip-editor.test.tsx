import { changeQueryEditor, readQueryEditor } from "./query-code-editor.test-utils";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipEditor } from "./tooltip-editor";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import { registerWidgetPlugin } from "./widget-registry";
import type { Provider, TooltipView, Widget, SavedQuery } from "./schema";

const providers: Provider[] = [
  {
    id: "other",
    name: "Other metrics",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "metrics",
    name: "Production metrics",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "traces",
    name: "Production traces",
    type: "tempo",
    capabilities: ["traces"],
  },
];
function Harness({
  initial,
  sources = providers,
  hostType,
}: {
  initial?: TooltipView;
  sources?: Provider[];
  hostType?: Widget["type"];
}) {
  const [view, setView] = useState(initial);
  const [pluginConfig, setPluginConfig] = useState(
    JSON.stringify(initial?.config ?? {}, null, 2),
  );
  return (
    <>
      <TooltipEditor
        view={view}
        providers={sources}
        parentProviderId="metrics"
        parentColor="#123456"
        hostType={hostType}
        onChange={setView}
        pluginConfig={pluginConfig}
        onPluginConfigChange={setPluginConfig}
      />
      <output aria-label="Tooltip draft">{JSON.stringify(view ?? null)}</output>
    </>
  );
}
function choose(name: string, label: string | RegExp) {
  const control = screen.getByRole("combobox", { name });
  fireEvent.click(control);
  fireEvent.click(screen.getByRole("option", { name: label }));
  expect(control).toHaveFocus();
}
function draft(): TooltipView | null {
  return JSON.parse(screen.getByLabelText("Tooltip draft").textContent!);
}

describe("tooltip editor", () => {
  it("offers a direct saved-query entry and an action to create an empty library", () => {
    const onOpenExplorer = vi.fn();
    render(<SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onOpenExplorer={onOpenExplorer}><Harness /></SavedQueryLibraryProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Use saved query" }));
    expect(draft()).toEqual({ type: "timeseries", source: { type: "saved", ref: { id: "" } } });
    expect(screen.getByText(/No saved metrics queries yet/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create saved query" }));
    expect(onOpenExplorer).toHaveBeenCalledOnce();
    expect(screen.getByText(/Your widget draft stays intact/)).toBeVisible();
  });

  it("distinguishes loading, errors and empty results while retaining an unavailable reference", async () => {
    const onRefresh = vi.fn().mockRejectedValueOnce(new Error("Library temporarily unavailable")).mockResolvedValueOnce(undefined);
    const initial: TooltipView = { type: "stat", source: { type: "saved", ref: { id: "retained", bindings: [{ parameter: "service", source: "label", label: "app" }] } } };
    const content = (loading: boolean) => <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} loading={loading} onRefresh={onRefresh}><Harness initial={initial} /></SavedQueryLibraryProvider>;
    const view = render(content(true));
    expect(screen.getByText("Loading saved queries…")).toBeVisible();
    expect(screen.queryByText(/No saved metrics queries/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Tooltip saved query" })).toBeDisabled();
    view.rerender(content(false));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh saved queries" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Library temporarily unavailable");
    expect(screen.queryByText(/No saved metrics queries/)).not.toBeInTheDocument();
    expect(draft()).toEqual(initial);
    // A newer library snapshot (for example after returning from Explore)
    // supersedes the failed refresh without discarding the tooltip draft.
    view.rerender(content(false));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(draft()).toEqual(initial);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh saved queries" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(draft()).toEqual(initial);
  });

  it("offers sparkline only for Single value and retains it when changing visualization", () => {
    render(<Harness initial={{ type: "timeseries", source: { type: "widget" } }} />);
    expect(screen.queryByRole("switch", { name: "Show sparkline" })).not.toBeInTheDocument();
    choose("Tooltip visualization", "Single value");
    expect(screen.getByRole("switch", { name: "Show sparkline" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Show sparkline" }));
    choose("Tooltip visualization", "Bar chart");
    expect(screen.queryByRole("switch", { name: "Show sparkline" })).not.toBeInTheDocument();
    choose("Tooltip visualization", "Single value");
    expect(screen.getByRole("switch", { name: "Show sparkline" })).toBeChecked();
    expect(draft()).toMatchObject({ type: "stat", showSparkline: true, source: { type: "widget" } });
  });
  it("makes full existing widget data explicit and preserves legacy hovered-series selection", () => {
    render(<Harness initial={{ type: "timeseries" }} />);
    choose("Tooltip data source", "Existing widget query data");
    expect(draft()?.source).toEqual({ type: "widget" });
    expect(screen.getByText(/complete result already fetched/)).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Show tooltip legend" }),
    ).toBeChecked();
    choose("Tooltip data source", "Hovered series");
    expect(draft()?.source).toBeUndefined();
    expect(
      screen.getByRole("switch", { name: "Show tooltip legend" }),
    ).not.toBeChecked();
  });
  it("links saved tooltip parameters to hovered labels and dashboard variables without changing the custom draft", () => {
    const saved: SavedQuery = {
      schemaVersion: 1,
      id: "shared",
      name: "Shared metric",
      providerId: "metrics",
      kind: "metrics",
      query: "up{service={{service}},env={{environment}}}",
      parameters: [
        { name: "service", type: "string" },
        { name: "environment", type: "string" },
      ],
    };
    render(
      <SavedQueryLibraryProvider
        queries={[saved]}
        variables={[{ name: "environment" }]}
        values={{ environment: "prod" }}
      >
        <Harness
          initial={{
            type: "stat",
            source: {
              type: "query",
              providerId: "metrics",
              query: "custom_query",
            },
          }}
        />
      </SavedQueryLibraryProvider>,
    );
    choose("Tooltip data source", "Saved query");
    choose("Tooltip saved query", /^Shared metric/);
    choose("Value for service from", "Observation label");
    choose("Value for environment from", "Dashboard variable");
    const linked = draft()?.source;
    choose("Tooltip saved query", /^Shared metric/);
    expect(draft()?.source).toEqual(linked);
    fireEvent.click(screen.getByRole("switch", { name: "Show sparkline" }));
    expect(draft()?.source).toEqual(linked);
    expect(draft()?.showSparkline).toBe(true);
    expect(draft()?.source).toEqual({
      type: "saved",
      ref: {
        id: "shared",
        bindings: [
          { parameter: "service", source: "label", label: "service" },
          {
            parameter: "environment",
            source: "variable",
            variable: "environment",
          },
        ],
      },
    });
    expect(
      screen.getByLabelText("Tooltip saved query template"),
    ).toHaveAttribute("readonly");
    fireEvent.click(
      screen.getByRole("button", { name: "Use custom tooltip query" }),
    );
    expect(draft()?.source).toEqual({
      type: "query",
      providerId: "metrics",
      query: "custom_query",
    });
    choose("Tooltip data source", "Saved query");
    expect(draft()?.source).toMatchObject({
      type: "saved",
      ref: { id: "shared", bindings: expect.any(Array) },
    });
  });

  it("authors typed context mappings and restores a label draft when changing its source", () => {
    render(
      <Harness
        hostType="timeseries"
        initial={{
          type: "bar",
          source: {
            type: "query",
            providerId: "metrics",
            query: "up{service={{service}}}",
            bindings: [{ variable: "service", label: "service_name" }],
          },
        }}
      />,
    );
    choose("Tooltip mapping 1 source", "Value");
    expect(draft()?.source).toMatchObject({
      bindings: [{ variable: "service", field: "value" }],
    });
    expect(
      screen.queryByLabelText("Tooltip mapping 1 hovered label"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/hovered point’s exact numeric value/),
    ).toBeVisible();
    choose("Tooltip mapping 1 source", "Timestamp");
    expect(draft()?.source).toMatchObject({
      bindings: [{ variable: "service", field: "timestamp" }],
    });
    expect(
      screen.getByText(/Unix seconds, including fractional seconds/),
    ).toBeVisible();
    choose("Tooltip mapping 1 source", "Series");
    expect(draft()?.source).toMatchObject({
      bindings: [{ variable: "service", field: "series" }],
    });
    choose("Tooltip mapping 1 source", "Label");
    expect(
      screen.getByLabelText("Tooltip mapping 1 hovered label"),
    ).toHaveValue("service_name");
    expect(draft()?.source).toMatchObject({
      bindings: [{ variable: "service", label: "service_name" }],
    });
  });

  it("removes a mapping without restoring another row's cached label", () => {
    render(
      <Harness
        initial={{
          type: "stat",
          source: {
            type: "query",
            providerId: "metrics",
            query: "up",
            bindings: [
              { variable: "first", label: "service" },
              { variable: "second", label: "region" },
            ],
          },
        }}
      />,
    );
    choose("Tooltip mapping 1 source", "Value");
    choose("Tooltip mapping 2 source", "Timestamp");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove tooltip mapping 1" }),
    );
    choose("Tooltip mapping 1 source", "Label");
    expect(draft()?.source).toMatchObject({
      bindings: [{ variable: "second", label: "region" }],
    });
  });

  it("shows the inherited color and can return an override to that default", () => {
    render(<Harness initial={{ type: "timeseries" }} />);
    const color = screen.getByLabelText("Tooltip series color");
    expect(color).toHaveValue("#123456");
    fireEvent.change(color, { target: { value: "#abcdef" } });
    expect(draft()?.color).toBe("#abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Use widget color" }));
    expect(draft()?.color).toBeUndefined();
    expect(color).toHaveValue("#123456");
  });
  it("preserves details-only defaults and exposes controls only for the chosen visualization", () => {
    render(<Harness />);
    expect(
      screen.getByRole("button", { name: "Add tooltip widget" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("combobox", { name: "Tooltip visualization" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add tooltip widget" }));
    expect(draft()).toEqual({ type: "timeseries" });
    expect(
      screen.getByRole("switch", { name: "Show tooltip legend" }),
    ).not.toBeChecked();
    choose("Tooltip chart height", "Tall");
    fireEvent.click(
      screen.getByRole("switch", { name: "Show tooltip chart axes" }),
    );
    choose("Tooltip visualization", "Single value");
    expect(
      screen.queryByRole("switch", { name: "Show tooltip chart axes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Show tooltip legend" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Tooltip unit" })).toBeVisible();
    expect(draft()).toMatchObject({
      type: "stat",
      height: 320,
      showAxis: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove tooltip widget" }),
    );
    expect(draft()).toBeNull();
  });

  it("retains authored provider queries and mappings when changing data modes", () => {
    render(<Harness initial={{ type: "timeseries" }} />);
    choose("Tooltip data source", "Provider query");
    expect(
      screen.getByRole("combobox", { name: "Tooltip provider" }),
    ).toHaveTextContent("Production metrics");
    expect(readQueryEditor(screen.getByRole("textbox", { name: "Tooltip PromQL query" }))).toBe("");
    changeQueryEditor(screen.getByRole("textbox", { name: "Tooltip PromQL query" }), "rate(requests_total{service={{service}}}[5m])");
    fireEvent.click(screen.getByRole("button", { name: "Add query mapping" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Tooltip mapping 1 variable" }),
      { target: { value: "service" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Tooltip mapping 1 hovered label" }),
      { target: { value: "service_name" } },
    );
    choose("Tooltip data source", "Hovered series");
    expect(draft()?.source).toBeUndefined();
    choose("Tooltip data source", "Provider query");
    expect(draft()?.source).toEqual({
      type: "query",
      providerId: "metrics",
      query: "rate(requests_total{service={{service}}}[5m])",
      bindings: [{ variable: "service", label: "service_name" }],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove tooltip mapping 1" }),
    );
    expect(
      screen.queryByRole("textbox", { name: "Tooltip mapping 1 variable" }),
    ).not.toBeInTheDocument();
  });

  it("requires a query for traces and restores the correct draft across data kinds", () => {
    render(
      <Harness
        initial={{
          type: "bar",
          source: { type: "query", providerId: "metrics", query: "up" },
        }}
      />,
    );
    choose("Tooltip visualization", "Trace explorer");
    expect(
      screen.getByRole("combobox", { name: "Tooltip provider" }),
    ).toHaveTextContent("Production traces");
    expect(
      screen.queryByRole("textbox", { name: "Tooltip unit" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Tooltip data source" }),
    );
    expect(
      screen.getByRole("option", { name: "Hovered series" }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Tooltip data source" }),
      { key: "Escape" },
    );
    changeQueryEditor(screen.getByRole("textbox", { name: "Tooltip TraceQL query" }), "{ resource.service.name = {{service}} }");
    choose("Tooltip visualization", "Time series");
    expect(readQueryEditor(screen.getByRole("textbox", { name: "Tooltip PromQL query" }))).toBe("up");
    choose("Tooltip visualization", "Trace explorer");
    expect(readQueryEditor(screen.getByRole("textbox", { name: "Tooltip TraceQL query" }))).toBe("{ resource.service.name = {{service}} }");
  });

  it("keeps unavailable provider selections and unfinished query text recoverable", () => {
    render(
      <Harness
        sources={[]}
        initial={{
          type: "table",
          source: {
            type: "query",
            providerId: "removed",
            query: "unfinished{",
          },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a connected metrics provider",
    );
    expect(
      screen.getByRole("combobox", { name: "Tooltip provider" }),
    ).toHaveTextContent("Unavailable: removed");
    expect(readQueryEditor(screen.getByRole("textbox", { name: "Tooltip PromQL query" }))).toBe("unfinished{");
    changeQueryEditor(screen.getByRole("textbox", { name: "Tooltip PromQL query" }), "still editing");
    expect(draft()?.source).toMatchObject({
      providerId: "removed",
      query: "still editing",
    });
  });

  it("uses the registered plugin library without exposing unrelated chart controls", () => {
    const unregister = registerWidgetPlugin({
      id: "tooltip-test-plugin",
      label: "Status summary",
      description: "Test plugin",
      dataKind: "metrics",
      render: () => null,
    });
    try {
      render(<Harness initial={{ type: "timeseries" }} />);
      choose("Tooltip visualization", "Status summary");
      expect(draft()).toMatchObject({
        type: "plugin",
        pluginId: "tooltip-test-plugin",
        dataKind: "metrics",
      });
      expect(
        screen.queryByRole("switch", { name: "Show tooltip chart grid" }),
      ).not.toBeInTheDocument();
      const config = screen.getByRole("textbox", {
        name: "Tooltip plugin configuration",
      });
      fireEvent.change(config, { target: { value: '{"unfinished":' } });
      expect(config).toHaveValue('{"unfinished":');
      choose("Tooltip visualization", "Metrics table");
      expect(draft()?.pluginId).toBeUndefined();
      expect(draft()?.dataKind).toBeUndefined();
      expect(
        screen.queryByRole("textbox", { name: "Tooltip plugin configuration" }),
      ).not.toBeInTheDocument();
    } finally {
      unregister();
    }
  });

  it("bounds mapping rows while allowing incomplete drafts until Apply", () => {
    render(
      <Harness
        initial={{
          type: "stat",
          source: {
            type: "query",
            providerId: "metrics",
            query: "up",
            bindings: Array.from({ length: 20 }, (_, index) => ({
              variable: `v${index}`,
              label: `label${index}`,
            })),
          },
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Add query mapping" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove tooltip mapping 20" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add query mapping" }));
    expect(
      screen.getByRole("textbox", { name: "Tooltip mapping 20 variable" }),
    ).toHaveValue("");
  });
});

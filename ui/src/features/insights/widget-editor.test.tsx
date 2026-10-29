import { changeQueryEditor, readQueryEditor } from "./query-code-editor.test-utils";
import { useState } from "react";
import { parse as parseYaml } from "yaml";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetEditor } from "./widget-editor";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import { registerWidgetPlugin } from "./widget-registry";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import type { Dashboard, Provider, Widget, SavedQuery } from "./schema";

const widget: Widget = {
  id: "requests",
  title: "Requests",
  type: "timeseries",
  query: "up",
  providerId: "production",
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};
const providers: Provider[] = [
  {
    id: "staging",
    name: "Staging Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "production",
    name: "Production Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  { id: "tempo", name: "Tempo", type: "tempo", capabilities: ["traces"] },
];
function props() {
  return {
    widget,
    providers,
    onApply: vi.fn(),
    onClose: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  };
}

function choose(label: string, option: RegExp | string) {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: option }));
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
}

describe("widget inspector", () => {
  it("previews title, style and dimensions without Apply and inspects the same unsaved JSON/YAML", () => {
    const callbacks = props();
    let working = widget;
    function Host() {
      const [value, setValue] = useState(widget);
      working = value;
      return <WidgetEditor {...callbacks} widget={value} onApply={next => { callbacks.onApply(next); setValue(next); }} />;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved preview" } });
    expect(working.title).toBe("Unsaved preview");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show legend" }));
    expect(working.options?.showLegend).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    choose("Width", "8 columns");
    expect(working.layout.w).toBe(8);
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    const json = screen.getByRole("textbox", { name: "Widget JSON" });
    expect(json).toHaveAttribute("readonly");
    expect(JSON.parse((json as HTMLTextAreaElement).value)).toEqual(working);
    choose("Widget source format", "YAML");
    expect(parseYaml((screen.getByRole("textbox", { name: "Widget YAML" }) as HTMLTextAreaElement).value)).toEqual(working);
    expect(screen.getByRole("button", { name: "Apply widget" })).toBeEnabled();
  });

  it("keeps the last valid preview while invalid plugin JSON blocks saving and recovers immediately", () => {
    registerDefaultWidgetPlugins();
    const callbacks = props(), validity = vi.fn();
    let working: Widget = { ...widget, type: "plugin", pluginId: "threshold-gauge", dataKind: "metrics", config: {} };
    function Host() {
      const [value, setValue] = useState(working);
      working = value;
      return <WidgetEditor {...callbacks} widget={value} onDraftValidityChange={validity} onApply={setValue} />;
    }
    render(<Host />);
    const field = screen.getByRole("textbox", { name: "Plugin configuration" });
    fireEvent.change(field, { target: { value: '{"label":' } });
    expect(validity).toHaveBeenLastCalledWith(false);
    expect(working.config).toEqual({});
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText(/Showing the last valid widget/)).toBeVisible();
    expect(JSON.parse((screen.getByRole("textbox", { name: "Widget JSON" }) as HTMLTextAreaElement).value).config).toEqual({});
    fireEvent.click(screen.getByRole("tab", { name: "Query" }));
    fireEvent.change(field, { target: { value: '{"label":"Preview gauge"}' } });
    expect(validity).toHaveBeenLastCalledWith(true);
    expect(working.config).toEqual({ label: "Preview gauge" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("applies an optional sparkline for a single value and resets it with appearance", () => {
    const callbacks = props();
    render(<WidgetEditor {...callbacks} widget={{ ...widget, type: "stat" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    const toggle = screen.getByRole("switch", { name: "Show sparkline" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ showSparkline: true }) }));
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(toggle).not.toBeChecked();
  });
  it("links a saved query with dashboard mappings and restores the custom draft explicitly", () => {
    const callbacks = props();
    const saved: SavedQuery = {
      schemaVersion: 1,
      id: "shared",
      name: "Shared requests",
      providerId: "staging",
      kind: "metrics",
      query: "up{env={{environment}}}",
      parameters: [{ name: "environment", type: "string" }],
    };
    render(
      <SavedQueryLibraryProvider
        queries={[saved]}
        variables={[{ name: "environment", label: "Environment" }]}
        values={{ environment: "prod" }}
      >
        <WidgetEditor {...callbacks} />
      </SavedQueryLibraryProvider>,
    );
    choose("Widget query source", "Saved query");
    choose("Saved query", /^Shared requests/);
    expect(screen.getByLabelText("Saved query template")).toHaveAttribute(
      "readonly",
    );
    choose("Value for environment from", "Dashboard variable");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId: "staging",
        query: "up",
        queryRef: {
          id: "shared",
          bindings: [
            {
              parameter: "environment",
              source: "variable",
              variable: "environment",
            },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use custom query" }));
    expect(readQueryEditor(screen.getByRole("textbox", { name: /PromQL query/ }))).toBe(
      "up",
    );
  });
  it("does not apply an unavailable saved reference or silently substitute its retained custom query", () => {
    const callbacks = props();
    render(
      <WidgetEditor
        {...callbacks}
        widget={{ ...widget, queryRef: { id: "missing" } }}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Saved query" }),
    ).toHaveTextContent("Unavailable saved query");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/);
    expect(callbacks.onApply).not.toHaveBeenCalled();
  });

  it.each(["heatmap", "timeseries", "bar", "table"] as const)(
    "makes tooltip setup discoverable for %s and preserves the configured widget",
    (type) => {
      const callbacks = props();
      render(<WidgetEditor {...callbacks} widget={{ ...widget, type }} />);
      const tooltipTab = screen.getByRole("tab", { name: "Tooltips" });
      fireEvent.click(screen.getByRole("tab", { name: "Style" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Configure tooltips" }),
      );
      expect(tooltipTab).toHaveFocus();
      expect(tooltipTab).toHaveAttribute("aria-selected", "true");
      expect(
        screen.getByRole("switch", { name: "Show tooltips" }),
      ).toBeChecked();
      fireEvent.click(
        screen.getByRole("button", { name: "Add tooltip widget" }),
      );
      choose("Tooltip visualization", "Single value");
      fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
      expect(callbacks.onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          type,
          options: { tooltipView: { type: "stat" } },
        }),
      );
    },
  );

  it("returns to Style when a host without tooltip widgets is selected", () => {
    render(<WidgetEditor {...props()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    choose("Visualization", /^Single value/);
    expect(
      screen.queryByRole("tab", { name: "Tooltips" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Style" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Show tooltips" })).toBeVisible();
  });

  it("validates numeric tooltip placeholders as numbers and keeps bindings typed on Apply", () => {
    const callbacks = props();
    const view = render(
      <WidgetEditor
        {...callbacks}
        widget={{
          ...widget,
          options: {
            tooltipView: {
              type: "bar",
              source: {
                type: "query",
                providerId: "production",
                query: "up @ {{time}} > {{value}}",
                bindings: [
                  { variable: "time", field: "timestamp" },
                  { variable: "value", field: "value" },
                ],
              },
            },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        options: {
          tooltipView: {
            type: "bar",
            source: {
              type: "query",
              providerId: "production",
              query: "up @ {{time}} > {{value}}",
              bindings: [
                { variable: "time", field: "timestamp" },
                { variable: "value", field: "value" },
              ],
            },
          },
        },
      }),
    );
    view.rerender(
      <WidgetEditor
        {...callbacks}
        widget={callbacks.onApply.mock.calls[0][0]}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the Links tab useful when no destination dashboards were supplied", () => {
    render(<WidgetEditor {...props()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    expect(
      screen.getByRole("button", { name: "Add dashboard link" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Create a dashboard before adding a link."),
    ).toBeVisible();
  });

  it("applies links authored in the Links tab with the widget draft", () => {
    const callbacks = props();
    const target: Dashboard = {
      schemaVersion: 1,
      id: "service-detail",
      title: "Service detail",
      timeRange: "1h",
      refreshInterval: 0,
      widgets: [],
    };
    render(<WidgetEditor {...callbacks} dashboards={[target]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    fireEvent.click(screen.getByRole("button", { name: "Add dashboard link" }));
    fireEvent.change(screen.getByLabelText("Link 1 title"), {
      target: { value: "Investigate service" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /^Carry time range/ }));
    expect(callbacks.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ drilldowns: [expect.objectContaining({ title: "Investigate service", carryTimeRange: false })] }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        id: widget.id,
        drilldowns: [
          expect.objectContaining({
            title: "Investigate service",
            dashboardId: "service-detail",
            carryTimeRange: false,
          }),
        ],
      }),
    );
  });

  it("uses keyboard selections for style and dimensions and preserves the selected data source", () => {
    const callbacks = props();
    const { container } = render(<WidgetEditor {...callbacks} />);
    expect(container.querySelector("select")).toBeNull();
    choose("Data source", "Staging Prometheus");
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    const display = screen.getByRole("combobox", { name: "Display" });
    fireEvent.keyDown(display, { key: "ArrowDown" });
    fireEvent.keyDown(display, { key: "ArrowDown" });
    fireEvent.keyDown(display, { key: "Enter" });
    expect(display).toHaveTextContent("Area");
    choose("Curve", "Smooth");
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    choose("Width", "8 columns");
    const height = screen.getByRole("combobox", { name: "Height" });
    fireEvent.keyDown(height, { key: "Enter" });
    fireEvent.keyDown(height, { key: "End" });
    fireEvent.keyDown(height, { key: "Enter" });
    expect(height).toHaveTextContent("12 rows");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "staging",
        options: { display: "area", curve: "monotone" },
        layout: { x: 0, y: 0, w: 8, h: 12 },
      }),
    );
  });

  it("preserves pending text edits while moving and applies the latest position", () => {
    const callbacks = props();
    const { rerender } = render(<WidgetEditor {...callbacks} />);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "My request chart" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Move widget right" }));
    expect(callbacks.onMove).toHaveBeenCalledWith(1, 0);
    rerender(
      <WidgetEditor
        {...callbacks}
        widget={{ ...widget, layout: { ...widget.layout, x: 1 } }}
      />,
    );
    expect(screen.getByLabelText("Title")).toHaveValue("My request chart");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My request chart",
        layout: { x: 1, y: 0, w: 6, h: 4 },
      }),
    );
  });

  it("protects a resized widget from stale dimensions after external Undo", () => {
    const callbacks = props();
    const { rerender } = render(<WidgetEditor {...callbacks} />);
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    choose("Width", "8 columns");
    const resized = callbacks.onApply.mock.calls.at(-1)![0] as Widget;
    rerender(<WidgetEditor {...callbacks} widget={resized} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<WidgetEditor {...callbacks} widget={widget} />);
    expect(screen.getByRole("alert")).toHaveTextContent("changed on the canvas");
    callbacks.onApply.mockClear();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Later title" } });
    expect(callbacks.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload widget" }));
    expect(screen.getByRole("combobox", { name: "Width" })).toHaveTextContent("6 columns");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fresh title" } });
    expect(callbacks.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Fresh title", layout: { ...widget.layout, w: 6 } }));
  });

  it("cannot overwrite newer canvas settings until reloaded", () => {
    const callbacks = props();
    const { rerender } = render(<WidgetEditor {...callbacks} />);
    rerender(
      <WidgetEditor
        {...callbacks}
        widget={{ ...widget, query: "rate(requests_total[5m])" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Apply widget" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload widget" }));
    expect(readQueryEditor(screen.getByLabelText("PromQL query"))).toBe(
      "rate(requests_total[5m])",
    );
    expect(screen.getByRole("button", { name: "Apply widget" })).toBeEnabled();
  });

  it("preserves a compatible provider when changing visualization", () => {
    const callbacks = props();
    render(<WidgetEditor {...callbacks} />);
    choose("Visualization", /^Bar chart/);
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bar",
        providerId: "production",
        query: "up",
      }),
    );
  });

  it("selects a trace provider and query language when crossing capabilities", () => {
    const callbacks = props();
    render(<WidgetEditor {...callbacks} />);
    choose("Visualization", /^Trace explorer/);
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "traces",
        providerId: "tempo",
        query: "{}",
      }),
    );
  });
  it("validates threshold ordering and retains appearance choices in the document", () => {
    const callbacks = props();
    render(<WidgetEditor {...callbacks} />);
    choose("Visualization", /^Status heatmap/);
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.change(screen.getByLabelText("Decimal places"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add threshold" }));
    fireEvent.click(screen.getByRole("button", { name: "Add threshold" }));
    callbacks.onApply.mockClear();
    fireEvent.change(screen.getByLabelText("Threshold 2 value"), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(screen.getByRole("alert")).toHaveTextContent("strictly increasing");
    expect(callbacks.onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Threshold 2 value"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heatmap",
        options: expect.objectContaining({
          decimals: 3,
          thresholds: [
            { value: 0, color: "#c46146" },
            { value: 1, color: "#6e947a" },
          ],
        }),
      }),
    );
  });
  it("validates custom plugin configuration without offering gauge-only controls", () => {
    const dispose = registerWidgetPlugin({
      id: "test-gauge",
      label: "Test gauge",
      description: "Test",
      dataKind: "metrics",
      render: () => null,
      parseConfig: (config) => {
        if (typeof config?.label !== "string")
          throw new Error("A label is required");
        return config;
      },
    });
    try {
      const callbacks = props();
      render(<WidgetEditor {...callbacks} />);
      choose("Visualization", /^Test gauge/);
      fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A label is required",
      );
      fireEvent.change(screen.getByLabelText("Plugin configuration"), {
        target: { value: '{"label":"Worker saturation"}' },
      });
      fireEvent.click(screen.getByRole("tab", { name: "Style" }));
      expect(screen.queryByLabelText("Minimum")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Maximum")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Series color")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: "Show legend" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: "Show tooltips" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Background")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
      expect(callbacks.onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "plugin",
          pluginId: "test-gauge",
          dataKind: "metrics",
          config: { label: "Worker saturation" },
        }),
      );
    } finally {
      dispose();
    }
  });

  it("offers the bundled gauge's range, threshold and legend controls and preserves them on apply", () => {
    registerDefaultWidgetPlugins();
    const callbacks = props();
    render(
      <WidgetEditor
        {...callbacks}
        widget={{
          ...widget,
          type: "plugin",
          pluginId: "threshold-gauge",
          dataKind: "metrics",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.getByLabelText("Series color")).toHaveValue("#53876a");
    expect(screen.queryByLabelText("Y minimum")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Show grid" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Show labels" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Minimum"), {
      target: { value: "-20" },
    });
    fireEvent.change(screen.getByLabelText("Maximum"), {
      target: { value: "80" },
    });
    fireEvent.change(screen.getByLabelText("Text color"), {
      target: { value: "#123456" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Show legend" }));
    fireEvent.click(screen.getByRole("button", { name: "Add threshold" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "threshold-gauge",
        options: expect.objectContaining({
          min: -20,
          max: 80,
          textColor: "#123456",
          showLegend: false,
          thresholds: [{ value: 0, color: "#c46146" }],
        }),
      }),
    );
  });

  it("offers record-table colors, precision and thresholds without plot-only controls", () => {
    registerDefaultWidgetPlugins();
    const callbacks = props();
    const config = { cellStyles: [{ column: "usage", display: "bar", min: 0, max: 100 }] };
    render(<WidgetEditor {...callbacks} widget={{ ...widget, type: "plugin", pluginId: "record-table", dataKind: "records", providerId: "records", config }}
      providers={[{ id: "records", name: "Application records", type: "uptime", capabilities: ["records"] }]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.getByLabelText("Series color")).toBeInTheDocument();
    expect(screen.getByLabelText("Decimal places")).toBeInTheDocument();
    expect(screen.queryByLabelText("Y minimum")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Show grid" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add threshold" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ config: expect.objectContaining(config), options: expect.objectContaining({ thresholds: [{ value: 0, color: "#c46146" }] }) }));
  });

  it("restores registered gauge defaults when resetting its appearance", () => {
    registerDefaultWidgetPlugins();
    const callbacks = props();
    render(
      <WidgetEditor
        {...callbacks}
        widget={{
          ...widget,
          type: "plugin",
          pluginId: "threshold-gauge",
          dataKind: "metrics",
          color: "#ff0000",
          options: { min: -10, max: 20, showLegend: false },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(screen.getByLabelText("Minimum")).toHaveValue(0);
    expect(screen.getByLabelText("Maximum")).toHaveValue(100);
    expect(screen.getByRole("switch", { name: "Show legend" })).toBeChecked();
    expect(screen.getByLabelText("Threshold 3 label")).toHaveValue("Critical");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        color: undefined,
        options: expect.objectContaining({
          min: 0,
          max: 100,
          decimals: 1,
          thresholds: expect.arrayContaining([
            expect.objectContaining({ value: 90, label: "Critical" }),
          ]),
        }),
      }),
    );
  });

  it("exposes area opacity only when it changes the display and retains its draft when switching to line", () => {
    const callbacks = props();
    render(<WidgetEditor {...callbacks} />);
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.queryByLabelText("Fill opacity")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Series color")).toHaveValue("#c46146");
    choose("Display", "Area");
    fireEvent.change(screen.getByLabelText("Fill opacity"), {
      target: { value: "0.35" },
    });
    choose("Display", "Line");
    expect(screen.queryByLabelText("Fill opacity")).not.toBeInTheDocument();
    choose("Display", "Area");
    expect(screen.getByLabelText("Fill opacity")).toHaveValue(0.35);
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { display: "area", fillOpacity: 0.35 },
      }),
    );
  });

  it("explains fixed trace duration units without offering an ineffective unit editor", () => {
    const callbacks = props();
    render(
      <WidgetEditor
        {...callbacks}
        widget={{
          ...widget,
          type: "traces",
          providerId: "tempo",
          query: "{}",
          unit: "ms",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.queryByLabelText("Unit")).not.toBeInTheDocument();
    expect(
      screen.getByText("Trace duration is displayed in milliseconds."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Series color")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Decimal places"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({ unit: "ms", options: { decimals: 2 } }),
    );
  });

  it("warns on explicit low-contrast colors without overwriting the author's saved choices", () => {
    const callbacks = props();
    render(<WidgetEditor {...callbacks} />);
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.change(screen.getByLabelText("Background"), {
      target: { value: "#102030" },
    });
    expect(screen.getByLabelText("Text color")).toHaveValue("#ffffff");
    expect(screen.queryByText(/Text contrast is/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Text color"), {
      target: { value: "#102030" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Text contrast is 1.0:1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { background: "#102030", textColor: "#102030" },
      }),
    );
  });

  it("checks explicit heatmap text against threshold fills only while cell text is visible", () => {
    render(
      <WidgetEditor
        {...props()}
        widget={{
          ...widget,
          type: "heatmap",
          options: { textColor: "#b64a3a" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Text needs more contrast on a heatmap color",
    );
    fireEvent.click(screen.getByRole("switch", { name: "Show labels" }));
    expect(screen.getByRole("status")).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "Show values" }));
    expect(
      screen.queryByText(/Text needs more contrast/),
    ).not.toBeInTheDocument();
  });

  it("configures tooltip history, preserves it while hidden, and deliberately resets it", () => {
    const callbacks = props();
    const view = render(
      <WidgetEditor {...callbacks} widget={{ ...widget, type: "heatmap" }} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tooltip widget" }));
    choose("Tooltip chart height", "Expanded");
    fireEvent.click(
      screen.getByRole("switch", { name: "Show tooltip chart grid" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Show tooltip chart axes" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Show tooltips" }));
    expect(
      screen.queryByRole("combobox", { name: "Tooltip visualization" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: {
          showTooltip: false,
          tooltipView: {
            type: "timeseries",
            height: 200,
            showGrid: false,
            showAxis: false,
          },
        },
      }),
    );
    view.rerender(
      <WidgetEditor
        {...callbacks}
        widget={callbacks.onApply.mock.calls.at(-1)![0]}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Show tooltips" }));
    expect(
      screen.getByRole("combobox", { name: "Tooltip chart height" }),
    ).toHaveTextContent("Expanded");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove tooltip widget" }),
    );
    expect(
      screen.queryByRole("switch", { name: "Show tooltip chart grid" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(
      callbacks.onApply.mock.calls.at(-1)![0].options?.tooltipView,
    ).toBeUndefined();
    view.rerender(
      <WidgetEditor
        {...callbacks}
        widget={callbacks.onApply.mock.calls.at(-1)![0]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add tooltip widget" }));
    choose("Tooltip chart height", "Tall");
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure tooltips" }));
    expect(screen.getByRole("tab", { name: "Tooltips" })).toHaveFocus();
    expect(
      screen.getByRole("combobox", { name: "Tooltip chart height" }),
    ).toHaveTextContent("Tall");
  });

  it("validates queried tooltip mappings on Apply without losing an incomplete draft", () => {
    const callbacks = props();
    render(
      <WidgetEditor {...callbacks} widget={{ ...widget, type: "heatmap" }} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tooltip widget" }));
    choose("Tooltip visualization", "Bar chart");
    choose("Tooltip data source", "Provider query");
    callbacks.onApply.mockClear();
    const query = screen.getByRole("textbox", { name: "Tooltip PromQL query" });
    changeQueryEditor(query, "sum(up{service={{service}}})");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Tooltip query:");
    expect(readQueryEditor(query)).toBe("sum(up{service={{service}}})");
    fireEvent.click(screen.getByRole("button", { name: "Add query mapping" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Tooltip mapping 1 variable" }),
      { target: { value: "service" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Tooltip mapping 1 hovered label" }),
      { target: { value: "service_name" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        options: {
          tooltipView: {
            type: "bar",
            source: {
              type: "query",
              providerId: "production",
              query: "sum(up{service={{service}}})",
              bindings: [{ variable: "service", label: "service_name" }],
            },
          },
        },
      }),
    );
  });

  it("blocks incompatible tooltip providers and quoted placeholders while retaining authored values", () => {
    const callbacks = props();
    render(
      <WidgetEditor
        {...callbacks}
        widget={{
          ...widget,
          type: "heatmap",
          options: {
            tooltipView: {
              type: "stat",
              source: {
                type: "query",
                providerId: "tempo",
                query: 'up{service="{{service}}"}',
                bindings: [{ variable: "service", label: "service" }],
              },
            },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) =>
          alert.textContent?.includes("compatible provider for the tooltip"),
        ),
    ).toBe(true);
    choose("Tooltip provider", "Production Prometheus");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remove the surrounding quotes",
    );
    expect(readQueryEditor(screen.getByRole("textbox", { name: "Tooltip PromQL query" }))).toBe('up{service="{{service}}"}');
  });

  it("keeps invalid tooltip plugin JSON across tabs and applies validated registered configuration", () => {
    const dispose = registerWidgetPlugin({
      id: "tooltip-editor-validation",
      label: "Validated summary",
      description: "Test tooltip",
      dataKind: "metrics",
      render: () => null,
      parseConfig: (config) => {
        if (typeof config?.caption !== "string")
          throw new Error("A caption is required");
        return config;
      },
    });
    try {
      const callbacks = props();
      render(
        <WidgetEditor {...callbacks} widget={{ ...widget, type: "heatmap" }} />,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Add tooltip widget" }),
      );
      choose("Tooltip visualization", "Validated summary");
      callbacks.onApply.mockClear();
      const config = screen.getByRole("textbox", {
        name: "Tooltip plugin configuration",
      });
      fireEvent.change(config, { target: { value: '{"caption":' } });
      fireEvent.click(screen.getByRole("tab", { name: "Query" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
      expect(callbacks.onApply).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
      expect(config).toHaveValue('{"caption":');
      fireEvent.change(config, { target: { value: "{}" } });
      fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A caption is required",
      );
      fireEvent.change(config, {
        target: { value: '{"caption":"Availability"}' },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
      expect(callbacks.onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          options: {
            tooltipView: {
              type: "plugin",
              pluginId: "tooltip-editor-validation",
              dataKind: "metrics",
              config: { caption: "Availability" },
            },
          },
        }),
      );
    } finally {
      dispose();
    }
  });

  it("offers independent label and value visibility only for heatmaps and restores saved settings", () => {
    const callbacks = props();
    const { rerender } = render(<WidgetEditor {...callbacks} />);
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(
      screen.queryByRole("switch", { name: "Show labels" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Show values" }),
    ).not.toBeInTheDocument();
    choose("Visualization", /^Status heatmap/);
    const labels = screen.getByRole("switch", { name: "Show labels" });
    const values = screen.getByRole("switch", { name: "Show values" });
    expect(labels).toBeChecked();
    expect(values).toBeChecked();
    fireEvent.click(labels);
    expect(labels).not.toBeChecked();
    expect(values).toBeChecked();
    fireEvent.click(values);
    expect(labels).not.toBeChecked();
    expect(values).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    const saved = callbacks.onApply.mock.calls.at(-1)![0] as Widget;
    expect(saved.options).toEqual({ showLabels: false, showValues: false });
    rerender(<WidgetEditor {...callbacks} widget={saved} />);
    expect(
      screen.getByRole("switch", { name: "Show labels" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Show values" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Show labels" }));
    expect(
      screen.getByRole("switch", { name: "Show values" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(callbacks.onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: { showLabels: true, showValues: false },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(screen.getByRole("switch", { name: "Show labels" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Show values" })).toBeChecked();
  });
});

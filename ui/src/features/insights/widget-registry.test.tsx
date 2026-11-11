import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import {
  getWidgetDefinition,
  getWidgetPlugins,
  registerWidgetPlugin,
  useWidgetDefinitions,
  widgetDefinitions,
  type WidgetPlugin,
} from "./widget-registry";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import { newWidget, widgetKind, type Widget } from "./schema";

const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
const widget: Widget = {
  id: "plugin",
  title: "Queue saturation",
  type: "plugin",
  pluginId: "test-plugin",
  dataKind: "metrics",
  providerId: "metrics",
  query: "queue_usage",
  unit: "%",
  layout: { x: 0, y: 0, w: 4, h: 3 },
};
const result = {
  series: [
    { name: "queue", labels: {}, points: [{ timestamp: 1, value: 92 }] },
  ],
};
const plugin: WidgetPlugin = {
  id: "test-plugin",
  label: "Test plugin",
  description: "A host-owned renderer",
  dataKind: "metrics",
  render: ({ widget }) => <p>{widget.title}: rendered</p>,
};
const register = (value: WidgetPlugin) => {
  const dispose = registerWidgetPlugin(value);
  disposers.push(dispose);
  return dispose;
};

describe("trusted widget registry", () => {
  it("publishes stable snapshots and updates existing consumers on register/unregister", () => {
    const { result, rerender } = renderHook(useWidgetDefinitions);
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    let dispose: () => void = () => {};
    act(() => {
      dispose = register(plugin);
    });
    expect(result.current).toHaveLength(widgetDefinitions.length + 1);
    const registered = result.current;
    rerender();
    expect(result.current).toBe(registered);
    expect(getWidgetDefinition(widget)?.id).toBe(plugin.id);
    act(dispose);
    expect(result.current).toHaveLength(widgetDefinitions.length);
    expect(
      getWidgetPlugins().find((value) => value.id === plugin.id),
    ).toBeUndefined();
  });

  it("guards identifiers, builtin replacement, duplicate registration and invalid defaults", () => {
    expect(() => register({ ...plugin, id: "remote.script" })).toThrow(
      /identifiers/,
    );
    expect(() => register({ ...plugin, id: "timeseries" })).toThrow(
      /already registered/,
    );
    expect(() =>
      register({ ...plugin, defaultOptions: { min: 9, max: 2 } }),
    ).toThrow();
    register(plugin);
    expect(() => register(plugin)).toThrow(/already registered/);
  });

  it("shows an actionable missing plugin state and picks up a later trusted bundle", () => {
    render(<WidgetVisualization widget={widget} result={result} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Widget plugin unavailable",
    );
    act(() => {
      register(plugin);
    });
    expect(screen.getByText("Queue saturation: rendered")).toBeInTheDocument();
  });

  it("isolates renderer/config failures and recovers when configuration is corrected", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({
      ...plugin,
      parseConfig: (config) => {
        if (!config?.label) throw new Error("label required");
        return config;
      },
      render: ({ widget }) => <p>{String(widget.config?.label)}</p>,
    });
    const { rerender } = render(
      <>
        <WidgetVisualization widget={widget} result={result} />
        <WidgetVisualization
          widget={{ ...widget, id: "plain", type: "stat" }}
          result={result}
        />
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Widget could not render",
    );
    expect(screen.getByText("92")).toBeInTheDocument();
    rerender(
      <>
        <WidgetVisualization
          widget={{ ...widget, config: { label: "Recovered renderer" } }}
          result={result}
        />
        <WidgetVisualization
          widget={{ ...widget, id: "plain", type: "stat" }}
          result={result}
        />
      </>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Recovered renderer")).toBeInTheDocument();
  });

  it("supports trace plugins and chooses their compatible provider", () => {
    register({
      ...plugin,
      dataKind: "traces",
      render: ({ result }) => <p>{result.traces?.[0].operation}</p>,
    });
    const traceWidget = newWidget(
      "plugin",
      [{ id: "tempo", name: "Tempo", type: "tempo", capabilities: ["traces"] }],
      [],
      { id: plugin.id, label: plugin.label, dataKind: "traces" },
    );
    expect(traceWidget.providerId).toBe("tempo");
    expect(traceWidget.query).toBe("{}");
    expect(widgetKind(traceWidget)).toBe("traces");
    render(
      <WidgetVisualization
        widget={traceWidget}
        result={{
          traces: [
            {
              traceId: "abc",
              service: "api",
              operation: "GET /health",
              durationMs: 20,
              startTime: 1,
              status: "ok",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("GET /health")).toBeInTheDocument();
  });

  it("isolates renderer exceptions and retries after fresh data arrives", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({
      ...plugin,
      render: ({ result }) => {
        if (result.series?.[0].points[0].value === 92)
          throw new Error("Bad renderer data");
        return <p>New data recovered</p>;
      },
    });
    const { rerender } = render(
      <WidgetVisualization widget={widget} result={result} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Widget could not render",
    );
    rerender(
      <WidgetVisualization
        widget={widget}
        result={{
          series: [
            { name: "new", labels: {}, points: [{ timestamp: 2, value: 12 }] },
          ],
        }}
      />,
    );
    expect(screen.getByText("New data recovered")).toBeInTheDocument();
  });

  it("renders the bundled gauge through the same registration API and clamps visual progress", () => {
    registerDefaultWidgetPlugins();
    registerDefaultWidgetPlugins();
    const definition = getWidgetDefinition("plugin", "threshold-gauge")!;
    const gauge = newWidget("plugin", [], [], definition);
    render(
      <WidgetVisualization
        widget={{
          ...gauge,
          title: "Usage",
          unit: "%",
          options: { ...gauge.options, max: 80 },
        }}
        result={result}
      />,
    );
    expect(screen.getByRole("meter", { name: "Usage" })).toHaveAttribute(
      "aria-valuenow",
      "80",
    );
    expect(screen.getByRole("meter")).toHaveAttribute(
      "aria-valuetext",
      "92% · Critical",
    );
    expect(screen.getByText("92.0")).toHaveStyle({ color: "#b64a3a" });
  });

  it("lets a plugin render its own all-null and empty result semantics", () => {
    register({
      ...plugin,
      render: ({ result }) => (
        <p>
          {result.series?.length
            ? "Unknown latest reading"
            : "No matching services"}
        </p>
      ),
    });
    const { rerender } = render(
      <WidgetVisualization
        widget={widget}
        result={{
          series: [
            {
              name: "api",
              labels: {},
              points: [{ timestamp: 10, value: null }],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Unknown latest reading")).toBeInTheDocument();
    rerender(<WidgetVisualization widget={widget} result={{ series: [] }} />);
    expect(screen.getByText("No matching services")).toBeInTheDocument();
    rerender(<WidgetVisualization widget={widget} loading />);
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading widget");
  });

  it("formats gauge tooltip precision while preserving exact selected context and observation values", () => {
    registerDefaultWidgetPlugins();
    const changed = vi.fn();
    const gauge: Widget = {
      ...widget,
      title: "Usage",
      pluginId: "threshold-gauge",
      options: { min: -10, max: 10, decimals: 2, textColor: "#123456" },
    };
    const sample = {
      series: [
        {
          name: "api",
          labels: { service: "api", region: "west" },
          points: [{ timestamp: 1000, value: -0.123456789 }],
        },
      ],
    };
    const { rerender } = render(
      <WidgetVisualization
        widget={gauge}
        result={sample}
        onContextChange={changed}
      />,
    );
    const button = screen.getByRole("button", {
      name: /Select signal for Usage/,
    });
    expect(screen.getByText("-0.12").parentElement).toHaveStyle({
      color: "#123456",
    });
    fireEvent.focus(button);
    expect(changed).toHaveBeenLastCalledWith({
      series: "api",
      labels: { service: "api", region: "west" },
      value: -0.123456789,
    });
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("-0.12%");
    expect(tip.querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "-0.123456789");
    expect(tip).toHaveTextContent("region: west");
    expect(tip.querySelector("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:01.000Z",
    );
    expect(screen.getByRole("meter")).toHaveAttribute(
      "aria-valuetext",
      "-0.123456789%",
    );
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    rerender(
      <WidgetVisualization
        widget={{ ...gauge, options: { ...gauge.options, showTooltip: false } }}
        result={sample}
        onContextChange={changed}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Select signal for Usage/ }),
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders gauge zero and negative readings honestly and marks missing readings unknown", () => {
    registerDefaultWidgetPlugins();
    const gauge = {
      ...widget,
      pluginId: "threshold-gauge",
      options: { min: -10, max: 10 },
    };
    const { rerender } = render(
      <WidgetVisualization
        widget={gauge}
        result={{
          series: [
            { name: "api", labels: {}, points: [{ timestamp: 1, value: 0 }] },
          ],
        }}
      />,
    );
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    rerender(
      <WidgetVisualization
        widget={gauge}
        result={{
          series: [
            { name: "api", labels: {}, points: [{ timestamp: 1, value: -15 }] },
          ],
        }}
      />,
    );
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "-10");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "-15%");
    rerender(
      <WidgetVisualization
        widget={gauge}
        result={{
          series: [
            {
              name: "api",
              labels: {},
              points: [{ timestamp: 1, value: null }],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unknown");
    expect(screen.queryByRole("meter")).toBeNull();
  });
  it("never presents an old healthy gauge or another series as the missing latest observation", () => {
    registerDefaultWidgetPlugins();
    const changed = vi.fn();
    render(
      <WidgetVisualization
        widget={{ ...widget, pluginId: "threshold-gauge" }}
        result={{
          series: [
            {
              name: "api",
              labels: { service: "api" },
              points: [
                { timestamp: 1000, value: 20 },
                { timestamp: 2000, value: null },
              ],
            },
            {
              name: "other",
              labels: { service: "other" },
              points: [{ timestamp: 2000, value: 99 }],
            },
          ],
        }}
        onContextChange={changed}
      />,
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Unknown");
    fireEvent.click(
      screen.getByRole("button", { name: /Select signal.*No data/ }),
    );
    expect(changed).toHaveBeenLastCalledWith({
      series: "api",
      labels: { service: "api" },
      value: null,
    });
    expect(screen.getByRole("tooltip").querySelector("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:02.000Z",
    );
  });
});

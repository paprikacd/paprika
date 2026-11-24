import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render as renderDom, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { getWidgetDefinition } from "../widget-registry";
import { MAX_THROTTLE_COLUMNS } from "./kubernetes-data";
import { KUBERNETES_FIXTURE_OPTIONS, KUBERNETES_PLUGIN_IDS, kubernetesFixture, type KubernetesPluginId, type KubernetesPreset } from "./kubernetes-fixtures";
import { registerKubernetesPlugins } from "./kubernetes-plugins";
import { KubernetesPlacement } from "./kubernetes-placement";
import { KubernetesResourceBars, KubernetesResourceTrend, KubernetesThrottleMatrix } from "./kubernetes-widgets";

const ids = Object.values(KUBERNETES_PLUGIN_IDS) as KubernetesPluginId[];
const presets: KubernetesPreset[] = ["ready", "gaps", "empty"];

// The lazy registry wrapper suspends on first use, so the tests render the components themselves.
const components: Record<KubernetesPluginId, (props: never) => ReactElement> = {
  [KUBERNETES_PLUGIN_IDS.placement]: KubernetesPlacement as never,
  [KUBERNETES_PLUGIN_IDS.bars]: KubernetesResourceBars as never,
  [KUBERNETES_PLUGIN_IDS.throttle]: KubernetesThrottleMatrix as never,
  [KUBERNETES_PLUGIN_IDS.trend]: KubernetesResourceTrend as never,
};

function render(id: KubernetesPluginId, preset: KubernetesPreset, extra: Record<string, unknown> = {}, embedded = false) {
  const fixture = kubernetesFixture(id, preset);
  const widget = { ...fixture.widget, ...extra };
  return renderToStaticMarkup(createElement(components[id] as never, { widget, result: fixture.result, embedded } as never));
}

describe("Kubernetes plugin registration", () => {
  it("registers each family once, as a metrics plugin with intrinsic sizing", () => {
    registerKubernetesPlugins();
    registerKubernetesPlugins();
    for (const id of ids) {
      const definition = getWidgetDefinition("plugin", id);
      expect(definition?.dataKind).toBe("metrics");
      expect(definition?.sizing?.mode).toBe("intrinsic");
    }
  });
});

describe("Kubernetes plugin renderers", () => {
  for (const id of ids) for (const preset of presets) {
    it(`${id} renders ${preset} without non-finite or undefined text`, () => {
      registerKubernetesPlugins();
      const html = render(id, preset);
      expect(html).not.toMatch(/NaN|Infinity|undefined/);
      // Hover text comes from the shared observation tooltip, never a native title attribute.
      expect(html).not.toMatch(/\stitle="/);
    });
  }

  it("draws the placement as a node to pod treemap with the unrequested rest and pending pods", () => {
    registerKubernetesPlugins();
    const html = render(KUBERNETES_PLUGIN_IDS.placement, "ready");
    expect(html).toContain('role="group"');
    expect(html).toContain("Unrequested");
    expect(html).toContain("Pending");
    expect(html).not.toMatch(/<rect[^>]*data-kubernetes/);
    expect(html).toMatch(/<svg[^>]*>.*<rect/s);
  });

  it("marks every interactive mark for the shared observation owner", () => {
    registerKubernetesPlugins();
    for (const id of ids) expect(render(id, "ready")).toContain("data-observation=");
  });

  it("honours decimals in every numeric label", () => {
    registerKubernetesPlugins();
    const decimals = render(KUBERNETES_PLUGIN_IDS.placement, "ready", { options: { decimals: 1 } });
    expect(decimals).toMatch(/\d\.\d/);
  });

  it("renders no buttons when embedded", () => {
    registerKubernetesPlugins();
    for (const id of ids) expect(render(id, "ready", {}, true)).not.toContain("<button");
  });

  it("pages the throttle rows with labelled controls", () => {
    registerKubernetesPlugins();
    const html = render(KUBERNETES_PLUGIN_IDS.throttle, "ready", { config: { rows: 6 } });
    expect(html).toContain('aria-label="Next rows"');
  });

  it("says how many nodes and groups were left out", () => {
    registerKubernetesPlugins();
    const bars = render(KUBERNETES_PLUGIN_IDS.bars, "ready", { config: { groupLabel: "pod", maxGroups: 1 } });
    expect(bars).toContain("Showing 1 of");
  });
});

describe("Kubernetes renderers in the browser", () => {
  afterEach(cleanup);
  const mount = (id: KubernetesPluginId, preset: KubernetesPreset = "ready", result?: QueryResult, extra: Record<string, unknown> = {}) => {
    const fixture = kubernetesFixture(id, preset);
    const Component = components[id] as unknown as (props: { widget: Widget; result: QueryResult }) => ReactElement;
    return renderDom(createElement(Component, { widget: { ...fixture.widget, ...extra } as Widget, result: result ?? fixture.result }));
  };
  const marks = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-roving]")];

  it("gives each widget one tab stop for its marks", () => {
    for (const id of ids) {
      const { container, unmount } = mount(id);
      const all = marks(container);
      expect(all.length, id).toBeGreaterThan(1);
      expect(all.filter(mark => mark.tabIndex === 0), id).toHaveLength(1);
      unmount();
    }
  });

  it("moves between placement tiles with the arrow keys and pins one with Enter", () => {
    const { container } = mount(KUBERNETES_PLUGIN_IDS.placement);
    const tiles = marks(container);
    fireEvent.focus(tiles[0]);
    fireEvent.keyDown(tiles[0], { key: "ArrowRight" });
    expect(tiles[1]).toHaveFocus();
    expect(tiles[1].tabIndex).toBe(0);
    fireEvent.keyDown(tiles[1], { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent(tiles[1].getAttribute("aria-label")!.split(":")[0]);
  });

  it("reaches every trend column from the keyboard and pins it with Space", () => {
    const { container } = mount(KUBERNETES_PLUGIN_IDS.trend);
    const columns = marks(container);
    expect(columns[0]).toHaveAttribute("role", "button");
    expect(columns[0].getAttribute("aria-label")).toMatch(/^CPU at .*: usage .* cores, request .* cores$/);
    fireEvent.focus(columns[0]);
    fireEvent.keyDown(columns[0], { key: "End" });
    expect(columns[columns.length - 1]).toHaveFocus();
    fireEvent.keyDown(columns[0], { key: "ArrowDown" });
    const step = KUBERNETES_FIXTURE_OPTIONS.points;
    expect(columns[step]).toHaveFocus();
    fireEvent.keyDown(columns[step], { key: " " });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Memory");
  });

  it("keeps the throttle header over its columns and draws at most MAX_THROTTLE_COLUMNS cells per row", () => {
    const times = Array.from({ length: 300 }, (_, i) => KUBERNETES_FIXTURE_OPTIONS.start + i * 60000);
    const series = ["a", "b"].flatMap(pod => [
      { name: "t", labels: { pod, signal: "throttled" }, points: times.map(timestamp => ({ timestamp, value: 3 })) },
      { name: "p", labels: { pod, signal: "periods" }, points: times.map(timestamp => ({ timestamp, value: 30 })) },
    ]);
    const { container } = mount(KUBERNETES_PLUGIN_IDS.throttle, "ready", { series });
    const cells = marks(container);
    expect(cells.length).toBeLessThanOrEqual(2 * MAX_THROTTLE_COLUMNS);
    const columns = cells.length / 2;
    const heading = screen.getByText("pod");
    expect(heading.style.gridColumn).toBe(`1 / span ${columns + 1}`);
    expect(cells[0].getAttribute("aria-label")).toMatch(/ to .*: 10%$/);
  });

  it("names a node that is not ready", () => {
    mount(KUBERNETES_PLUGIN_IDS.placement, "gaps");
    expect(screen.getByText("1 node not ready")).toBeInTheDocument();
  });

  it("never fills a gap in a trend strip down to zero", () => {
    const t = (i: number) => KUBERNETES_FIXTURE_OPTIONS.start + i * 60000;
    const usage = [1, 2, null, 2, 3, null].map((value, i) => ({ timestamp: t(i), value }));
    const { container } = mount(KUBERNETES_PLUGIN_IDS.trend, "ready", { series: [{ name: "u", labels: { signal: "cpu-usage" }, points: usage }] });
    const fills = [...container.querySelectorAll('[data-trend-strip="cpu"] path[fill-opacity]')];
    // Two runs, two fills. Each closes under its own samples, never at the trailing gap's time.
    expect(fills).toHaveLength(2);
    for (const fill of fills) expect(fill.getAttribute("d")).not.toContain("L600.0 72");
  });

  it("scales bars to the largest value, not to one core", () => {
    const at = KUBERNETES_FIXTURE_OPTIONS.start;
    const series = [
      { name: "u", labels: { pod: "small", signal: "cpu-usage" }, points: [{ timestamp: at, value: 0.05 }] },
      { name: "r", labels: { pod: "small", signal: "cpu-request" }, points: [{ timestamp: at, value: 0.1 }] },
    ];
    const { container } = mount(KUBERNETES_PLUGIN_IDS.bars, "ready", { series });
    expect(marks(container)[0].style.width).toBe("50%");
  });

  it("prints placement pressure with the widget's decimals", () => {
    const { container, unmount } = mount(KUBERNETES_PLUGIN_IDS.placement, "ready", undefined, { options: { decimals: 2 } });
    expect(container.textContent).toContain("node-a · 50.00%");
    unmount();
    const whole = mount(KUBERNETES_PLUGIN_IDS.placement, "ready", undefined, { options: { decimals: 0 } });
    expect(whole.container.textContent).toContain("node-a · 50%");
  });
});

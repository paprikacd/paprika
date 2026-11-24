import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getWidgetDefinition } from "../widget-registry";
import { KUBERNETES_PLUGIN_IDS, kubernetesFixture, type KubernetesPluginId, type KubernetesPreset } from "./kubernetes-fixtures";
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

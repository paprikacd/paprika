import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_BARS_QUERY,
  PLACEMENT_QUERY,
  RESOURCE_BARS_BY_POD_QUERY,
  RESOURCE_TREND_QUERY,
  THROTTLE_BY_POD_QUERY,
} from "./kubernetes-queries";
import { KUBERNETES_PLUGIN_IDS, kubernetesFixture } from "./kubernetes-fixtures";
import { placementConfigSchema, placementModel, resourceBarsConfigSchema, resourceGroups, resourceStrips, resourceTrendConfigSchema, throttleCells, throttleConfigSchema } from "./kubernetes-data";

const starters = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../internal/insights/starters");
const read = (file: string) => JSON.parse(readFileSync(resolve(starters, file), "utf8")) as { widgets: { id: string; pluginId?: string; query: string; config?: Record<string, unknown> }[] };

const namespace = read("namespace-capacity.json");
const controlPlane = read("paprika-control-plane.json");

function widget(document: ReturnType<typeof read>, id: string) {
  const found = document.widgets.find(item => item.id === id);
  if (!found) throw new Error(`Starter widget ${id} is missing`);
  return found;
}

describe("Kubernetes starter tiles", () => {
  it("use the default queries from kubernetes-queries.ts", () => {
    expect(widget(namespace, "placement").query).toBe(PLACEMENT_QUERY);
    expect(widget(namespace, "throttle-by-pod").query).toBe(THROTTLE_BY_POD_QUERY);
    expect(widget(namespace, "resource-by-pod").query).toBe(RESOURCE_BARS_BY_POD_QUERY);
    expect(widget(namespace, "resource-trend").query).toBe(RESOURCE_TREND_QUERY);
    expect(widget(controlPlane, "container-resources").query).toBe(CONTROL_PLANE_BARS_QUERY);
  });

  it("keep the control plane free of the namespace variable", () => {
    expect(widget(controlPlane, "container-resources").query).not.toContain("{{namespace}}");
  });

  it("store configs that the adapters accept on the matching fixtures", () => {
    const placement = widget(namespace, "placement");
    expect(placementConfigSchema.parse(placement.config ?? {})).toBeTruthy();
    expect(placementModel(kubernetesFixture(KUBERNETES_PLUGIN_IDS.placement, "ready").result, placement.config as never).issues).toEqual([]);

    const bars = widget(namespace, "resource-by-pod");
    expect(resourceBarsConfigSchema.parse(bars.config ?? {})).toBeTruthy();
    expect(resourceGroups(kubernetesFixture(KUBERNETES_PLUGIN_IDS.bars, "ready").result, bars.config as never).issues).toEqual([]);

    // The control plane groups by container, which the pod-keyed fixture does not carry; the parse is the check here.
    const cp = widget(controlPlane, "container-resources");
    expect(resourceBarsConfigSchema.parse(cp.config ?? {})).toBeTruthy();

    const throttle = widget(namespace, "throttle-by-pod");
    expect(throttleConfigSchema.parse(throttle.config ?? {})).toBeTruthy();
    expect(throttleCells(kubernetesFixture(KUBERNETES_PLUGIN_IDS.throttle, "ready").result, throttle.config as never).issues).toEqual([]);

    const trend = widget(namespace, "resource-trend");
    expect(resourceTrendConfigSchema.parse(trend.config ?? {})).toBeTruthy();
    expect(resourceStrips(kubernetesFixture(KUBERNETES_PLUGIN_IDS.trend, "ready").result, trend.config as never).issues).toEqual([]);
  });
});

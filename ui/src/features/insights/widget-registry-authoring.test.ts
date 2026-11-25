import { afterEach, describe, expect, it } from "vitest";
import {
  STYLE_SECTION_IDS,
  getWidgetDefinition,
  optionSectionsFor,
  registerWidgetPlugin,
  supportsThresholds,
  type WidgetPlugin,
} from "./widget-registry";
import type { Widget } from "./schema";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";

const Renderer = () => null;
const base: Omit<WidgetPlugin, "id"> = { label: "Authoring plugin", description: "Checks style metadata", dataKind: "metrics", render: Renderer };
const unregister: (() => void)[] = [];
afterEach(() => {
  while (unregister.length) unregister.pop()!();
});
function register(id: string, extra: Partial<WidgetPlugin> = {}) {
  unregister.push(registerWidgetPlugin({ ...base, id, ...extra }));
  return getWidgetDefinition("plugin", id)!;
}

describe("style metadata validation", () => {
  it("rejects an unknown style section id", () => {
    expect(() => register("auth-bad-section", { optionSections: ["sparkle" as never] })).toThrow(/not a style section/);
  });

  it("rejects a preset with a key the dashboard schema does not know", () => {
    expect(() =>
      register("auth-bad-preset", { stylePresets: [{ id: "x", name: "X", preview: "line", options: { notAKey: true } as never }] }),
    ).toThrow(/has options the dashboard does not accept/);
  });

  it("rejects an empty or oversized starter query and a non-function suggest", () => {
    expect(() => register("auth-empty-starter", { starterQueries: [{ id: "e", label: "E", providerTypes: ["prometheus"], query: "" }] })).toThrow(/1 to 8192/);
    expect(() => register("auth-long-starter", { starterQueries: [{ id: "l", label: "L", providerTypes: ["prometheus"], query: "x".repeat(8193) }] })).toThrow(/1 to 8192/);
    expect(() => register("auth-bad-suggest", { suggest: "yes" as never })).toThrow(/suggest must be a function/);
  });

  it("accepts valid metadata and keeps it on the registered definition", () => {
    const definition = register("auth-valid", {
      optionSections: ["value", "highlight"],
      stylePresets: [{ id: "compact", name: "Compact", preview: "value", options: { showSparkline: false } }],
      starterQueries: [{ id: "up", label: "Targets up", providerTypes: ["prometheus"], query: "count(up == 1)", default: true }],
      suggest: () => 0.7,
    });
    expect(definition.optionSections).toEqual(["value", "highlight"]);
    expect(definition.stylePresets?.[0].id).toBe("compact");
    expect(definition.starterQueries?.[0].default).toBe(true);
    expect(definition.suggest?.({ series: [] })).toBe(0.7);
  });
});

describe("style sections", () => {
  it("default to every section when a renderer declares none", () => {
    const widget = { id: "w", type: "timeseries", title: "t", providerId: "p", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } } as Widget;
    expect(optionSectionsFor(widget)).toEqual(STYLE_SECTION_IDS);
  });
});

describe("supportsThresholds", () => {
  // Plugins declare thresholds in their registrations, so the answer comes from the bundled registry.
  registerDefaultWidgetPlugins();
  const widget = (type: Widget["type"], pluginId?: string, config?: Record<string, unknown>) =>
    ({ type, pluginId, config }) as Pick<Widget, "type" | "pluginId" | "config">;

  it("matches the built-in widgets that draw thresholds", () => {
    for (const type of ["heatmap", "stat", "bar", "timeseries"] as const) expect(supportsThresholds(widget(type))).toBe(true);
    expect(supportsThresholds(widget("table"))).toBe(false);
    expect(supportsThresholds(widget("traces"))).toBe(false);
  });

  it("matches the threshold gauge and the five threshold plugins", () => {
    expect(supportsThresholds(widget("plugin", "threshold-gauge"))).toBe(true);
    for (const id of ["record-table", "status-grid", "uptime-calendar", "uptime-timeline", "connection-map"]) {
      expect(supportsThresholds(widget("plugin", id))).toBe(true);
    }
    expect(supportsThresholds(widget("plugin", "some-other-plugin"))).toBe(false);
  });

  it("follows the colour mode of the incident calendar", () => {
    expect(supportsThresholds(widget("plugin", "incident-calendar", { colorMode: "thresholds" }))).toBe(true);
    expect(supportsThresholds(widget("plugin", "incident-calendar", { colorMode: "status" }))).toBe(false);
  });
});

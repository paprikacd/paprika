import { afterEach, describe, expect, it } from "vitest";
import { getWidgetDefinition, registerWidgetPlugin } from "../widget-registry";
import { operationalRecordPluginEntries, registerOperationalRecordPlugins } from "./operational-records";

const unregister: (() => void)[] = [];
afterEach(() => {
  while (unregister.length) unregister.pop()!();
});

describe("operational record plugin entries", () => {
  it("exposes the bundled record renderers with their fields and defaults, for a host to reuse", () => {
    const entries = operationalRecordPluginEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["connection-map", "pipeline-topology", "incident-calendar"]);
    const connectionMap = entries[0];
    expect(connectionMap.defaultConfig).toMatchObject({ latitude: "latitude", longitude: "longitude", label: "label", showLocations: true });
    expect(connectionMap.configFields?.map((field) => field.key)).toEqual(expect.arrayContaining(["latitude", "longitude", "label", "value", "status", "showLocations", "maxPoints"]));
  });

  it("returns the same renderers on every call, so an override replaces one entry and nothing else", () => {
    const first = operationalRecordPluginEntries();
    const second = operationalRecordPluginEntries();
    expect(first).not.toBe(second);
    expect(first.map((entry) => entry.render)).toEqual(second.map((entry) => entry.render));
  });

  it("keeps a renderer that the host registered first, while the bundled defaults fill the rest", () => {
    const Custom = () => null;
    unregister.push(registerWidgetPlugin({ id: "connection-map", label: "Zoomable map", description: "Host override", dataKind: "records", render: Custom }));
    registerOperationalRecordPlugins();
    expect(getWidgetDefinition("plugin", "connection-map")?.render).toBe(Custom);
    expect(getWidgetDefinition("plugin", "pipeline-topology")).toBeDefined();
    expect(getWidgetDefinition("plugin", "incident-calendar")).toBeDefined();
  });
});

import { describe, expect, it } from "vitest"
import { supportsDashboardSelection } from "./selection-support"

describe("selection capability shared by authoring and the canvas", () => {
  it.each(["record-treemap", "record-table", "record-list", "record-matrix", "records-line", "records-bar", "pie", "status-history", "connection-map", "geo-heatmap"])("accepts the deliberately selectable %s renderer", pluginId => {
    expect(supportsDashboardSelection({ type: "plugin", pluginId })).toBe(true)
  })
  it.each(["timeseries", "bar", "table", "heatmap", "traces"] as const)("accepts the built-in %s, which activates only on deliberate selection", type => {
    expect(supportsDashboardSelection({ type })).toBe(true);
  });
  it("keeps stat and the other built-ins outside dashboard selection", () => {
    expect(supportsDashboardSelection({ type: "stat" })).toBe(false);
  });
  it("does not activate from arbitrary plugins or non-plugin hover contexts", () => {
    expect(supportsDashboardSelection({ type: "plugin", pluginId: "distribution-heatmap" })).toBe(false)
    expect(supportsDashboardSelection({ type: "plugin", pluginId: "untrusted" })).toBe(false)
    expect(supportsDashboardSelection({ type: "stat", pluginId: "geo-heatmap" })).toBe(false)
  })
})

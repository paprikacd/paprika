import { describe, expect, it } from "vitest"
import { supportsDashboardSelection } from "./selection-support"

describe("selection capability shared by authoring and the canvas", () => {
  it.each(["record-treemap", "record-table", "record-list", "record-matrix", "records-line", "records-bar", "pie", "status-history", "connection-map", "geo-heatmap"])("accepts the deliberately selectable %s renderer", pluginId => {
    expect(supportsDashboardSelection({ type: "plugin", pluginId })).toBe(true)
  })
  it("does not activate from arbitrary plugins or non-plugin hover contexts", () => {
    expect(supportsDashboardSelection({ type: "plugin", pluginId: "distribution-heatmap" })).toBe(false)
    expect(supportsDashboardSelection({ type: "plugin", pluginId: "untrusted" })).toBe(false)
    expect(supportsDashboardSelection({ type: "timeseries", pluginId: "geo-heatmap" })).toBe(false)
  })
})

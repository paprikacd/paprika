import { describe, expect, it } from "vitest"
import { dashboardSchema, type SavedQuery } from "./schema"
import { buildDashboardBundle, parseDashboardBundle, remapBundleQueryReferences, serializeDashboardBundle } from "./workspace-transfer"
import { dashboardToOpenUI, parseOpenUIDashboard } from "./openui"
import { savedQueryCompatibility } from "./import-review"

const dashboard = dashboardSchema.parse({ schemaVersion: 1, id: "dashboard", title: "Service", timeRange: "1h", refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: "checkout" }], widgets: [{ id: "chart", title: "Requests", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: "prom", query: "up", unit: "", layout: { x: 0, y: 0, w: 8, h: 4 }, annotationSource: { queryRef: { id: "events", bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, timestampColumn: "date", endColumn: "ended_at", labelColumn: "label", severityColumn: "severity" } }] })
const events: SavedQuery = { schemaVersion: 1, id: "events", name: "Events", providerId: "db", kind: "records", query: '{"sql":"SELECT occurred_at, label FROM incidents WHERE service=$1","parameters":[{{service}}]}', parameters: [{ name: "service", type: "string" }] }

describe("portable event query references", () => {
  it("exports the secondary saved query, preserves JSON/YAML/OpenUI, and remaps copies", () => {
    const bundle = buildDashboardBundle([dashboard], [events])
    expect(bundle.savedQueries?.map(query => query.id)).toEqual(["events"])
    for (const format of ["json", "yaml"] as const)
      expect(parseDashboardBundle(serializeDashboardBundle(bundle, format), format).dashboards[0].widgets[0].annotationSource).toEqual(dashboard.widgets[0].annotationSource)
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard)).widgets[0].annotationSource).toEqual(dashboard.widgets[0].annotationSource)
    expect(remapBundleQueryReferences(bundle, { events: "events-copy" }).dashboards[0].widgets[0].annotationSource?.queryRef.id).toBe("events-copy")
    expect(() => buildDashboardBundle([dashboard], [])).toThrow(/unavailable/)
    expect(() => buildDashboardBundle([dashboard], [{ ...events, kind: "metrics" }])).toThrow(/does not provide records/)
  })
  it("detects a saved-query replacement that breaks an annotation binding", () => {
    const replacement = { ...events, query: events.query.replace("{{service}}", "{{other}}"), parameters: [{ name: "other", type: "string" as const }] }
    expect(savedQueryCompatibility(replacement, [dashboard], events).compatible).toBe(false)
  })
})

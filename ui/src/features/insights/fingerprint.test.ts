import { describe, expect, it } from "vitest"
import { documentFingerprint } from "./fingerprint"
import { dashboardSchema, type Dashboard, type Widget } from "./schema"

const widget: Widget = { id: "up", title: "Up", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 4, h: 2 } }
const document: Dashboard = { widgets: [widget], refreshInterval: 0, timeRange: "1h", title: "A", id: "a", schemaVersion: 1 }

describe("dashboard fingerprints", () => {
  it("ignores object key order introduced by validation or imports", () => {
    expect(documentFingerprint(document)).toBe(documentFingerprint(dashboardSchema.parse(document)))
    const reordered = { ...document, widgets: [{ ...widget, layout: { h: 2, w: 4, y: 0, x: 0 } }] }
    expect(documentFingerprint(reordered)).toBe(documentFingerprint(document))
  })

  it("preserves widget array order and real content changes", () => {
    const other = { ...widget, id: "another" }
    expect(documentFingerprint({ ...document, widgets: [widget, other] })).not.toBe(documentFingerprint({ ...document, widgets: [other, widget] }))
    expect(documentFingerprint({ ...document, title: "Changed" })).not.toBe(documentFingerprint(document))
  })
})

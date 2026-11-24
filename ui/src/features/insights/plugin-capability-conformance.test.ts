import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { dashboardSchema, supportsTooltipView, type Widget } from "./schema"
import { supportsDashboardSelection } from "./selection-support"
import { getRegisteredWidgetPlugins } from "./widget-registry"

// One document per widget family and document capability, with the verdict the UI reaches. The Go validator and lint
// read the same file (internal/insights/plugin_capability_conformance_test.go) and must reach the same verdicts, so a
// capability changed on one side only fails a test. Regenerate after a deliberate change with
// UPDATE_PLUGIN_CAPABILITY_CONFORMANCE=1 npx vitest run src/features/insights/plugin-capability-conformance.test.ts
const fixturePath = join(process.cwd(), "..", "docs", "design", "insights", "conformance", "plugin-capabilities.json")

interface Family { name: string; widget: Partial<Widget> }
interface Case {
  name: string
  /** Each variant adds one document feature to the family's base widget. */
  feature: "base" | "annotations" | "tooltipView" | "selection"
  dashboard: unknown
  /** Whether dashboardSchema accepts the document. */
  valid: boolean
  /** For the selection variant: whether the renderer can activate the bindings. Inactive bindings are kept and linted. */
  selectionActive?: boolean
}

const layout = { x: 0, y: 0, w: 6, h: 4 }
const builtinTypes = ["timeseries", "bar", "stat", "table", "heatmap", "traces"] as const

function families(): Family[] {
  registerDefaultWidgetPlugins()
  const plugins = getRegisteredWidgetPlugins()
    .map((plugin) => ({ name: plugin.id, widget: { type: "plugin" as const, pluginId: plugin.id, dataKind: plugin.dataKind, config: plugin.defaultConfig ?? {} } }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return [
    ...builtinTypes.map((type) => ({ name: type, widget: { type } })),
    ...plugins,
    // A host plugin the bundle does not know supports none of the capabilities on either side.
    { name: "host-plugin", widget: { type: "plugin" as const, pluginId: "host-plugin", dataKind: "metrics" as const, config: {} } },
  ]
}

function dashboard(widget: Record<string, unknown>) {
  return {
    schemaVersion: 1, id: "capabilities", title: "Capabilities", timeRange: "1h", refreshInterval: 30,
    variables: [{ name: "service" }],
    widgets: [{ id: "subject", title: "Subject", providerId: "prom", query: "up", unit: "", layout, ...widget }],
  }
}

const variants: Record<Exclude<Case["feature"], "base">, Record<string, unknown>> = {
  annotations: { annotationSource: { queryRef: { id: "deploys" }, timestampColumn: "time", labelColumn: "version" } },
  tooltipView: { options: { tooltipView: { type: "stat", source: { type: "query", providerId: "prom", query: "up" } } } },
  selection: { selectionBindings: [{ variable: "service", source: "label", value: "service" }] },
}

function cases(): Case[] {
  return families().flatMap(({ name, widget }) => {
    const base = { name, feature: "base" as const, dashboard: dashboard(widget), valid: dashboardSchema.safeParse(dashboard(widget)).success }
    return [base, ...(Object.keys(variants) as (keyof typeof variants)[]).map((feature) => {
      const document = dashboard({ ...widget, ...variants[feature] })
      return {
        name, feature, dashboard: document, valid: dashboardSchema.safeParse(document).success,
        ...(feature === "selection" ? { selectionActive: supportsDashboardSelection(widget as Widget) } : {}),
      }
    })]
  })
}

describe("plugin capability conformance", () => {
  it("records the UI verdicts for every widget family", () => {
    const current = cases()
    // Every family's base widget is a valid document, so a rejected variant is about that one feature.
    expect(current.filter((entry) => entry.feature === "base" && !entry.valid).map((entry) => entry.name)).toEqual([])
    const encoded = `${JSON.stringify({ cases: current }, null, 2)}\n`
    if (process.env.UPDATE_PLUGIN_CAPABILITY_CONFORMANCE === "1") {
      writeFileSync(fixturePath, encoded)
      return
    }
    expect(existsSync(fixturePath), "run with UPDATE_PLUGIN_CAPABILITY_CONFORMANCE=1 to write the fixture").toBe(true)
    expect(readFileSync(fixturePath, "utf8")).toBe(encoded)
  })

  it("rejects events outside the annotation capability and keeps tooltip views valid everywhere", () => {
    const current = cases()
    const annotated = current.filter((entry) => entry.feature === "annotations" && entry.valid).map((entry) => entry.name)
    expect(annotated).toEqual(["timeseries", "stat", "directional-traffic", "distribution-heatmap", "small-multiples", "stacked-timeseries", "status-history"])
    // A tooltip view on a widget that cannot show it is kept and flagged in the editor, not rejected.
    expect(current.filter((entry) => entry.feature === "tooltipView").every((entry) => entry.valid)).toBe(true)
    expect(supportsTooltipView("plugin", "geo-heatmap")).toBe(true)
    expect(supportsTooltipView("plugin", "host-plugin")).toBe(false)
  })
})

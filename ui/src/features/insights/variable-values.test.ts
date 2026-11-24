import { describe, expect, it } from "vitest"
import {
  buildDashboardURL,
  parseDashboardLink,
  resolveDashboardVariables,
  resolveLinkView,
} from "./drilldown"
import { selectionApplied } from "./selection-state"
import type { Dashboard } from "./schema"
import {
  formatVariableValue,
  normalizeVariableValue,
  regexAlternation,
  sameVariableValue,
} from "./variable-values"

const dashboard = {
  id: "service-health",
  variables: [
    { name: "cluster", options: ["omega", "delta"], multi: true, allowAll: true },
    { name: "region", options: ["eu", "us"] },
  ],
} as unknown as Dashboard

describe("normalizeVariableValue", () => {
  it("turns a string for a multi-value variable into a one-item list", () => {
    expect(normalizeVariableValue({ multi: true }, "omega")).toEqual(["omega"])
  })
  it("treats an empty list as All only when Include All is on", () => {
    expect(normalizeVariableValue({ multi: true, allowAll: true }, [])).toEqual([])
    expect(() => normalizeVariableValue({ multi: true }, [])).toThrow()
  })
  it("refuses a list for a single-value variable", () => {
    expect(() => normalizeVariableValue({}, ["omega"])).toThrow()
  })
  it("refuses duplicate items", () => {
    expect(() => normalizeVariableValue({ multi: true }, ["a", "a"])).toThrow()
  })
})

describe("resolveDashboardVariables", () => {
  it("applies a string override to a multi-value variable as one item", () => {
    expect(resolveDashboardVariables(dashboard, { cluster: "omega" })).toEqual({ cluster: ["omega"] })
  })
  it("keeps a list override in its order", () => {
    expect(resolveDashboardVariables(dashboard, { cluster: ["delta", "omega"] })).toEqual({ cluster: ["delta", "omega"] })
  })
})

describe("dashboard links with lists", () => {
  it("round-trips a list through the URL", () => {
    const url = buildDashboardURL({ dashboardId: "service-health", variables: { cluster: ["omega", "delta"], region: "eu" } })
    const parsed = parseDashboardLink(url.slice(url.indexOf("?")))
    expect(parsed.navigation?.variables).toEqual({ cluster: ["omega", "delta"], region: "eu" })
    expect(parsed.rejected).toEqual([])
  })
  it("round-trips All as an empty list", () => {
    const url = buildDashboardURL({ dashboardId: "service-health", variables: { cluster: [] } })
    expect(parseDashboardLink(url.slice(url.indexOf("?"))).navigation?.variables).toEqual({ cluster: [] })
  })
  it("reports a list for a single-value variable as invalid and keeps the rest", () => {
    const view = resolveLinkView(
      dashboard,
      { dashboardId: "service-health", variables: { region: ["eu"], cluster: ["omega"] } },
    )
    expect(view.state.variables).toEqual({ cluster: ["omega"] })
    expect(view.ignored).toContainEqual({ kind: "variable", name: "region", reason: "invalid" })
  })
})

describe("selectionApplied for a multi-value variable", () => {
  const bindings = [{ variable: "cluster", source: "label", value: "cluster" }] as const
  const scope = (cluster: string[]) => ({ dashboard, variables: { cluster } })

  it("is applied when the dashboard shows exactly the selected one-item list", () => {
    expect(selectionApplied(scope(["omega"]), [...bindings], { labels: { cluster: "omega" } })).toBe(true)
  })
  it("is not applied when the list holds more values", () => {
    expect(selectionApplied(scope(["omega", "delta"]), [...bindings], { labels: { cluster: "omega" } })).toBe(false)
  })
})

describe("list helpers", () => {
  it("escapes regex metacharacters in each alternative", () => {
    expect(regexAlternation(["a.b", "c|d"])).toBe("a\\.b|c\\|d")
  })
  it("compares lists by items and order", () => {
    expect(sameVariableValue(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameVariableValue(["a", "b"], ["b", "a"])).toBe(false)
    expect(sameVariableValue("a", ["a"])).toBe(false)
  })
  it("formats the trigger text", () => {
    expect(formatVariableValue([])).toBe("All")
    expect(formatVariableValue(["omega", "delta"])).toBe("omega, delta")
    expect(formatVariableValue(["omega-east-1", "delta-west-2", "eu-central-3"])).toBe("omega-east-1 +2")
  })
})

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { JsonValue } from "@bufbuild/protobuf"
import { describe, expect, it } from "vitest"

import { CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb"

import { dashboardSchema } from "./schema"

// Written by internal/insights TestCheckWireGolden from the real HTTP handlers,
// so this test reads the bytes the service sends. Regenerate it there with
// UPDATE_CHECKS_GOLDEN=1 when the contract changes.
type Report = { issues: JsonValue[]; total: number; truncated: boolean }
type Golden = {
  save: Report & { error: string }
  dryRun: Report
  // A dry run of a document whose layout overlaps: the lint error the save rejects on. Holes are not reported beside it.
  lintDryRun: Report
  // A successful save with ?checks=true: the stored document with its warnings in checks.
  checkedSave: Record<string, JsonValue> & { checks: Report }
}

const golden: Golden = JSON.parse(
  readFileSync(join(process.cwd(), "src/features/insights/testdata/checks-contract.golden.json"), "utf8"),
)

describe("dashboard check wire contract", () => {
  it("reads the rejected-save body through the generated types", () => {
    const report = CheckReport.fromJson({
      issues: golden.save.issues,
      total: golden.save.total,
      truncated: golden.save.truncated,
    })
    expect(report.issues).toHaveLength(2)
    expect(report.total).toBe(2)
    expect(report.truncated).toBe(false)

    const [shape, layout] = report.issues
    expect(shape.ruleId).toBe("schema.widget.options")
    expect(shape.severity).toBe(Severity.ERROR)
    expect(shape.source).toBe(Source.SCHEMA)
    expect(shape.widgetId).toBe("latency")
    expect(shape.pointer).toBe("/widgets/1/options/thresholds/1/color")
    expect(shape.message).toBe(golden.save.error)

    expect(layout.ruleId).toBe("schema.widget.layout")
    expect(layout.pointer).toBe("/widgets/0/layout/w")
    expect(layout.fix).not.toBe("")
  })

  it("keeps the dry run in the same list shape as the save body", () => {
    const listShape = ["errorCount", "infoCount", "issues", "total", "truncated", "warningCount"]
    expect(Object.keys(golden.dryRun).sort()).toEqual(listShape)
    expect(Object.keys(golden.save).filter((key) => key !== "error").sort()).toEqual(listShape)
    expect(golden.dryRun).toEqual({
      issues: golden.save.issues,
      total: golden.save.total,
      truncated: golden.save.truncated,
      errorCount: golden.save.errorCount,
      warningCount: golden.save.warningCount,
      infoCount: golden.save.infoCount,
    })
  })

  it("writes enum values as their proto names on the wire", () => {
    for (const issue of golden.save.issues) {
      expect(issue).toMatchObject({ severity: "SEVERITY_ERROR", source: "SOURCE_SCHEMA" })
    }
    for (const issue of golden.lintDryRun.issues) {
      expect(issue).toMatchObject({ source: "SOURCE_LINT" })
    }
  })

  it("reads a lint error through the generated types, with no hole reported beside it", () => {
    const report = CheckReport.fromJson({ issues: golden.lintDryRun.issues, total: golden.lintDryRun.total, truncated: golden.lintDryRun.truncated })
    expect(report.issues).toHaveLength(1)
    const [overlap] = report.issues
    expect(overlap.ruleId).toBe("layout.overlap")
    expect(overlap.severity).toBe(Severity.ERROR)
    expect(overlap.source).toBe(Source.LINT)
    expect(overlap.widgetId).toBe("b")
    expect(overlap.pointer).toBe("/widgets/1/layout")
    expect(overlap.message).toBe('"Widget b" (b) overlaps "Widget a" (a)')
    expect(overlap.fix).not.toBe("")
    expect(report.total).toBe(1)
  })

  it("keeps the checked save's document apart from its checks", () => {
    const { checks, ...document } = golden.checkedSave
    const report = CheckReport.fromJson({ issues: checks.issues, total: checks.total, truncated: checks.truncated })
    expect(report.issues.map(issue => issue.ruleId)).toEqual(["stat.density"])
    expect(report.issues.every(issue => issue.severity === Severity.WARNING)).toBe(true)
    // Without checks the body is the stored document, which the UI reads back with the dashboard schema.
    expect(dashboardSchema.parse(document).id).toBe("warn")
  })
})

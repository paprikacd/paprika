import { describe, expect, it } from "vitest"

import { CheckFinding, CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb"

// The Go service emits these exact JSON shapes (protojson, string enum names).
// This pins that the generated UI types read them and write them back unchanged.
const savedWidgetLayoutIssue = {
  ruleId: "schema.widget.layout",
  severity: "SEVERITY_ERROR",
  source: "SOURCE_SCHEMA",
  widgetId: "requests",
  pointer: "/widgets/0/layout",
  message: "widget layout is outside the dashboard grid",
  fix: "Keep x and y at least 0, y at most 1000, w from 1 to 12 with x + w at most 12, and h from 2 to 12 (1 for stat widgets).",
}

describe("generated insights check types", () => {
  it("exports the severity and source vocabulary", () => {
    expect(Severity.INFO).toBe(1)
    expect(Severity.WARNING).toBe(2)
    expect(Severity.ERROR).toBe(3)
    expect(Source.SCHEMA).toBe(1)
    expect(Source.VISUAL).toBe(4)
  })

  it("reads a service check report and keeps its finding pointers", () => {
    const report = CheckReport.fromJson({ findings: [savedWidgetLayoutIssue], total: 1, truncated: false })
    expect(report).toBeInstanceOf(CheckReport)
    expect(report.findings).toHaveLength(1)
    const finding = report.findings[0]
    expect(finding).toBeInstanceOf(CheckFinding)
    expect(finding.severity).toBe(Severity.ERROR)
    expect(finding.source).toBe(Source.SCHEMA)
    expect(finding.pointer).toBe("/widgets/0/layout")
    expect(finding.widgetId).toBe("requests")
    expect(report.toJson()).toEqual({ findings: [savedWidgetLayoutIssue], total: 1 })
  })
})

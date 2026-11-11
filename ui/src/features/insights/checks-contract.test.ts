import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { JsonValue } from "@bufbuild/protobuf"
import { describe, expect, it } from "vitest"

import { CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb"

// Written by internal/insights TestCheckWireGolden from the real HTTP handlers,
// so this test reads the bytes the service sends. Regenerate it there with
// UPDATE_CHECKS_GOLDEN=1 when the contract changes.
type Golden = {
  save: { error: string; issues: JsonValue[]; total: number; truncated: boolean }
  dryRun: { issues: JsonValue[]; total: number; truncated: boolean }
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
    expect(shape.ruleId).toBe("schema.widget.shape")
    expect(shape.severity).toBe(Severity.ERROR)
    expect(shape.source).toBe(Source.SCHEMA)
    expect(shape.widgetId).toBe("latency")
    expect(shape.pointer).toBe("/widgets/1")
    expect(shape.message).toBe(golden.save.error)

    expect(layout.ruleId).toBe("schema.widget.layout")
    expect(layout.pointer).toBe("/widgets/0/layout")
    expect(layout.fix).not.toBe("")
  })

  it("keeps the dry run in the same list shape as the save body", () => {
    expect(Object.keys(golden.dryRun).sort()).toEqual(["issues", "total", "truncated"])
    expect(golden.dryRun).toEqual({
      issues: golden.save.issues,
      total: golden.save.total,
      truncated: golden.save.truncated,
    })
  })

  it("writes enum values as their proto names on the wire", () => {
    for (const issue of golden.save.issues) {
      expect(issue).toMatchObject({ severity: "SEVERITY_ERROR", source: "SOURCE_SCHEMA" })
    }
  })
})

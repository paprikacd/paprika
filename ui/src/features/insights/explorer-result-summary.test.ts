import { describe, expect, it } from "vitest"
import { summarizeExplorerResult } from "./explorer-result-summary"

describe("Explore result summary", () => {
  it("counts real samples and missing values without confusing zero with null", () => {
    expect(summarizeExplorerResult("metrics", { series: [
      { name: "first", labels: {}, points: [{ timestamp: 1, value: 0 }, { timestamp: 2, value: null }] },
      { name: "second", labels: {}, points: [{ timestamp: 1, value: 3 }] },
    ], truncated: true })).toEqual({ detail: "2 series · 3 samples · 1 missing sample", partial: true })
  })
  it("describes returned record rows and missing cells without claiming a total", () => {
    expect(summarizeExplorerResult("records", { records: { columns: [{ key: "a", type: "number" }, { key: "b", type: "number" }], rows: [[0, null], [1, 2]], truncated: true } })).toEqual({ detail: "2 rows · 2 columns · 1 missing cell", partial: true })
  })
  it("handles empty and trace results", () => {
    expect(summarizeExplorerResult("metrics", { series: [] })).toEqual({ detail: "0 series · 0 samples", partial: false })
    expect(summarizeExplorerResult("traces", { traces: [] })).toEqual({ detail: "0 traces", partial: false })
    expect(summarizeExplorerResult("records", {})).toEqual({ detail: "0 rows · 0 columns", partial: false })
  })
})

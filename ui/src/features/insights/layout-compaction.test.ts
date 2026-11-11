import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { compactBoxes, compactDashboardLayout } from "./layout-compaction"

// Parity fixtures shared with the Go lint (internal/insights/layout_compaction_test.go).
// Each case's compacted positions come from this compactor; the Go port must produce the same.
// Regenerate after a deliberate change with UPDATE_LAYOUT_COMPACTION=1.
type Box = { id: string; x: number; y: number; w: number; h: number }
type Case = { name: string; widgets: Box[]; compacted: Box[] }
const fixturePath = join(process.cwd(), "..", "docs", "design", "insights", "conformance", "layout-compaction.json")

function toItems(widgets: Box[]) {
  return widgets.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h }))
}

describe("canvas layout compaction", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { schemaVersion: number; columns: number; cases: Case[] }

  it("matches the parity fixtures", () => {
    const computed = fixture.cases.map(item => ({
      ...item,
      compacted: compactBoxes(toItems(item.widgets)).map(({ i, x, y, w, h }) => ({ id: i, x, y, w, h })),
    }))
    if (process.env.UPDATE_LAYOUT_COMPACTION === "1") {
      writeFileSync(fixturePath, `${JSON.stringify({ ...fixture, cases: computed }, null, 2)}\n`)
      return
    }
    expect(computed).toEqual(fixture.cases)
  })

  it("keeps the authored columns", () => {
    expect(fixture.columns).toBe(12)
  })

  it("moves a stored overlap to the positions the canvas draws", () => {
    const dashboard = {
      id: "d", title: "Overlapping", widgets: [
        { id: "a", title: "A", layout: { x: 0, y: 0, w: 6, h: 4 } },
        { id: "b", title: "B", layout: { x: 4, y: 0, w: 6, h: 4 } },
      ],
    }
    const saved = compactDashboardLayout(dashboard)
    expect(saved.widgets.map(widget => widget.layout)).toEqual([
      { x: 0, y: 0, w: 6, h: 4 },
      { x: 4, y: 4, w: 6, h: 4 },
    ])
    expect(saved.widgets.map(widget => widget.title)).toEqual(["A", "B"])
    expect(dashboard.widgets[1].layout.y).toBe(0)
  })

  it("is idempotent, so a saved layout compacts to itself on the next save", () => {
    const dashboard = {
      id: "d", title: "Overlapping", widgets: [
        { id: "a", title: "A", layout: { x: 0, y: 0, w: 6, h: 4 } },
        { id: "b", title: "B", layout: { x: 4, y: 0, w: 6, h: 4 } },
        { id: "c", title: "C", layout: { x: 0, y: 1, w: 12, h: 2 } },
      ],
    }
    const once = compactDashboardLayout(dashboard)
    expect(compactDashboardLayout(once)).toEqual(once)
  })

  it("returns a dashboard that is already drawn unchanged", () => {
    const dashboard = { id: "d", widgets: [{ id: "a", layout: { x: 0, y: 0, w: 12, h: 2 } }] }
    expect(compactDashboardLayout(dashboard)).toEqual(dashboard)
  })
})

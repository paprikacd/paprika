import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { RecordFrame, Threshold } from "../schema"
import { rankRows, rankSchema, rowStatus } from "./record-ranking"
import type { TableCellStyle } from "./record-table-cells"

type Case = {
  name: string
  frame: RecordFrame
  rank: unknown
  cellStyles?: TableCellStyle[]
  thresholds?: Threshold[]
  expect: { levels: string[]; order: number[]; shown: number[]; counts: Record<string, number>; hidden: { rows: number; critical: number; warning: number } }
}

// The same cases are the Go port's contract; they live in docs/design and are read relative to this file.
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../docs/design/insights/conformance/record-ranking.json")
const fixture: { cases: Case[] } = JSON.parse(readFileSync(fixturePath, "utf8"))

describe("record ranking conformance fixtures", () => {
  it.each(fixture.cases.map(testCase => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const rank = rankSchema.parse(testCase.rank)
    const cellStyles = testCase.cellStyles ?? []
    const thresholds = testCase.thresholds
    const statuses = testCase.frame.rows.map(row => rowStatus(testCase.frame, row, rank, cellStyles, thresholds))
    expect(statuses.map(status => status.level)).toEqual(testCase.expect.levels)
    const ranked = rankRows(testCase.frame, testCase.frame.rows, rank, cellStyles, thresholds)
    expect(ranked.order).toEqual(testCase.expect.order)
    expect(ranked.shown).toEqual(testCase.expect.shown)
    expect(ranked.counts).toEqual(testCase.expect.counts)
    expect(ranked.hidden).toEqual(testCase.expect.hidden)
  })
})

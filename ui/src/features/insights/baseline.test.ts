// @vitest-environment node
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Series } from "./chart-data"
import { baselineRunsText, seriesBaselines, type BaselineWindow, type BaselineBand, type SeriesBaseline } from "./baseline"

// The shared cases are also run by the Go baseline port, so they live in docs/design and are read relative to this file.
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/baseline.json")

interface FixtureSeries { name: string; labels: Record<string, string>; points: { timestamp: number; value: number | null }[] }
interface FixtureCase {
  name: string
  window: BaselineWindow
  band: BaselineBand
  current: FixtureSeries[]
  prior: FixtureSeries[] | null
  expect: { index: number; evaluated: number; outside: number; runs: { start: number; end: number; samples: number }[]; reason?: string }[]
}
const fixture: { offsetMs: number; stepMs: number; cases: FixtureCase[] } = JSON.parse(readFileSync(fixturePath, "utf8"))

function summarise(results: SeriesBaseline[]) {
  return results.map(({ index, evaluated, outside, runs, reason }) => ({ index, evaluated, outside, runs, ...(reason ? { reason } : {}) }))
}

describe("baseline conformance fixtures", () => {
  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const results = seriesBaselines(testCase.current as Series[], testCase.prior as Series[] | undefined ?? undefined, {
      window: testCase.window,
      band: testCase.band,
      offsetMs: fixture.offsetMs,
      stepMs: fixture.stepMs,
    })
    expect(summarise(results)).toEqual(testCase.expect)
  })
})

describe("baseline run text", () => {
  const clock = (timestamp: number) => new Date(timestamp).toISOString().slice(11, 16)
  const run = (start: number) => ({ start, end: start + 120_000, samples: 3 })

  it("lists nothing without runs", () => {
    expect(baselineRunsText([], clock)).toBe("")
  })

  it("lists the latest three runs and counts the earlier ones", () => {
    const runs = [run(0), run(600_000), run(1_200_000), run(1_800_000)]
    expect(baselineRunsText(runs.slice(0, 1), clock)).toBe("00:00–00:02")
    expect(baselineRunsText(runs, clock)).toBe("00:10–00:12, 00:20–00:22, 00:30–00:32 and 1 earlier")
  })
})

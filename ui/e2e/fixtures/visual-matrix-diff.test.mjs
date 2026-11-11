import assert from "node:assert/strict"
import { test } from "node:test"
import { compareMatrix, compareRender, errorRenders, serializeBaseline } from "./visual-matrix-diff.mjs"

const render = (overrides = {}) => ({
  findings: [],
  page: { overflowPx: 0 },
  widgets: { rate: { box: [0, 0, 300, 200], state: "loaded" } },
  ...overrides,
})

test("identical renders produce no problems", () => {
  assert.deepEqual(compareRender(render(), render(), 3), [])
})

test("a gained finding fails and a lost finding fails", () => {
  const gained = compareRender(render(), render({ findings: ["visual.internal-scroll@rate:WARNING"] }), 3)
  assert.deepEqual(gained, ["+ finding visual.internal-scroll@rate:WARNING"])
  const lost = compareRender(render({ findings: ["visual.page-overflow@(page):ERROR"] }), render(), 3)
  assert.deepEqual(lost, ["- finding visual.page-overflow@(page):ERROR (no longer reported)"])
})

test("duplicate findings are compared as a multiset", () => {
  const twice = render({ findings: ["a@x:WARNING", "a@x:WARNING"] })
  assert.equal(compareRender(twice, render({ findings: ["a@x:WARNING"] }), 3).length, 1)
})

test("page overflow beyond one pixel fails in either direction", () => {
  assert.equal(compareRender(render(), render({ page: { overflowPx: 12 } }), 3).length, 1)
  assert.deepEqual(compareRender(render(), render({ page: { overflowPx: 1 } }), 3), [])
})

test("tile boxes move within tolerance and fail beyond it", () => {
  const near = render({ widgets: { rate: { box: [0, 2, 300, 201], state: "loaded" } } })
  assert.deepEqual(compareRender(render(), near, 3), [])
  const far = render({ widgets: { rate: { box: [0, 10, 300, 200], state: "loaded" } } })
  assert.deepEqual(compareRender(render(), far, 3), ['~ widget "rate" moved (dx 0px, dy +10px) relative to the canvas'])
})

test("a cascade below one moved tile is reported once, against the tile above", () => {
  const stack = below => ({ findings: [], page: { overflowPx: 0 }, widgets: {
    top: { box: [0, 0, 300, 100], state: "loaded" },
    below: { box: [0, 110 + below, 300, 100], state: "loaded" },
    lowest: { box: [0, 220 + below, 300, 100], state: "loaded" },
  } })
  // Only "below" moves (12px). "lowest" moves with it, which is the cascade, so it is not reported.
  assert.deepEqual(compareRender(stack(0), stack(12), 3), ['~ widget "below" moved (dx 0px, dy +12px) relative to the tile above it "top"'])
})

test("tiles resized by the same amount are one line", () => {
  const wide = { findings: [], page: { overflowPx: 0 }, widgets: {
    a: { box: [0, 0, 300, 100], state: "loaded" }, b: { box: [320, 0, 300, 100], state: "loaded" },
  }}
  const narrow = { findings: [], page: { overflowPx: 0 }, widgets: {
    a: { box: [0, 0, 250, 100], state: "loaded" }, b: { box: [320, 0, 250, 100], state: "loaded" },
  }}
  assert.deepEqual(compareRender(wide, narrow, 3), ['~ 2 widgets resized (dw -50px, dh 0px): "a", "b"'])
})

test("widgets added, removed and state changes are reported", () => {
  const lines = compareRender(render(), render({ widgets: { other: { box: [0, 0, 1, 1], state: "empty" } } }), 3)
  assert.ok(lines.includes('+ widget "other" added'))
  assert.ok(lines.includes('- widget "rate" removed'))
  const state = compareRender(render(), render({ widgets: { rate: { box: [0, 0, 300, 200], state: "error" } } }), 3)
  assert.deepEqual(state, ['~ widget "rate" state loaded -> error'])
})

test("missing renders on either side are problems", () => {
  const baseline = { tolerancePx: 3, renders: { a: render() } }
  const problems = compareMatrix(baseline, { renders: { b: render() } })
  assert.deepEqual(problems.map(p => p.key), ["a", "b"])
})

test("--update's guard lists renders with ERROR findings or error widgets", () => {
  const document = { renders: {
    ok: render(),
    finding: render({ findings: ["visual.clipped-text@rate:WARNING", "visual.widget-error@rate:ERROR"] }),
    errorState: render({ widgets: { rate: { box: [0, 0, 1, 1], state: "error" } } }),
  } }
  assert.deepEqual(errorRenders(document), ["finding", "errorState"])
})

test("the baseline serializes one line per widget and parses back to the same document", () => {
  const document = { schema: 1, anchor: "dashboard-canvas", tolerancePx: 3, viewportHeight: 980, renders: {
    "example/a/dark/1512": render({ widgets: { b: { box: [1, 2, 3, 4], state: "loaded" }, a: { box: [5, 6, 7, 8], state: "empty" } } }),
  } }
  const text = serializeBaseline(document)
  assert.deepEqual(JSON.parse(text), { ...document, renders: { "example/a/dark/1512": { ...document.renders["example/a/dark/1512"], widgets: { a: { box: [5, 6, 7, 8], state: "empty" }, b: { box: [1, 2, 3, 4], state: "loaded" } } } } })
  assert.match(text, /\n        "a": \{"box":\[5,6,7,8\],"state":"empty"\},\n/)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { compareMatrix, compareRender } from "./visual-matrix-diff.mjs"

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
  assert.match(compareRender(render(), far, 3)[0], /moved 10px, tolerance 3px/)
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

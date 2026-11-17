import assert from "node:assert/strict"
import { test } from "node:test"
import { contrastRatio, parseCssColor, resolveBackdrop, textContrast } from "./color-composite.mjs"

const panel = "rgb(24, 33, 39)"
const white = "rgb(255, 255, 255)"

test("parses opaque rgb and rgba colours", () => {
  assert.deepEqual(parseCssColor("rgb(24, 33, 39)"), { r: 24, g: 33, b: 39, a: 1 })
  assert.deepEqual(parseCssColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 })
})

test("parses color(srgb) with 0-1 channels and alpha", () => {
  const color = parseCssColor("color(srgb 0.929412 0.952941 0.960784 / 0.04)")
  assert.ok(Math.abs(color.r - 237) < 0.01)
  assert.ok(Math.abs(color.g - 243) < 0.01)
  assert.ok(Math.abs(color.b - 245) < 0.01)
  assert.equal(color.a, 0.04)
})

test("fully transparent colours parse as null", () => {
  assert.equal(parseCssColor("transparent"), null)
  assert.equal(parseCssColor("rgba(0, 0, 0, 0)"), null)
  assert.equal(parseCssColor("color(srgb 0 0 0 / 0)"), null)
})

test("an opaque ancestor is the backdrop and the page background is ignored", () => {
  assert.deepEqual(resolveBackdrop([panel], white), { r: 24, g: 33, b: 39, a: 1 })
})

test("translucent layers composite over the opaque ancestor", () => {
  const backdrop = resolveBackdrop(["color(srgb 0.929412 0.952941 0.960784 / 0.04)", panel], white)
  // 4% of a near-white tint over the dark panel: about 0.04 * 237 + 0.96 * 24 for red.
  assert.ok(Math.abs(backdrop.r - (0.04 * 237 + 0.96 * 24)) < 0.01)
  assert.ok(Math.abs(backdrop.g - (0.04 * 243 + 0.96 * 33)) < 0.01)
  assert.ok(Math.abs(backdrop.b - (0.04 * 245 + 0.96 * 39)) < 0.01)
})

test("with no opaque layer the page background is the base", () => {
  assert.deepEqual(resolveBackdrop(["rgba(0, 0, 0, 0.5)", "transparent"], white), { r: 127.5, g: 127.5, b: 127.5, a: 1 })
})

test("fully transparent layers leave the page background unchanged", () => {
  assert.deepEqual(resolveBackdrop(["transparent", "rgba(0, 0, 0, 0)"], panel), { r: 24, g: 33, b: 39, a: 1 })
})

test("a translucent page background is rejected", () => {
  assert.throws(() => resolveBackdrop(["transparent"], "rgba(0, 0, 0, 0.5)"), /must be opaque/)
})

test("a hover tint barely changes the reading against the real composite", () => {
  const reading = textContrast({
    foreground: "rgb(222, 196, 139)",
    layers: ["color(srgb 0.929412 0.952941 0.960784 / 0.04)", panel],
    pageBackground: white,
  })
  const plain = contrastRatio({ r: 222, g: 196, b: 139, a: 1 }, { r: 24, g: 33, b: 39, a: 1 })
  // Measured: 9.63 against the untinted panel, 8.67 against the tinted composite the browser paints.
  assert.ok(Math.abs(reading.ratio - 8.67) < 0.02, `got ${reading.ratio}`)
  assert.ok(reading.ratio < plain && plain - reading.ratio < 1.5)
})

test("a translucent foreground is composited before measuring", () => {
  const solid = textContrast({ foreground: "rgb(255, 255, 255)", layers: [panel], pageBackground: white }).ratio
  const faded = textContrast({ foreground: "rgba(255, 255, 255, 0.5)", layers: [panel], pageBackground: white }).ratio
  assert.ok(faded < solid)
})

test("contrast is symmetric and 21 for black on white", () => {
  assert.ok(Math.abs(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }) - 21) < 1e-9)
  const a = { r: 10, g: 20, b: 30, a: 1 }, b = { r: 200, g: 100, b: 50, a: 1 }
  assert.equal(contrastRatio(a, b), contrastRatio(b, a))
})

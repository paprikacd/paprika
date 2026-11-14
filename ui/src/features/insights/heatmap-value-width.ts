import { useLayoutEffect, type RefObject } from "react";

/**
 * Advance widths, in em, of the glyphs a heatmap value can show: Barlow at weight 570 with tabular figures. Each was
 * measured in Chromium on macOS at 100px on the heatmap's own value element (the advance is the box width divided by
 * 100). The ten figures share one width, which is what tabular-nums gives.
 */
const GLYPH_EM: Readonly<Record<string, number>> = {
  "0": 0.5381, "1": 0.5381, "2": 0.5381, "3": 0.5381, "4": 0.5381, "5": 0.5381, "6": 0.5381, "7": 0.5381, "8": 0.5381, "9": 0.5381,
  ".": 0.2731, ",": 0.265, "-": 0.4041, "−": 0.4911, "+": 0.4911, "%": 0.8331, "‰": 0.9669, "/": 0.447, " ": 0.2, "·": 0.2261,
  "°": 0.3781, "$": 0.567, "µ": 0.5491, "μ": 0.5572, ":": 0.355, "(": 0.3161, ")": 0.3161, "_": 0.5091,
  a: 0.522, b: 0.5591, c: 0.5311, d: 0.5591, e: 0.5411, f: 0.3761, g: 0.5491, h: 0.5441, i: 0.255, j: 0.2511, k: 0.522,
  l: 0.2391, m: 0.8291, n: 0.5441, o: 0.5561, p: 0.5631, q: 0.5631, r: 0.3761, s: 0.4931, t: 0.3741, u: 0.5411, v: 0.5041,
  w: 0.7611, x: 0.5161, y: 0.4891, z: 0.455,
  A: 0.6481, B: 0.622, C: 0.6081, D: 0.6181, E: 0.592, F: 0.5631, G: 0.6131, H: 0.637, I: 0.262, J: 0.5811, K: 0.62,
  L: 0.5711, M: 0.715, N: 0.6691, O: 0.6211, P: 0.595, Q: 0.587, R: 0.6131, S: 0.5911, T: 0.5791, U: 0.6361, V: 0.61,
  W: 0.8781, X: 0.6161, Y: 0.5991, Z: 0.5541,
}

/**
 * A character outside the table is charged 1.35em. Unmeasured Latin letters are narrower, so they are over-counted, which
 * only shrinks a value sooner. East Asian glyphs come from a fallback font at about 1em, and pictographs such as emoji are
 * about 1.2em, so this charge is what keeps authored CJK or emoji units from ellipsizing while 10px would fit.
 */
const UNKNOWN_GLYPH_EM = 1.35

/**
 * Kerning and the sub-pixel rounding of the macOS measurements make the plain sum differ from the browser by up to about
 * 0.2%, and this margin covers that. It is not a guarantee: whole-pixel glyph rounding (Linux at DPR 1) can exceed it,
 * and useHeatmapValueFit measures the rendered text and corrects the size in that case.
 */
const SAFETY = 1.01

/**
 * The width of a heatmap value in em, summed per glyph. The cell sizes a value as its width divided into the cell, so a
 * short value keeps the ceiling and a long one shrinks toward the 10px floor before it is ellipsized.
 */
export function heatmapValueEm(text: string): number {
  let em = 0
  for (const character of text) em += GLYPH_EM[character] ?? UNKNOWN_GLYPH_EM
  return em > 0 ? em * SAFETY : 1
}

/** The number of glyphs (code points) in a heatmap value, which the CSS uses for its per-glyph rounding allowance. */
export function heatmapValueGlyphs(text: string): number {
  return [...text].length
}

/** The smallest size a heatmap value is drawn at. Ellipsis applies only when the value cannot fit at this size. */
const MIN_VALUE_PX = 10

/** The width of a value's text in fractional pixels, which scrollWidth cannot report. Zero where ranges have no layout. */
function textWidth(value: HTMLElement): number {
  const range = document.createRange()
  range.selectNodeContents(value)
  return typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect().width : 0
}

/**
 * Shrinks one value until its measured text fits its box, or it reaches the 10px floor. The CSS estimate is the first
 * guess. Browsers hint and round glyph advances differently at each size (Linux at DPR 1 can be wider than the
 * fractional sum by more than half a pixel per glyph), so the estimate can still overflow. The loop only ever shrinks
 * a value, and the ellipsis stays as the last resort.
 */
function fitValue(value: HTMLElement): void {
  value.style.removeProperty("font-size")
  const box = value.getBoundingClientRect().width
  if (box <= 0) return
  let size = parseFloat(getComputedStyle(value).fontSize)
  for (let attempt = 0; attempt < 10; attempt++) {
    const natural = textWidth(value)
    if (natural <= box + 0.01 || size <= MIN_VALUE_PX) return
    size = Math.max(MIN_VALUE_PX, size * (box / natural) * 0.998)
    value.style.fontSize = `${size}px`
  }
}

/**
 * Fits every heatmap value under the container to its cell. It runs before paint whenever the value texts change
 * (key) and when the container resizes, so a value never shows at a size its measured text overflows.
 */
export function useHeatmapValueFit(container: RefObject<HTMLElement | null>, key: string): void {
  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const fit = () => {
      for (const value of root.querySelectorAll<HTMLElement>("[data-heatmap-value]")) fitValue(value)
    }
    fit()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit)
    observer?.observe(root)
    return () => observer?.disconnect()
  }, [container, key])
}

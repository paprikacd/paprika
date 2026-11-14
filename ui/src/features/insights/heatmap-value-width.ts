/**
 * Advance widths, in em, of the glyphs a heatmap value can show: Barlow at weight 570 with tabular figures. Each was
 * measured in Chromium at 100px on the heatmap's own value element (the advance is the box width divided by 100). The
 * ten figures share one width, which is what tabular-nums gives.
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

/** A glyph outside the table is charged the widest measured glyph, so an unknown character can only be over-counted. */
const UNKNOWN_GLYPH_EM = Math.max(...Object.values(GLYPH_EM))

/** Kerning and the sub-pixel rounding of the measurements make the plain sum fall short by up to 0.2%; this margin keeps
 * the estimate an upper bound, so a value sized from it never overflows its cell. */
const SAFETY = 1.01

/**
 * The width of a heatmap value in em, summed per glyph. Sizing a value as `100cqi / width` then fills its cell exactly,
 * so it shrinks to the 10px floor before it is ellipsized, and only a value that cannot fit at 10px is ellipsized.
 */
export function heatmapValueEm(text: string): number {
  let em = 0
  for (const character of text) em += GLYPH_EM[character] ?? UNKNOWN_GLYPH_EM
  return em > 0 ? em * SAFETY : 1
}

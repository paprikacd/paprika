// Contrast for text whose ancestors paint translucent backgrounds (hover tints, scrims).
// The browser side only reports computed colours; the arithmetic runs here in Node so it can be unit tested.

// Parses the computed colour forms Chromium emits: rgb(), rgba(), and color(srgb r g b / a) with 0-1 channels.
// Returns { r, g, b, a } with channels in 0-255 and alpha in 0-1, or null for fully transparent colours.
export function parseCssColor(value) {
  const text = String(value).trim()
  if (text === "transparent") return null
  let match = text.match(/^rgba?\(([^)]+)\)$/)
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) throw new Error(`Unsupported colour ${value}`)
    return finish(parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1, value)
  }
  match = text.match(/^color\(srgb\s+([^)]+)\)$/)
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) throw new Error(`Unsupported colour ${value}`)
    return finish(parts[0] * 255, parts[1] * 255, parts[2] * 255, parts.length > 3 ? parts[3] : 1, value)
  }
  throw new Error(`Unsupported computed colour ${value}`)
}

function finish(r, g, b, a, source) {
  if (![r, g, b, a].every(Number.isFinite)) throw new Error(`Unsupported colour ${source}`)
  if (a <= 0) return null
  return { r, g, b, a: Math.min(1, a) }
}

// Source-over compositing of one colour onto an opaque backdrop. Returns an opaque colour.
export function compositeOver(top, backdrop) {
  const a = top.a
  return {
    r: top.r * a + backdrop.r * (1 - a),
    g: top.g * a + backdrop.g * (1 - a),
    b: top.b * a + backdrop.b * (1 - a),
    a: 1,
  }
}

// layers: computed background strings from the innermost element outwards, stopping at the first opaque one
// (as reported by the browser walk). pageBackground: the opaque page colour used when no layer is opaque.
// Translucent layers are composited from the outermost inwards, over the opaque base.
export function resolveBackdrop(layers, pageBackground) {
  const parsed = layers.map(parseCssColor)
  let base = null
  let stack = parsed
  const opaqueIndex = parsed.findIndex(color => color && color.a >= 1)
  if (opaqueIndex >= 0) {
    base = parsed[opaqueIndex]
    stack = parsed.slice(0, opaqueIndex)
  } else {
    base = parseCssColor(pageBackground)
    if (!base || base.a < 1) throw new Error(`Page background must be opaque, got ${pageBackground}`)
  }
  let backdrop = { ...base, a: 1 }
  // Walk outermost to innermost. Transparent entries (null) contribute nothing.
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index]) backdrop = compositeOver(stack[index], backdrop)
  }
  return backdrop
}

// WCAG relative luminance for an opaque colour (0-255 channels).
export function relativeLuminance({ r, g, b }) {
  const lin = value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Contrast of a text colour against the effective backdrop it sits on. The text colour is composited
// over that backdrop first, so a translucent foreground is measured as it is painted.
export function textContrast({ foreground, layers, pageBackground }) {
  const backdrop = resolveBackdrop(layers, pageBackground)
  const ink = parseCssColor(foreground)
  const painted = ink ? compositeOver(ink, backdrop) : backdrop
  return { ratio: contrastRatio(painted, backdrop), foreground: painted, background: backdrop }
}

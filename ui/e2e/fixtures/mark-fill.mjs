// Pixel evidence for status marks. A mark's fill is counted from its own screenshot, so a frame or a covering
// colour shows up as missing fill, whatever the CSS says. The sample is inset by one device pixel on every side
// (translateX(-50%) paints about 0.6 device px outside the box, so the edge is anti-aliasing, not fill). Segmented
// lanes draw a separator on the right edge; pass trimRight (CSS px) to leave it out.
// framed defaults to the cell's data-status-stroke attribute; callers pass it when the frame belongs to a run.
export async function markFillEvidence(page, locator, { trimRight = 0, framed } = {}) {
  await locator.scrollIntoViewIfNeeded()
  const geometry = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, fill: style.backgroundColor, attributeFramed: node.hasAttribute("data-status-stroke"), dpr: window.devicePixelRatio }
  })
  const inset = 1 / geometry.dpr
  const x0 = Math.ceil(geometry.left + inset), x1 = Math.floor(geometry.right - inset - trimRight)
  const y0 = Math.ceil(geometry.top + inset), y1 = Math.floor(geometry.bottom - inset)
  const result = { ...geometry, framed: framed ?? geometry.attributeFramed, sample: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
  if (x1 - x0 < 1 || y1 - y0 < 1) return { ...result, total: 0, fill: 0, centreIsFill: false }
  const png = await page.screenshot({ clip: result.sample, animations: "disabled" })
  const counts = await page.evaluate(async ({ dataUrl, fill }) => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext("2d")
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const [r, g, b] = fill.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
    const near = i => Math.abs(data[i] - r) <= 12 && Math.abs(data[i + 1] - g) <= 12 && Math.abs(data[i + 2] - b) <= 12
    let matches = 0
    for (let i = 0; i < data.length; i += 4) if (near(i)) matches++
    const centre = ((Math.floor(canvas.height / 2)) * canvas.width + Math.floor(canvas.width / 2)) * 4
    return { total: data.length / 4, fill: matches, centreIsFill: near(centre) }
  }, { dataUrl: `data:image/png;base64,${png.toString("base64")}`, fill: geometry.fill })
  return { ...result, ...counts }
}

// Floors used by the suites: unframed marks are almost entirely fill; framed marks keep at least half their sampled area as fill.
export function fillFloor(mark) {
  return mark.framed ? 0.5 : 0.95
}

// Focus ring evidence. The ring is a separate element above the run frame: a tile-coloured gap (1 px) and then a
// text-coloured ring (2 px), outside the mark's fill. The row through the mark's centre is sampled to find ring
// pixels on each side, and the ring is compared with the gap beside it (WCAG contrast).
function luminance([r, g, b]) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export async function focusRingEvidence(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const geometry = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect(), ring = node.parentElement.querySelector(":scope > [data-history-focus-ring]")
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, dpr: window.devicePixelRatio, ring: !!ring, shadow: ring ? getComputedStyle(ring).boxShadow : "", focused: document.activeElement === node }
  })
  if (!geometry.ring) return { ...geometry, found: false }
  const colours = [...geometry.shadow.matchAll(/rgba?\(([^)]*)\)/g)].map(m => m[1].split(",").slice(0, 3).map(Number))
  const [gap, ring] = colours
  const x0 = Math.floor(geometry.left) - 4, x1 = Math.ceil(geometry.right) + 4, y = Math.floor((geometry.top + geometry.bottom) / 2)
  const png = await page.screenshot({ clip: { x: x0, y, width: x1 - x0, height: 1 }, animations: "disabled" })
  const row = await page.evaluate(async dataUrl => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext("2d")
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const out = []
    for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]])
    return out
  }, `data:image/png;base64,${png.toString("base64")}`)
  // Device column c sits at css x0 + c / dpr; the mark occupies [left, right) in css px.
  const near = (pixel, colour) => Math.abs(pixel[0] - colour[0]) <= 8 && Math.abs(pixel[1] - colour[1]) <= 8 && Math.abs(pixel[2] - colour[2]) <= 8
  let left = 0, right = 0
  row.forEach((pixel, c) => {
    const x = x0 + c / geometry.dpr
    if (!near(pixel, ring)) return
    // The ring sits within 3 css px of the mark; anything further out belongs to neighbouring samples.
    if (x < geometry.left && x >= geometry.left - 3) left++
    else if (x >= geometry.right && x < geometry.right + 3) right++
  })
  return { ...geometry, found: true, gap, ring, ringPixelsLeft: left, ringPixelsRight: right, contrast: contrastRatio(ring, gap) }
}

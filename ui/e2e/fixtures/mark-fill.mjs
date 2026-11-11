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

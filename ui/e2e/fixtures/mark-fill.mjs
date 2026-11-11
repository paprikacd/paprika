// Pixel evidence for status marks. A mark's fill is counted from its own screenshot, so a frame or a
// covering colour shows up as a missing fill, whatever the CSS says. Callers use a 2x device scale so thin marks
// have whole device pixels. Counting uses the inner box (rounded inward), so tile background is excluded.
export async function markFillEvidence(page, locator, { trimRight = 0 } = {}) {
  await locator.scrollIntoViewIfNeeded()
  const geometry = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, fill: style.backgroundColor, framed: node.hasAttribute("data-status-stroke") }
  })
  // trimRight drops a separator drawn on the mark's right edge (segmented lanes), so only fill is sampled.
  const clip = { x: Math.ceil(geometry.left), y: Math.ceil(geometry.top), width: Math.floor(geometry.right - trimRight) - Math.ceil(geometry.left), height: Math.floor(geometry.bottom) - Math.ceil(geometry.top) }
  if (clip.width < 1 || clip.height < 1) return { ...geometry, total: 0, fill: 0, centreIsFill: false }
  const png = await page.screenshot({ clip, animations: "disabled" })
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
    const near = (i, [R, G, B]) => Math.abs(data[i] - R) <= 12 && Math.abs(data[i + 1] - G) <= 12 && Math.abs(data[i + 2] - B) <= 12
    let matches = 0
    for (let i = 0; i < data.length; i += 4) {
      if (near(i, [r, g, b])) matches++
    }
    // The centre pixel must be fill whether or not a frame is drawn around the edge.
    const centre = ((Math.floor(canvas.height / 2)) * canvas.width + Math.floor(canvas.width / 2)) * 4
    return { total: data.length / 4, fill: matches, centreIsFill: near(centre, [r, g, b]) }
  }, { dataUrl: `data:image/png;base64,${png.toString("base64")}`, fill: geometry.fill })
  return { ...geometry, ...counts }
}

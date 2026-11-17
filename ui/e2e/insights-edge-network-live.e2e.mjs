// Render the synthetic network history from the real local Prometheus stack.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only an isolated local gallery is supported")
const dashboardURL = new URL("/api/insights/dashboards/local-gallery-edge-watch", origin)
const before = await fetch(dashboardURL)
const content = await before.text(), etag = before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag")
assert.ok(etag)
assert.equal(JSON.parse(content).widgets.find(widget => widget.id === "flow").config.symmetricAxis, true, "The gallery uses the authorable centered axis")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", origin).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="flow"]')
      await panel.scrollIntoViewIfNeeded()
      const plot = panel.getByRole("group", { name: /Outbound traffic below zero/ })
      await plot.waitFor()
      const axis = await plot.evaluate(element => {
        const ticks = [...element.querySelectorAll("[data-value-axis]")].map(tick => Number(tick.getAttribute("y")))
        const zero = Number(element.querySelector('line[class*="baseline"]')?.getAttribute("y1"))
        return { ticks, zero }
      })
      assert.ok(axis.ticks.length >= 3 && Math.abs(axis.zero - (axis.ticks[0] + axis.ticks.at(-1)) / 2) < .1, `Centered zero must remain halfway between the axis limits: ${JSON.stringify(axis)}`)
      await panel.locator("[data-series] path[stroke]").first().waitFor()
      const tracks = await panel.locator("[data-series]").evaluateAll(nodes => nodes.map(node => ({ name: node.getAttribute("data-series"), path: node.querySelector("path[stroke]")?.getAttribute("d") })))
      assert.equal(tracks.length, 2)
      for (const track of tracks) {
        const coordinates = [...track.path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => Number(match[2]))
        assert.ok(coordinates.length >= 20, `${track.name}: plotted history is missing`)
        const differences = coordinates.slice(1).map((value, i) => value - coordinates[i]).filter(value => Math.abs(value) > .01)
        const turns = differences.slice(1).filter((value, i) => value * differences[i] < 0).length
        assert.ok(turns >= 5, `${track.name}: expected visible minute-scale peaks; found ${turns}`)
      }
      await plot.focus()
      const details = page.getByRole("region", { name: "Observation details" })
      await details.waitFor()
      assert.ok(await details.locator("[data-metric-value]").count(), "Keyboard inspection must show an actual observation")
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: directional history and keyboard observation`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(dashboardURL)
assert.equal(await after.text(), content)
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)

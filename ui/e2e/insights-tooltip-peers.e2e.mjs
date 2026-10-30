// Exact comparisons must come from plotted observations, not interpolation.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { selectGammaOption } from "./gamma-controls.mjs"

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/tooltip-peers", import.meta.url)))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })
    try {
      const page = await context.newPage(), responses = [], errors = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("response", response => {
        if (response.url().endsWith("/api/insights/query") && response.status() === 200) responses.push(response.json().catch(() => null))
      })
      await installRichChartFixtureAPI(page, base)
      await page.goto(base + "/dashboard/insights/?dashboard=example-artboard-fleet-atlas", { waitUntil: "networkidle" })
      await page.getByRole("heading", { name: "Fleet Atlas · Test fixture", exact: true }).waitFor()
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="node-cpu"]')
      await tile.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      const plot = tile.getByRole("img", { name: "CPU utilization by node", exact: true })
      await plot.focus()
      const tip = page.getByRole("tooltip")
      await tip.getByText("Other plotted series at this time").waitFor()
      const timestamp = Number(await tip.locator("[data-observation-timestamp]").getAttribute("data-observation-timestamp"))
      const selected = await tip.locator("[data-observation-series]").getAttribute("data-observation-series")
      const peers = await tip.locator("[data-peer-series]").evaluateAll(nodes => nodes.map(node => ({
        name: node.dataset.peerSeries, value: Number(node.dataset.peerValue), timestamp: Number(node.dataset.peerTimestamp),
        color: getComputedStyle(node.querySelector("i")).backgroundColor,
      })))
      assert.equal(peers.length, 5)
      assert.ok(peers.every(peer => peer.timestamp === timestamp && peer.name !== selected && Number.isFinite(peer.value) && peer.color !== "rgba(0, 0, 0, 0)"))
      await plot.press("Enter")
      const expand = tip.getByRole("button", { name: "Show 1 more plotted series" })
      await expand.click()
      assert.equal(await tip.locator("[data-peer-series]").count(), 6)
      await tip.getByRole("button", { name: "Show fewer plotted series" }).click()
      assert.equal(await tip.locator("[data-peer-series]").count(), 5)
      const results = (await Promise.all(responses)).filter(Boolean).flatMap(result => result.series ?? [])
      for (const peer of peers) {
        const source = results.find(series => series.name === peer.name)
        assert.ok(source, `Peer series must be present in the query response: ${peer.name}`)
        assert.ok(source.points.some(point => point.timestamp === timestamp && point.value === peer.value), "Peer must be an exact observation")
      }
      const bounds = await tip.boundingBox(), viewport = page.viewportSize()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1)
      await page.screenshot({ path: `${output}/${theme.toLowerCase()}-${width}.png` })
      await plot.press("ArrowRight")
      const nextTimestamp = Number(await tip.locator("[data-observation-timestamp]").getAttribute("data-observation-timestamp"))
      const nextRows = await tip.locator("[data-peer-timestamp]").evaluateAll(nodes => nodes.map(node => Number(node.dataset.peerTimestamp)))
      assert.ok(nextRows.every(value => value === nextTimestamp))
      await plot.press("Escape")
      await tip.waitFor({ state: "hidden" })
      // Scroll can move a different widget beneath a stationary pointer while
      // a chart retains keyboard focus. Only the new transient preview remains.
      const stat = page.locator('[data-widget-id="pressure"]')
      await stat.scrollIntoViewIfNeeded()
      await stat.getByRole("button", { name: "Inspect value for Nodes under pressure" }).hover()
      await page.waitForFunction(() => document.querySelectorAll('[role="tooltip"]').length === 1 &&
        [...document.querySelectorAll('[role="tooltip"]')].some(node => node.textContent.includes("Nodes under disk pressure")))
      await page.getByRole("tooltip").waitFor()
      assert.equal(await page.getByRole("tooltip").count(), 1)
      await plot.press("Escape")
      await page.getByRole("tooltip").waitFor({ state: "hidden" })
      assert.deepEqual(errors, [])
      console.log(`PASS exact coincident series: ${theme} ${width}px`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}

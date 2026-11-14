// Exact comparisons must come from plotted observations, not interpolation.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { chartFixtures } from "./fixtures/rich-chart-data.ts"
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
      const fixtureAPI = await installRichChartFixtureAPI(page, base)
      const board = fixtureAPI.documents.get("example-artboard-fleet-atlas")
      const widget = board.widgets.find(widget => widget.id === "node-cpu")
      widget.options = { ...widget.options, tooltipTitle: "Node observations", tooltipValueLabel: "Utilization", tooltipDecimals: 3 }
      const query = fixtureAPI.savedQueries.get(widget.queryRef.id).query
      const metric = query.slice(0, query.indexOf("{")), fixture = chartFixtures.find(entry => entry.metric === metric)
      assert.ok(fixture?.series?.length, "The semantic-label check requires the saved node-query fixture")
      // Exercise provider-generated identities through the normal HTTP contract.
      // The same shared resolver must name the legend and the selected/peer rows.
      fixture.series = fixture.series.map(source => ({ ...source,
        name: metric + "{" + Object.entries(source.labels).filter(([key]) => key !== "__name__").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ") + "}",
      }))
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
      const legend = new Map(await tile.getByRole("list", { name: "Latest values by series" }).getByRole("listitem").evaluateAll(rows => rows.map(row => [row.title, {
        label: [...row.querySelectorAll('[aria-hidden="true"]')].map(node => node.textContent.trim()).find(Boolean),
        timestamp: Number(row.querySelector("[data-legend-timestamp]").dataset.legendTimestamp),
      }])))
      assert.ok(legend.get(selected)?.label, "The selected series must have a resolved legend label")
      await tip.getByText(`Selected series · ${legend.get(selected).label}`, { exact: true }).waitFor()
      await tip.getByText("Node observations", { exact: true }).waitFor()
      await tip.getByText("Utilization", { exact: true }).waitFor()
      assert.ok(timestamp < legend.get(selected).timestamp, "The inspector must retain an older observation independently of the latest legend reading")
      const peers = await tip.locator("[data-peer-series]").evaluateAll(nodes => nodes.map(node => ({
        name: node.dataset.peerSeries, value: Number(node.dataset.peerValue), timestamp: Number(node.dataset.peerTimestamp),
        label: node.querySelector("summary").innerText,
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
      const selectedSource = results.find(series => series.name === selected)
      assert.ok(selectedSource, "The selected series must retain its full provider identity")
      assert.equal(legend.get(selected).label, selectedSource.labels.node, "The selected context must identify the real node")
      const selectedValue = Number(await tip.locator("[data-observation-value]").getAttribute("data-observation-value"))
      assert.ok(selectedSource.points.some(point => point.timestamp === timestamp && point.value === selectedValue), "The selected value must be the exact historical observation")
      for (const peer of peers) {
        const source = results.find(series => series.name === peer.name)
        assert.ok(source, `Peer series must be present in the query response: ${peer.name}`)
        assert.equal(peer.label, source.labels.node, "A peer must show its semantic identity, not a numbered placeholder")
        assert.equal(peer.label, legend.get(peer.name)?.label, "Peer and legend labels must agree")
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
      // A stat whose samples vary keeps its sparkline; a constant one shows "Steady" instead, with no history to hover.
      const stat = page.locator('[data-widget-id="memory"]')
      await stat.scrollIntoViewIfNeeded()
      await stat.getByRole("img", { name: "History for Memory used" }).hover()
      await page.waitForFunction(() => document.querySelectorAll('[role="tooltip"]').length === 1 &&
        [...document.querySelectorAll('[role="tooltip"]')].some(node => node.textContent.includes("Cluster memory utilization")))
      await page.getByRole("tooltip").waitFor()
      assert.equal(await page.getByRole("tooltip").count(), 1)
      await plot.press("Escape")
      await page.getByRole("tooltip").waitFor({ state: "hidden" })
      assert.deepEqual(errors, [])
      assert.deepEqual(fixtureAPI.failures, [])
      console.log(`PASS exact coincident series: ${theme} ${width}px`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}

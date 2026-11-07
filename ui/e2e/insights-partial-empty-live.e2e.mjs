// Exercise incomplete, complete empty and zero-valued results through the
// isolated Insights/Observe stack and a loopback Prometheus warning fixture.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium } from "playwright"

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"))
assert.equal(receipt.syntheticData, true)
const origin = new URL(receipt.url)
assert.equal(origin.hostname, "127.0.0.1")
const api = async (path, init) => {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const providers = (await (await api("/api/insights/providers")).json()).providers
const provider = providers.find(item => item.providerRef === "observability/warning-prometheus")
assert.ok(provider?.capabilities.includes("metrics"))
const id = `partial-ui-${Date.now()}`
const widget = (id, query, x, extra = {}) => ({ id, title: id, type: "stat", providerId: provider.id, query, unit: "", layout: { x, y: 0, w: 3, h: 3 }, ...extra })
const document = { schemaVersion: 1, id, title: "Partial response UI test", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [
  widget("partial", "partial_fixture", 0), widget("empty", "empty_fixture", 3), widget("zero", "zero_fixture", 6),
  widget("partial-plugin", "partial_fixture", 9, { type: "plugin", pluginId: "status-history", dataKind: "metrics", config: {} }),
] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      for (const id of ["partial", "empty", "zero", "partial-plugin"]) {
        const tile = page.locator(`[data-widget-id="${id}"]`)
        await tile.scrollIntoViewIfNeeded()
        if (id.startsWith("partial")) {
          await tile.getByText("No observations returned").waitFor()
          await tile.getByText(/provider response may be incomplete/i).waitFor()
          assert.equal(await tile.getByText("No data in this time range").count(), 0)
        } else if (id === "empty") {
          await tile.getByText("No data in this time range").waitFor()
          assert.equal(await tile.getByText(/provider response may be incomplete/i).count(), 0)
        } else {
          await tile.locator('[data-metric-value="0"]').waitFor()
        }
      }
      assert.deepEqual(errors, [])
      console.log(`PASS incomplete empty UI ${theme} ${width}px: source limit, complete empty and zero`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}

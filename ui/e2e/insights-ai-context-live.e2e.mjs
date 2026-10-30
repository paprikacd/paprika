// The copied AI prompt must reflect the actual registered controls and the
// saved dashboard, using the real isolated Insights service and providers.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is permitted")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => {
      localStorage.setItem("paprika-insights-theme", theme)
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__copiedPrompt = text } } })
    }, theme)
    try {
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-reliability-room", origin).href, { waitUntil: "networkidle" })
      await page.getByRole("button", { name: "Build with AI", exact: true }).click()
      const panel = page.getByRole("region", { name: "Build with AI", exact: true })
      await panel.getByRole("textbox", { name: "What would you like to build?" }).fill("Show a grouped treemap and a horizontal gauge bank.")
      await panel.getByRole("button", { name: "Copy AI prompt", exact: true }).click()
      await panel.getByText("Prompt copied. Paste it into your preferred AI assistant.").waitFor()
      const prompt = await page.evaluate(() => window.__copiedPrompt)
      assert.match(prompt, /Keep timeRange in 15m, 30m, 1h, 6h, 24h, 7d, 30d/)
      assert.ok(prompt.includes("PostgreSQL uses a JSON query with sql and optional parameters"))
      assert.ok(!prompt.includes("Prometheus PromQL query displayed as plugin"))
      assert.ok(prompt.includes("local-gallery-reliability-room"), "The selected saved dashboard must be included")
      const plugins = JSON.parse(prompt.split("Installed trusted widget plugins:\n")[1].split("\n\nAvailable providers")[0])
      const gauge = plugins.find(plugin => plugin.id === "threshold-gauge")
      const tree = plugins.find(plugin => plugin.id === "record-treemap")
      const history = plugins.find(plugin => plugin.id === "status-history")
      const traffic = plugins.find(plugin => plugin.id === "directional-traffic")
      assert.ok(gauge.configFields.some(field => field.key === "showStatus" && field.kind === "boolean"))
      assert.ok(gauge.configFields.some(field => field.key === "seriesMode" && field.options.some(option => option.value === "all")))
      assert.ok(tree.configFields.some(field => field.key === "group"))
      assert.ok(tree.configFields.some(field => field.key === "colorField" && field.recordColumn === "number"))
      assert.ok(history.configFields.some(field => field.key === "labelField" && field.kind === "text"))
      assert.ok(history.configFields.some(field => field.key === "segmented" && field.kind === "boolean"))
      assert.ok(traffic.configFields.some(field => field.key === "symmetricAxis" && field.kind === "boolean"), "AI context must expose the centered directional axis")
      assert.deepEqual(errors, [])
      console.log(`PASS AI prompt ${theme} ${width}px: saved dashboard, presets and plugin configuration`)
    } finally { await context.close() }
  }
} finally { await browser.close() }

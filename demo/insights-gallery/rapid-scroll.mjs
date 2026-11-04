// Read-only, non-gating local diagnostic for query admission under navigation.
// Results describe this particular run; they are not production benchmarks.
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"
const { chromium } = createRequire(new URL("../../ui/package.json", import.meta.url))("playwright")
const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password || origin.search || origin.hash) throw Error("A literal loopback gallery URL is required")
const iterations = Number(process.argv[3] || 3)
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) throw Error("Iterations must be an integer between 1 and 10")
const boards = ["service-pulse", "fleet-atlas", "edge-watch", "market-lens", "reliability-room", "collection-control", "signal-kit", "availability-lab"]
const browser = await chromium.launch({ headless: true }), outcomes = []
try {
  for (let i = 0; i < iterations; i++) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce" })
    try {
      const page = await context.newPage(), failures = []
      page.setDefaultTimeout(30000)
      let rejected = 0, aborted = 0, queries = 0, expectedQueryErrors = 0
      page.on("response", response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || response.request().method() !== "POST") return
        if (response.status() === 429) rejected++
        else if (!response.ok()) {
          let expected = false
          try { expected = response.request().postDataJSON().query === "rate(" && response.status() === 502 } catch { /* Report unrecognized failures. */ }
          if (expected) expectedQueryErrors++
          else failures.push(`HTTP ${response.status()}`)
        }
      })
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/insights/query" && request.method() === "POST") queries++ })
      page.on("requestfailed", request => { if (new URL(request.url()).pathname === "/api/insights/query" && request.method() === "POST") aborted++ })
      page.on("pageerror", error => failures.push(`Page error: ${error.message}`))
      const start = performance.now()
      for (const board of boards) {
        await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-${board}`, { waitUntil: "networkidle" })
        for (const widget of await page.locator("[data-widget-id]").all()) {
          await widget.scrollIntoViewIfNeeded()
          await widget.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
          await widget.getByRole("status", { name: "Loading widget" }).waitFor({ state: "hidden" })
          const id = await widget.getAttribute("data-widget-id")
          if (board === "signal-kit" && id === "expected-empty") {
            await widget.getByText("No data in this time range").waitFor()
            if (await widget.getByText("Query failed", { exact: true }).count()) failures.push("Signal Kit expected-empty state")
          } else if (board === "signal-kit" && id === "expected-error") {
            await widget.getByText("Query failed", { exact: true }).waitFor()
            if (await widget.getByText("No data in this time range").count()) failures.push("Signal Kit expected-error state")
          } else if (await widget.getByText(/Widget could not render|Query failed|No data in this time range/).count()) failures.push(`Visible widget: ${board}`)
        }
        await page.waitForLoadState("networkidle")
      }
      if (!expectedQueryErrors) failures.push("Signal Kit expected query error was not observed")
      outcomes.push({ durationMs: Math.round(performance.now() - start), rejected, aborted, queries, expectedQueryErrors, failures })
    } finally { await context.close() }
  }
} finally { await browser.close() }
console.log(JSON.stringify({ origin: origin.origin, outcomes }, null, 2))
if (outcomes.some(item => item.failures.length)) process.exitCode = 1

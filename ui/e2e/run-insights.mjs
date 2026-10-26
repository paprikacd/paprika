// Starts an isolated Next dev server unless INSIGHTS_E2E_URL points to one.
// Run from ui/: node e2e/run-insights.mjs
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"

const uiDirectory = fileURLToPath(new URL("../", import.meta.url))
let next
let child
let nextOutput = ""

async function stop(process) {
  if (!process || process.exitCode !== null) return
  const exited = once(process, "exit")
  process.kill("SIGTERM")
  const force = setTimeout(() => process.kill("SIGKILL"), 5000)
  force.unref()
  await exited
  clearTimeout(force)
}

async function cleanup() { await stop(child); await stop(next) }
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(130)) })
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(143)) })

async function freePort() {
  const socket = createServer()
  socket.listen(0, "127.0.0.1")
  await once(socket, "listening")
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return port
}

async function run(script, baseURL) {
  child = spawn(process.execPath, [script], {
    cwd: uiDirectory,
    env: { ...process.env, INSIGHTS_E2E_URL: baseURL },
    stdio: "inherit",
  })
  const [code] = await once(child, "exit")
  child = undefined
  if (code !== 0) throw new Error(`${script} failed with exit code ${code}`)
}

try {
  let baseURL = process.env.INSIGHTS_E2E_URL
  if (!baseURL) {
    const port = await freePort()
    baseURL = `http://127.0.0.1:${port}`
    next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: uiDirectory,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const capture = (data) => { nextOutput = (nextOutput + data).slice(-8000) }
    next.stdout.on("data", capture)
    next.stderr.on("data", capture)
    const deadline = Date.now() + 90_000
    let ready = false
    while (Date.now() < deadline) {
      if (next.exitCode !== null) throw new Error(`Next exited before becoming ready:\n${nextOutput}`)
      try {
        const response = await fetch(`${baseURL}/dashboard/insights/?example=1`, { signal: AbortSignal.timeout(5000) })
        if (response.ok) { ready = true; break }
      } catch { /* Compilation and socket startup may still be in progress. */ }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) throw new Error(`Next was not ready after 90 seconds:\n${nextOutput}`)
    console.log(`Insights E2E server ready at ${baseURL}`)
  }
  await run("e2e/insights.e2e.mjs", baseURL)
  await run("e2e/insights-advanced.e2e.mjs", baseURL)
  await run("e2e/insights-responsive.e2e.mjs", baseURL)
  await run("e2e/insights-live.e2e.mjs", baseURL)
  await run("e2e/insights-live-editing.e2e.mjs", baseURL)
  await run("e2e/insights-drilldown.e2e.mjs", baseURL)
  await run("e2e/insights-variable-filter.e2e.mjs", baseURL)
  await run("e2e/insights-widget-audit.e2e.mjs", baseURL)
  await run("e2e/insights-builder.e2e.mjs", baseURL)
  await run("e2e/insights-tooltip-query.e2e.mjs", baseURL)
  await run("e2e/insights-explorer.e2e.mjs", baseURL)
  await run("e2e/insights-observability.e2e.mjs", baseURL)
  await run("e2e/insights-portable.e2e.mjs", baseURL)
  await run("e2e/insights-import-review.e2e.mjs", baseURL)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await cleanup()
}

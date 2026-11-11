// Design playground for Paprika Insights: `npm run insights:lab` from ui/.
// Starts next dev (hot reload) and the Insights/Observe harness. Chart data comes
// from the same JavaScript fixtures the Playwright review uses, served over
// loopback HTTP, so any browser can open the printed link. Ctrl-C stops everything
// this command started. Synthetic data only; documents are discarded on exit.
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs"
import { polishDashboards, polishQuery } from "./fixtures/dashboard-polish.mjs"
import { startQueryFixtureServer } from "./fixtures/query-fixture-server.mjs"

const uiDirectory = fileURLToPath(new URL("../", import.meta.url))
const repository = resolve(uiDirectory, "..")
const cacheDirectory = join(repository, "artifacts/insights/lab")
const harnessBinary = join(cacheDirectory, "observe-e2e")
const harnessStamp = join(cacheDirectory, "observe-e2e.sha256")
const tokenTTL = process.env.INSIGHTS_LAB_SESSION || "12h"
const firstDashboard = "local-polish-service"
const skipped = new Set(["node_modules", ".git", ".next", ".worktrees", "artifacts", "output", "ui"])

const cleanups = []
let nextServer
let nextOutput = ""

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 5000)
  try { await exited } finally { clearTimeout(force) }
}

async function cleanup() {
  while (cleanups.length) await cleanups.pop()()
}

async function freePort() {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

// Fingerprint every Go source and module file the harness can import from this
// repository, so an edit anywhere under internal/ or hack/ rebuilds the cache.
async function goFingerprint(directory, hash) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) await goFingerprint(join(directory, entry.name), hash)
      continue
    }
    if (!entry.isFile() || !/\.go$|^go\.(mod|sum)$/.test(entry.name)) continue
    const path = join(directory, entry.name)
    hash.update(relative(repository, path)).update("\0").update(await readFile(path)).update("\0")
  }
  return hash
}

async function ensureHarness() {
  const hash = await goFingerprint(repository, createHash("sha256"))
  const fingerprint = hash.digest("hex")
  const previous = await readFile(harnessStamp, "utf8").catch(() => "")
  if (previous.trim() === fingerprint && await stat(harnessBinary).then(() => true, () => false)) {
    console.log("Reusing the cached Insights harness (Go sources unchanged).")
    return harnessBinary
  }
  console.log("Building the Insights harness…")
  await mkdir(cacheDirectory, { recursive: true })
  const partial = `${harnessBinary}.partial`
  const build = spawn("go", ["build", "-o", partial, "./hack/insights-observe-e2e"], { cwd: repository, stdio: ["ignore", "inherit", "inherit"] })
  const [code] = await once(build, "exit")
  if (code !== 0) throw new Error(`go build failed with exit code ${code}`)
  await rename(partial, harnessBinary)
  await writeFile(harnessStamp, `${fingerprint}\n`)
  return harnessBinary
}

async function startNext(port) {
  nextServer = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: uiDirectory,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanups.push(() => stopProcess(nextServer))
  const capture = data => { nextOutput = (nextOutput + data).slice(-8000) }
  nextServer.stdout.on("data", capture)
  nextServer.stderr.on("data", capture)
  const baseURL = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (nextServer.exitCode !== null) throw new Error(`next dev exited before becoming ready:\n${nextOutput}`)
    try {
      const response = await fetch(`${baseURL}/dashboard/insights/`, { signal: AbortSignal.timeout(10_000) })
      if (response.ok) return baseURL
    } catch { /* Compilation and socket startup may still be in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`next dev was not ready after 120 seconds:\n${nextOutput}`)
}

async function main() {
  const binary = await ensureHarness()
  const fixtures = await startQueryFixtureServer(request => polishQuery(request))
  cleanups.push(() => fixtures.close())
  const uiURL = await startNext(await freePort())
  const environment = await createReferenceDashboardEnvironment(repository, uiURL, {
    binary,
    queryFixtureURL: fixtures.url,
    labEntry: true,
    tokenTTL,
  })
  cleanups.push(() => environment.close())
  const boards = polishDashboards(environment.providerIds.metrics)
  for (const board of boards) await environment.api(`dashboards/${board.id}`, "PUT", board, { "If-None-Match": "*" })
  console.log([
    "",
    "Insights design playground is running. Synthetic observations; edits last until you stop it.",
    "",
    `  Open once in your browser: ${environment.labEntryURL(`/dashboard/insights/?dashboard=${firstDashboard}`)}`,
    "",
    "The link works once per start and expires after 15 minutes. Restart the lab for another.",
    `Hot reload: edits under ui/src apply on save. Session lasts ${tokenTTL}. Stop with Ctrl-C.`,
    "",
  ].join("\n"))
}

try {
  await main()
  // Run until Ctrl-C, or until next dev exits on its own.
  const interrupted = once(process, "SIGINT").catch(() => {})
  const stopped = await Promise.race([
    interrupted.then(() => "interrupt"),
    once(nextServer, "exit").then(([code]) => `next dev stopped (${code})`),
  ])
  if (stopped !== "interrupt") {
    console.error(`${stopped}. The lab is stopping.`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await cleanup()
}

// Design playground for Paprika Insights: `npm run insights:lab` from ui/.
// Starts next dev (hot reload) and the Insights/Observe harness. Chart data comes
// from the JavaScript fixtures the Playwright review uses, served over loopback
// HTTP, so any browser can open the printed link. Ctrl-C, SIGTERM or SIGHUP stops
// everything this command started and removes its temporary workspace. Synthetic
// data only; documents and the harness credentials are discarded on exit.
//
// Cannot run while another `next dev` uses ui/.next (for example `npm run dev`):
// stop that server first. The lab reports this when next dev refuses to start.
import { once } from "node:events"
import { mkdir, mkdtemp, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs"
import { polishDashboards } from "./fixtures/dashboard-polish.mjs"
import { referenceQueryResolver, startQueryFixtureServer } from "./fixtures/query-fixture-server.mjs"
import { createRunSupervisor, recoverOrphans } from "./fixtures/lab-process.mjs"

const uiDirectory = fileURLToPath(new URL("../", import.meta.url))
const repository = resolve(uiDirectory, "..")
const cacheDirectory = join(repository, "artifacts/insights/lab")
const harnessBinary = join(cacheDirectory, "observe-e2e")
const recordDirectory = join(repository, "artifacts/insights/runs")
const allowedRoots = [join(repository, "artifacts"), tmpdir()]
const tool = "insights-lab"
const tokenTTL = process.env.INSIGHTS_LAB_SESSION || "12h"
const firstDashboard = "local-polish-service"
const log = message => console.error(message)
const supervisor = createRunSupervisor({ tool, recordDirectory, allowedRoots, log })

async function freePort() {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

// Always invoke go build: its build cache makes an unchanged rebuild fast, and
// a content hash of our own would miss files the harness embeds (for example
// docs/design/insights/*.schema.json).
async function buildHarness() {
  await mkdir(cacheDirectory, { recursive: true })
  const partial = `${harnessBinary}.partial-${process.pid}`
  const build = supervisor.spawnChild("go build", "go", ["build", "-o", partial, "./hack/insights-observe-e2e"], { cwd: repository, stdio: ["ignore", "inherit", "inherit"] })
  const [code] = await once(build, "exit")
  if (code !== 0) throw new Error(`go build failed with exit code ${code}`)
  await rename(partial, harnessBinary)
  return harnessBinary
}

const lockHint = "Another next dev is already using ui/.next (for example `npm run dev`). Stop it, then run `npm run insights:lab` again."

async function startNext(port) {
  let output = ""
  const next = supervisor.spawnChild("next dev", process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: uiDirectory,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const capture = data => { output = (output + data).slice(-8000) }
  next.stdout.on("data", capture)
  next.stderr.on("data", capture)
  const baseURL = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (next.exitCode !== null || next.signalCode !== null) {
      const hint = /lock|already running|another next dev/i.test(output) ? `\n${lockHint}` : ""
      throw new Error(`next dev exited before becoming ready.${hint}\n${output}`)
    }
    try {
      const response = await fetch(`${baseURL}/dashboard/insights/`, { signal: AbortSignal.timeout(10_000) })
      if (response.ok) {
        next.once("exit", (code, signal) => supervisor.requestShutdown(1, `next dev stopped (${code ?? signal})`))
        return baseURL
      }
    } catch { /* Compilation and socket startup may still be in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`next dev was not ready after 120 seconds.\n${output}`)
}

async function main() {
  supervisor.installSignalHandlers()
  await recoverOrphans({ tool, recordDirectory, allowedRoots, log })
  const binary = await buildHarness()
  const workspace = await mkdtemp(join(tmpdir(), "paprika-reference-dashboards-"))
  supervisor.addRemovePath(workspace)
  const fixtures = await startQueryFixtureServer(referenceQueryResolver)
  supervisor.addCleanup(() => fixtures.close())
  const uiURL = await startNext(await freePort())
  const environment = await createReferenceDashboardEnvironment(repository, uiURL, {
    binary,
    workspace,
    queryFixtureURL: fixtures.url,
    labEntry: true,
    tokenTTL,
    onSpawn: child => supervisor.adopt("harness", child),
    onUnexpectedExit: ({ code, signal, diagnostics }) => {
      // A shutdown stops the harness on purpose; only an exit while running is a failure.
      if (supervisor.stopping) return
      log(`The Insights harness stopped (${code ?? signal}). Last output:\n${diagnostics.trim().split("\n").slice(-12).join("\n")}`)
      supervisor.requestShutdown(1, "harness stopped")
    },
  })
  supervisor.addCleanup(() => environment.close())
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
} catch (error) {
  log(error.message)
  await supervisor.requestShutdown(1, "startup failed")
}

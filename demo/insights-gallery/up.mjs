#!/usr/bin/env node
// One command for the real-provider gallery: start.py (isolated Docker providers),
// a loopback static UI export, and serve.mjs with a 12-hour session. The browser
// reaches the proxy without a credential; the bearer token stays inside serve.mjs
// and is never written to the printed output or to the environment file.
//
//   node demo/insights-gallery/up.mjs            # from the repository root
//   node demo/insights-gallery/up.mjs --rebuild-ui
//
// Ctrl-C stops the proxy, the static server and this run's containers. The
// synthetic Prometheus volume is kept; see demo/insights-gallery/README.md.
import { spawn } from "node:child_process"
import { once } from "node:events"
import { access, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../..")
const uiDirectory = join(root, "ui")
const uiExport = join(uiDirectory, "out")
const sessionDuration = "12h"
const rebuildUI = process.argv.includes("--rebuild-ui")
const children = []
let stateDirectory
let interrupted = false
let stopping

const log = message => console.log(message)

function fail(message) {
  throw new Error(message)
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

async function freePort() {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options })
  children.push(child)
  return child
}

async function waitFor(check, label, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(done => setTimeout(done, 250))
  }
  fail(`Timed out waiting for ${label}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 8000)
  try { await exited } finally { clearTimeout(force) }
}

// Idempotent: a Ctrl-C and the normal exit path may both ask for a stop.
function stopGallery() {
  stopping ??= (async () => {
    for (const child of children.splice(0).reverse()) await stopChild(child)
    if (stateDirectory) {
      // Stop only the containers named in this run's state file.
      const stop = spawn("python3", [join(here, "stop.py"), stateDirectory], { cwd: root, stdio: "inherit" })
      await once(stop, "exit").catch(() => {})
    }
  })()
  return stopping
}

// Installed before any child starts, so Ctrl-C during start.py also stops
// this run's proxy, static server and containers.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true
    console.error("\nStopping the gallery…")
    stopGallery().finally(() => process.exit(130))
  })
}

async function ensureUI() {
  if (!rebuildUI && await exists(join(uiExport, "index.html"))) {
    log(`Reusing the static UI export at ${uiExport} (pass --rebuild-ui to rebuild).`)
    return
  }
  log("Building the static UI export (plain npm run build)…")
  const build = run("npm", ["run", "build"], { cwd: uiDirectory })
  const [code] = await once(build, "exit")
  if (code !== 0) fail(`npm run build failed with exit code ${code}`)
}

async function startStaticUI(port) {
  const server = run("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", uiExport], { stdio: ["ignore", "ignore", "inherit"] })
  await waitFor(async () => {
    if (server.exitCode !== null) fail("The static UI server exited")
    return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false)
  }, "the static UI server", 20)
}

// start.py prints its state directory first, then runs for several minutes.
// Mirror its output while capturing the one path this command needs.
async function startProviders() {
  const start = spawn("python3", [join(here, "start.py")], { cwd: root, stdio: ["ignore", "pipe", "inherit"] })
  children.push(start)
  let buffered = ""
  start.stdout.on("data", data => {
    process.stdout.write(data)
    buffered += data
    const match = /^Local state: (.+)$/m.exec(buffered)
    if (match && !stateDirectory) stateDirectory = match[1].trim()
  })
  const [code] = await once(start, "exit")
  if (code !== 0) fail(`start.py failed with exit code ${code}`)
  if (!stateDirectory) fail("start.py did not report its state directory")
  return join(stateDirectory, "providers.json")
}

async function startProxy(providersFile, uiURL) {
  const receiptFile = join(stateDirectory, "gallery-receipt.json")
  let diagnostic = ""
  const proxy = spawn(process.execPath, ["--experimental-strip-types", join(here, "serve.mjs"), `--providers=${providersFile}`, `--ui-url=${uiURL}`, `--ready-file=${receiptFile}`, `--session-duration=${sessionDuration}`], { cwd: root, stdio: ["ignore", "ignore", "pipe"] })
  children.push(proxy)
  proxy.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-8000) })
  await waitFor(async () => {
    if (proxy.exitCode !== null) fail(`The gallery proxy exited (${proxy.exitCode}): ${diagnostic}`)
    return exists(receiptFile)
  }, "the gallery proxy", 900)
  return { receipt: JSON.parse(await readFile(receiptFile, "utf8")), proxy }
}

async function writeEnvironment(receipt, uiURL) {
  // Only URLs: the token never enters this file.
  const path = join(stateDirectory, "gallery-env.sh")
  const body = [
    "# Written by demo/insights-gallery/up.mjs for this run. Synthetic data; no credentials.",
    `export INSIGHTS_E2E_URL='${uiURL}'`,
    `export PAPRIKA_GALLERY_BASE_URL='${receipt.url}'`,
    "",
  ].join("\n")
  await writeFile(path, body, { mode: 0o600 })
  return path
}

async function main() {
  await ensureUI()
  const uiPort = await freePort()
  const uiURL = `http://127.0.0.1:${uiPort}/`
  await startStaticUI(uiPort)
  const providersFile = await startProviders()
  const { receipt, proxy } = await startProxy(providersFile, uiURL)
  const environment = await writeEnvironment(receipt, uiURL)
  const dashboard = receipt.dashboards.includes("local-gallery-service-pulse") ? "local-gallery-service-pulse" : receipt.dashboards[0]
  const open = new URL(`dashboard/insights/?dashboard=${encodeURIComponent(dashboard)}`, receipt.url).href
  log([
    "",
    `Gallery ready for ${sessionDuration} (synthetic data, no credentials in the browser or this output).`,
    "",
    `  Open: ${open}`,
    `  Environment: source ${environment}`,
    "",
    `Stop: press Ctrl-C here, or from another shell: python3 demo/insights-gallery/stop.py ${stateDirectory}`,
    "",
  ].join("\n"))
  // Runs until Ctrl-C (handled above) or until the proxy exits on its own.
  const [code] = await once(proxy, "exit")
  if (!interrupted) fail(`The gallery proxy stopped (${code}).`)
}

try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await stopGallery()
}

// Runs Insights browser suites listed in e2e/insights-suites.json.
// Run from ui/:
//   node e2e/run-insights.mjs                      every suite tagged "full" (the default)
//   node e2e/run-insights.mjs --tag smoke          the CI smoke set; --retries 1 retries a failing suite once
//   node e2e/run-insights.mjs --list [--tag perf]  print the resolved selection and exit
//   node e2e/run-insights.mjs e2e/insights-x.e2e.mjs   run named suites (need not be in the manifest)
//   node e2e/run-insights.mjs --relevance <base>   print relevant=true|false for the smoke set (CI path filter)
// Servers: INSIGHTS_E2E_URL, when set, is used for every suite. Otherwise "dev" suites get a next dev server
// and "export" suites get a static server over ui/out (run `npm run build` first).
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createReadStream, existsSync, readFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { relevance } from "./insights-relevance.mjs"

const uiDirectory = fileURLToPath(new URL("../", import.meta.url))
const manifest = JSON.parse(readFileSync(new URL("./insights-suites.json", import.meta.url), "utf8"))
const suiteFile = /^e2e\/insights(?:-[a-z0-9-]+)?\.e2e\.mjs$/
const knownTags = Object.keys(manifest.tags)
// Servers started for this run, by kind ("dev" or "export"), stopped when the run ends.
const servers = {}

function parseArguments(argv) {
  const options = { list: false, tags: [], retries: 0, relevance: undefined, files: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = () => {
      const next = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[++index]
      if (next === undefined) throw new Error(`${argument} needs a value`)
      return next
    }
    if (argument === "--list") options.list = true
    else if (argument === "--tag" || argument.startsWith("--tag=")) options.tags.push(...value().split(",").filter(Boolean))
    else if (argument === "--retries" || argument.startsWith("--retries=")) {
      const retries = Number(value())
      if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new Error("--retries takes 0 to 3")
      options.retries = retries
    } else if (argument === "--relevance" || argument.startsWith("--relevance=")) options.relevance = value()
    else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}`)
    else options.files.push(argument)
  }
  for (const tag of options.tags) {
    if (!knownTags.includes(tag)) throw new Error(`Unknown tag "${tag}". Tags: ${knownTags.join(", ")}`)
  }
  return options
}

// The suites to run, in manifest order. Named files win over tags; no selection means the "full" tag.
function select(options) {
  if (options.files.length) {
    for (const file of options.files) {
      if (!suiteFile.test(file)) throw new Error("Select an Insights E2E script under e2e/")
    }
    return options.files.map((file) => manifest.suites.find((suite) => suite.file === file) ?? { file, tags: [], needs: [], server: "dev", timeoutSeconds: 600 })
  }
  const tags = options.tags.length ? options.tags : ["full"]
  return manifest.suites.filter((suite) => suite.tags.some((tag) => tags.includes(tag)))
}

// Prints relevant=... on stdout (GITHUB_OUTPUT format) and the reason on stderr. See insights-relevance.mjs.
// An unexpected error also prints relevant=true: the path filter may only ever skip on a clean decision.
function printRelevance(base) {
  let decision
  try {
    decision = relevance(base, manifest.smokeSkipPaths)
  } catch (error) {
    decision = { relevant: true, reason: `running: relevance check failed: ${error instanceof Error ? error.message : error}` }
  }
  console.log(`relevant=${decision.relevant}`)
  console.error(decision.reason)
}

async function freePort() {
  const socket = createServer()
  socket.listen(0, "127.0.0.1")
  await once(socket, "listening")
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return port
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 5000)
  force.unref()
  await exited
  clearTimeout(force)
}

async function startDevServer() {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  let output = ""
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: uiDirectory,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const capture = (data) => { output = (output + data).slice(-8000) }
  next.stdout.on("data", capture)
  next.stderr.on("data", capture)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (next.exitCode !== null) throw new Error(`Next exited before becoming ready:\n${output}`)
    try {
      const response = await fetch(`${url}/dashboard/insights/?example=1`, { signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        console.log(`Insights E2E dev server ready at ${url}`)
        return { url, stop: () => stopProcess(next) }
      }
    } catch { /* Compilation and socket startup may still be in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await stopProcess(next)
  throw new Error(`Next was not ready after 90 seconds:\n${output}`)
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain", ".map": "application/json" }

// Serves the static export the way the deployed bundle is served: index.html for directory URLs, then file.html.
function exportDirectory() {
  const directory = join(uiDirectory, "out")
  if (!existsSync(join(directory, "index.html"))) throw new Error(`No static export at ${directory}. Run "npm run build" in ui/ first.`)
  return directory
}

async function startExportServer() {
  const directory = exportDirectory()
  const port = await freePort()
  const server = createHttpServer(async (request, response) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
    } catch {
      response.writeHead(400, { "content-type": "text/plain" })
      response.end("bad request")
      return
    }
    const candidates = pathname.endsWith("/")
      ? [join(directory, pathname, "index.html")]
      : [join(directory, pathname), join(directory, `${pathname}.html`), join(directory, pathname, "index.html")]
    for (const candidate of candidates) {
      const file = normalize(candidate)
      if (!file.startsWith(directory + sep)) continue
      try {
        if (!(await stat(file)).isFile()) continue
      } catch { continue }
      response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" })
      createReadStream(file).pipe(response)
      return
    }
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("not found")
  })
  server.listen(port, "127.0.0.1")
  await once(server, "listening")
  const url = `http://127.0.0.1:${port}`
  console.log(`Insights E2E static export ready at ${url} (ui/out)`)
  return { url, stop: () => new Promise((resolve) => server.close(resolve)) }
}

// Runs one suite once. Returns "passed", or "failed" / "timed out" with the exit detail.
async function runOnce(suite, baseURL, timeoutSeconds) {
  const child = spawn(process.execPath, [suite.file], {
    cwd: uiDirectory,
    env: { ...process.env, INSIGHTS_E2E_URL: baseURL },
    stdio: "inherit",
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void stopProcess(child) }, timeoutSeconds * 1000)
  const [code] = await once(child, "exit")
  clearTimeout(timer)
  if (timedOut) return { outcome: "timed out", detail: `after ${timeoutSeconds} s` }
  if (code !== 0) return { outcome: "failed", detail: `exit code ${code}` }
  return { outcome: "passed", detail: "" }
}

function format(seconds) { return `${seconds.toFixed(1)} s` }

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.relevance !== undefined) {
    printRelevance(options.relevance)
    return 0
  }

  const suites = select(options)
  if (options.list) {
    for (const suite of suites) {
      console.log([suite.file, `tags=${suite.tags.join(",") || "-"}`, `needs=${suite.needs.join(",") || "-"}`, `server=${suite.server ?? "dev"}`, `timeout=${suite.timeoutSeconds ?? 600}s`].join("  "))
    }
    console.log(`${suites.length} suites`)
    return 0
  }
  if (!suites.length) throw new Error("No suites selected")
  // Fail before the first suite, not after an hour of them, when an export suite has no ui/out to run against.
  if (!process.env.INSIGHTS_E2E_URL && suites.some((suite) => suite.server === "export")) {
    exportDirectory()
  }

  const serverFor = async (kind) => {
    if (process.env.INSIGHTS_E2E_URL) return process.env.INSIGHTS_E2E_URL
    if (!servers[kind]) servers[kind] = kind === "export" ? await startExportServer() : await startDevServer()
    return servers[kind].url
  }

  const results = []
  try {
    for (const suite of suites) {
      const kind = suite.server === "export" ? "export" : "dev"
      const baseURL = await serverFor(kind)
      const timeoutSeconds = suite.timeoutSeconds ?? 600
      let attempts = 0
      let last
      const started = performance.now()
      while (attempts <= options.retries) {
        attempts++
        console.log(`\n== ${suite.file} (attempt ${attempts}, server ${kind}, timeout ${timeoutSeconds} s)`)
        last = await runOnce(suite, baseURL, timeoutSeconds)
        if (last.outcome === "passed") break
        console.error(`${suite.file} ${last.outcome} ${last.detail}`)
      }
      const outcome = last.outcome === "passed" ? (attempts > 1 ? "flaky" : "passed") : last.outcome
      results.push({ file: suite.file, outcome, attempts, seconds: (performance.now() - started) / 1000 })
      if (outcome === "flaky" && process.env.GITHUB_ACTIONS) {
        console.log(`::warning title=Flaky Insights suite::${suite.file} passed only on retry`)
      }
    }
  } finally {
    for (const server of Object.values(servers)) await server.stop()
  }

  console.log("\nInsights suite summary")
  for (const result of results) {
    console.log(`  ${result.outcome.padEnd(9)} ${format(result.seconds).padStart(10)}  ${result.file}${result.attempts > 1 ? ` (${result.attempts} attempts)` : ""}`)
  }
  const count = (outcome) => results.filter((result) => result.outcome === outcome).length
  const failed = results.filter((result) => result.outcome === "failed" || result.outcome === "timed out")
  console.log(`${count("passed")} passed, ${count("flaky")} flaky (passed only on retry), ${failed.length} failed or timed out, of ${results.length}`)
  return failed.length ? 1 : 0
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void Promise.all(Object.values(servers).map((server) => server.stop())).finally(() => process.exit(signal === "SIGINT" ? 130 : 143))
  })
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

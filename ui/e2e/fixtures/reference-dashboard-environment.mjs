// Real authenticated proxy, Observe provider discovery and durable Insights
// documents. Only chart query responses are deterministic browser fixtures.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { until } from "../insights-portable-fixture.mjs"
import { stopProcessGroup } from "./lab-process.mjs"

const guardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"]

/**
 * Starts an empty workspace. Call installQueryFixture on each fresh browser
 * page before navigating to baseURL. Restart preserves documents but changes
 * the loopback origin and authentication token, so install on a new page again.
 *
 * Options (used by the design lab in insights-lab.mjs):
 * - binary: a prebuilt harness. Built into the workspace when absent.
 * - workspace: a directory the caller owns. It is then not removed by close().
 * - queryFixtureURL: loopback server that supplies Prometheus range data.
 * - labEntry: mint a one-time browser entry ticket (labEntryURL).
 * - tokenTTL: harness credential lifetime, for example "12h".
 * - onSpawn(child): a supervisor manages the harness. The harness then starts in its
 *   own process group, the supervisor stops it, and the caller must record it.
 *   Without onSpawn the harness shares this process's group, so a group signal
 *   (Ctrl-C) reaches it, and this module stops it on SIGINT, SIGTERM, SIGHUP or exit.
 * - onUnexpectedExit({ code, signal, diagnostics }): the harness stopped on its own.
 */
export async function createReferenceDashboardEnvironment(repository, staticURL, options = {}) {
  const ownsWorkspace = options.workspace === undefined
  const temporary = options.workspace ?? await mkdtemp(join(tmpdir(), "paprika-reference-dashboards-"))
  const binary = options.binary ?? join(temporary, "observe-e2e")
  const readyFile = join(temporary, "ready.json")
  const dataDir = join(temporary, "data")
  const queryCalls = [], failures = []
  const guards = new Map()
  let harness, connection, providers = [], providerIds, closed = false
  let diagnostics = ""
  const managed = options.onSpawn !== undefined

  async function build() {
    const child = spawn("go", ["build", "-o", binary, "./hack/insights-observe-e2e"], {
      cwd: repository, stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const capture = data => { output = (output + data).slice(-64 * 1024) }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    const [code] = await once(child, "exit")
    assert.equal(code, 0, `Reference dashboard harness failed to build:\n${output}`)
  }

  async function api(path, method = "GET", document, headers = {}, expected = 200) {
    assert.ok(connection, "The reference dashboard environment must be running")
    assert.ok(!path.startsWith("/") && !path.includes(".."), "Use an Insights-relative API path")
    const response = await fetch(`${connection.baseURL}/api/insights/${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}`, ...headers },
      ...(document === undefined ? {} : { body: JSON.stringify(document) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status} ${text}`)
    return {
      status: response.status,
      document: text ? JSON.parse(text) : undefined,
      etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag"),
    }
  }

  async function start() {
    await rm(readyFile, { force: true })
    let startError
    diagnostics = ""
    const child = spawn(binary, [
      `--ready-file=${readyFile}`, `--data-dir=${dataDir}`,
      `--ui-dir=${join(repository, "ui/out")}`, "--application-fixtures",
      ...(staticURL ? [`--ui-url=${staticURL}`] : []),
      ...(options.queryFixtureURL ? [`--query-fixture-url=${options.queryFixtureURL}`] : []),
      ...(options.labEntry ? ["--lab-entry"] : []),
      ...(options.tokenTTL ? [`--token-ttl=${options.tokenTTL}`] : []),
    ], { cwd: repository, stdio: ["ignore", "ignore", "pipe"], detached: managed })
    harness = child
    if (!managed) installGuard()
    // Keep the tail of stderr for diagnosis only. It can contain credential-derived
    // errors, so it is never echoed here; callers decide what to show.
    child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-8192) })
    child.on("error", error => { startError = error })
    options.onSpawn?.(child)
    child.once("exit", (code, signal) => {
      // A stop clears `harness` first, so only an unexpected exit reaches here.
      if (harness !== child || closed) return
      harness = undefined
      options.onUnexpectedExit?.({ code, signal, diagnostics })
    })
    await until(async () => {
      if (startError) throw startError
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Reference dashboard harness exited (${child.exitCode ?? child.signalCode})`)
      try { connection = JSON.parse(await readFile(readyFile, "utf8")); return true }
      catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return false; throw error }
    }, "Reference dashboard harness did not become ready", 30_000)
    providers = (await api("providers")).document.providers
    const idFor = (reference, kind) => {
      const provider = providers.find(value => value.providerRef === reference && value.capabilities.includes(kind))
      assert.ok(provider, `The real Observe catalog must expose ${reference} for ${kind}`)
      return provider.id
    }
    providerIds = {
      metrics: idFor("observability/prometheus", "metrics"),
      traces: idFor("observability/tempo", "traces"),
      records: idFor("observability/shorted", "records"),
    }
  }

  async function stop() {
    const running = harness
    harness = undefined
    connection = undefined
    if (!running || running.exitCode !== null || running.signalCode !== null) return
    if (managed) {
      // Detached: the harness and anything it started share the group it leads.
      await stopProcessGroup(running.pid)
      return
    }
    running.kill("SIGTERM")
    const exited = once(running, "exit")
    const force = setTimeout(() => running.kill("SIGKILL"), 5000)
    try { await exited } finally { clearTimeout(force) }
  }

  // Synchronous, because a signal or an exit can arrive when no promise can run.
  // It kills the harness, removes an owned workspace and re-raises the signal.
  function killHarnessNow() {
    if (harness?.pid) { try { process.kill(harness.pid, "SIGKILL") } catch { /* Already gone. */ } }
  }
  function removeGuard() {
    for (const [signal, listener] of guards) process.removeListener(signal, listener)
    guards.clear()
    process.removeListener("exit", exitListener)
  }
  function exitListener() { killHarnessNow() }
  function installGuard() {
    if (guards.size > 0) return
    for (const signal of guardedSignals) {
      const listener = () => {
        killHarnessNow()
        removeGuard()
        if (ownsWorkspace) rmSync(temporary, { recursive: true, force: true })
        process.kill(process.pid, signal)
      }
      guards.set(signal, listener)
      process.on(signal, listener)
    }
    process.on("exit", exitListener)
  }

  async function close() {
    if (closed) return
    closed = true
    try { await stop() } finally {
      removeGuard()
      if (ownsWorkspace) await rm(temporary, { recursive: true, force: true })
    }
  }

  try {
    if (!(await stat(binary).then(() => true, () => false))) await build()
    await start()
  }
  catch (error) { await close(); throw error }

  return {
    get baseURL() { return connection?.baseURL },
    get providers() { return structuredClone(providers) },
    get providerIds() { return { ...providerIds } },
    get temporaryDirectory() { return temporary },
    queryCalls, failures, api,
    /** The one-time entry link for a browser, or an error unless labEntry was requested. */
    labEntryURL(destination = "/dashboard/insights/") {
      assert.ok(connection?.labEnterTicket, "Start the environment with labEntry to mint an entry link")
      const query = new URLSearchParams({ ticket: connection.labEnterTicket, next: destination })
      return `${connection.baseURL}/__lab/enter?${query}`
    },
    /** Last stderr bytes of the harness, for a human reading a failure. */
    harnessDiagnostics() { return diagnostics },
    async installQueryFixture(page, resolver) {
      assert.ok(connection && !closed, "Install fixtures after starting the environment")
      assert.equal(typeof resolver, "function", "Supply an explicit test query resolver")
      const origin = connection.baseURL
      await page.addInitScript(({ origin, token }) => {
        if (location.origin === origin) localStorage.setItem("paprika_id_token", token)
      }, { origin, token: connection.token })
      await page.route(`${origin}/api/insights/query`, async route => {
        const request = route.request()
        const call = { method: request.method(), path: "/api/insights/query", status: 200 }
        queryCalls.push(call)
        try {
          assert.equal(request.method(), "POST", "Chart fixtures accept only query POST requests")
          call.request = request.postDataJSON()
          assert.ok(providers.some(provider => provider.id === call.request.providerId && provider.capabilities.includes(call.request.kind)), "Query must use a real compatible Observe provider")
          assert.ok(!call.request.query.includes("{{"), "Saved-query bindings must resolve before querying")
          const result = await resolver(structuredClone(call.request))
          assert.ok(result && typeof result === "object", "The test query resolver must return a normalized QueryResult")
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) })
        } catch (error) {
          call.status = 500
          failures.push(error.stack ?? error.message)
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: error.message }) })
        }
      })
    },
    async restart() {
      assert.ok(!closed, "Cannot restart a closed environment")
      await stop()
      await start()
    },
    close,
  }
}

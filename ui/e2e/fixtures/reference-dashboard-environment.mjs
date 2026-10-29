// Real authenticated proxy, Observe provider discovery and durable Insights
// documents. Only chart query responses are deterministic browser fixtures.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { until } from "../insights-portable-fixture.mjs"

/**
 * Starts an empty workspace. Call installQueryFixture on each fresh browser
 * page before navigating to baseURL. Restart preserves documents but changes
 * the loopback origin and authentication token, so install on a new page again.
 */
export async function createReferenceDashboardEnvironment(repository, staticURL) {
  const temporary = await mkdtemp(join(tmpdir(), "paprika-reference-dashboards-"))
  const binary = join(temporary, "observe-e2e")
  const readyFile = join(temporary, "ready.json")
  const dataDir = join(temporary, "data")
  const queryCalls = [], failures = []
  let process, connection, providers = [], providerIds, closed = false

  async function build() {
    const child = spawn("go", ["build", "-o", binary, "./hack/insights-observe-e2e"], {
      cwd: repository, stdio: ["ignore", "pipe", "pipe"],
    })
    let diagnostics = ""
    const capture = data => { diagnostics = (diagnostics + data).slice(-64 * 1024) }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    const [code] = await once(child, "exit")
    assert.equal(code, 0, `Reference dashboard harness failed to build:\n${diagnostics}`)
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
    process = spawn(binary, [
      `--ready-file=${readyFile}`, `--data-dir=${dataDir}`,
      `--ui-dir=${join(repository, "ui/out")}`, "--application-fixtures",
      ...(staticURL ? [`--ui-url=${staticURL}`] : []),
    ], { cwd: repository, stdio: ["ignore", "ignore", "pipe"] })
    // Do not expose process logs: this harness owns temporary signed tokens.
    process.stderr.resume()
    process.on("error", error => { startError = error })
    await until(async () => {
      if (startError) throw startError
      if (process.exitCode !== null || process.signalCode !== null)
        throw new Error(`Reference dashboard harness exited (${process.exitCode ?? process.signalCode})`)
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
    const running = process
    process = undefined
    connection = undefined
    if (!running || running.exitCode !== null || running.signalCode !== null) return
    const exited = once(running, "exit")
    running.kill("SIGTERM")
    const force = setTimeout(() => running.kill("SIGKILL"), 5000)
    try { await exited } finally { clearTimeout(force) }
  }

  async function close() {
    if (closed) return
    closed = true
    try { await stop() } finally { await rm(temporary, { recursive: true, force: true }) }
  }

  try { await build(); await start() }
  catch (error) { await close(); throw error }

  return {
    get baseURL() { return connection?.baseURL },
    get providers() { return structuredClone(providers) },
    get providerIds() { return { ...providerIds } },
    queryCalls, failures, api,
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

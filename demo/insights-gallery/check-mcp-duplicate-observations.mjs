// Full local Insights/Observe/MCP path with an intentionally malformed
// Prometheus-compatible fixture. No cluster, real provider or user data is used.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "paprika-duplicate-observations-"))
const ready = join(temporary, "ready.json"), binary = join(temporary, "observe-fixture")
let fixture, child
const run = async (command, args) => {
  const process = spawn(command, args, { cwd: root, stdio: "inherit" })
  const [code] = await once(process, "exit")
  assert.equal(code, 0, `${command} failed`)
}
try {
  await run("rtk", ["proxy", "go", "build", "-o", binary, "./hack/insights-observe-e2e"])
  child = spawn(binary, [`--ready-file=${ready}`, `--data-dir=${join(temporary, "data")}`], { cwd: root, stdio: ["ignore", "ignore", "pipe"] })
  let errorLog = ""; child.stderr.on("data", value => { errorLog += value })
  const deadline = Date.now() + 30000
  while (!fixture && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture stopped: ${errorLog}`)
    try { fixture = JSON.parse(await readFile(ready, "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error }
    if (!fixture) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(fixture, "Fixture did not become ready")
  const api = async (path, options = {}) => fetch(new URL(`/api/insights/${path}`, fixture.baseURL), { ...options, headers: { Authorization: `Bearer ${fixture.token}`, ...options.headers } })
  const providersResponse = await api("providers")
  assert.equal(providersResponse.status, 200)
  const provider = (await providersResponse.json()).providers.find(value => value.providerRef === fixture.providerRef)
  assert.ok(provider)
  const id = "duplicate-observation-check"
  const dashboard = { schemaVersion: 1, id, title: "Duplicate observation check", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [{ id: "duplicate", title: "Duplicate observations", type: "timeseries", providerId: provider.id, query: "duplicate_timestamp_fixture_metric", unit: "", layout: { x: 0, y: 0, w: 8, h: 4 } }] }
  const created = await api(`dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(dashboard) })
  assert.equal(created.status, 200, await created.clone().text())
  const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
  assert.ok(etag)
  const response = await fetch(fixture.mcpURL, { method: "POST", headers: { Authorization: `Bearer ${fixture.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: { id, start: "2026-10-20T12:00:00Z", end: "2026-10-20T13:00:00Z", history_points: 2 } } }) })
  assert.equal(response.status, 200)
  const raw = await response.text(), body = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(raw.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(raw)
  assert.equal(body.error, undefined); assert.notEqual(body.result.isError, true)
  const bundle = body.result.structuredContent
  assert.equal(bundle.dashboard.etag, etag)
  const signal = bundle.signals.find(value => value.id === bundle.widgets[0].signalId)
  assert.equal(signal.state, "ok")
  assert.equal(signal.series[0].duplicateObservations, 2)
  assert.equal(signal.series[0].valid, 3)
  assert.equal(signal.series[0].missing, 1)
  assert.equal(signal.series[0].mean, 3)
  assert.match(body.result.content.find(value => value.type === "text").text, /duplicate timestamp observations=2 in summarized series/)
  const current = await api(`dashboards/${id}`)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  console.log("PASS malformed synthetic Prometheus-compatible provider to Insights and Observe MCP: duplicate counts, raw mean, missing sample, text, bounded history and unchanged ETag")
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended }
  await rm(temporary, { recursive: true, force: true })
}

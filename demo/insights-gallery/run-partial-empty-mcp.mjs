// Isolated end-to-end fixture for a source-limited response with no data.
// The supplied gallery providers are copied to a private temporary file; no
// credentials are printed and the uniquely created dashboard is deleted by
// the MCP and UI checks using their exact ETags.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--(providers|ui-url)=(.+)$/.exec(argument)
  if (!match) throw Error("Use --providers=PATH --ui-url=http://127.0.0.1:PORT/")
  return [match[1], match[2]]
}))
if (!args.providers || !args["ui-url"]) throw Error("A provider file and loopback UI URL are required")
const ui = new URL(args["ui-url"])
assert.ok(ui.protocol === "http:" && ui.hostname === "127.0.0.1" && !ui.username && !ui.password)
const providers = JSON.parse(await readFile(args.providers, "utf8"))
assert.ok(Array.isArray(providers) && providers.length <= 3 && !providers.some(provider => provider.name === "warning-prometheus"))
const temporary = await mkdtemp(join(tmpdir(), "paprika-partial-empty-"))
await chmod(temporary, 0o700)
const mock = createServer((request, response) => {
  const query = new URL(request.url, "http://127.0.0.1").searchParams.get("query") ?? ""
  const data = { resultType: "matrix", result: [] }
  const result = { status: "success", data }
  if (query.includes("partial_fixture")) result.warnings = ["synthetic partial source"]
  if (query.includes("zero_fixture")) data.result = [{ metric: {}, values: [[1792972800, "0"]] }]
  response.writeHead(200, { "Content-Type": "application/json" })
  response.end(JSON.stringify(result))
})
let harness
try {
  mock.listen(0, "127.0.0.1")
  await once(mock, "listening")
  providers.push({ name: "warning-prometheus", type: "prometheus", config: { endpoint: `http://127.0.0.1:${mock.address().port}` }, credentials: "" })
  const providerPath = join(temporary, "providers.json"), readyPath = join(temporary, "ready.json")
  await writeFile(providerPath, JSON.stringify(providers), { mode: 0o600 })
  // A separate process group also owns the `go run` child and its compiled
  // server, allowing teardown without leaving a local service behind.
  harness = spawn(process.execPath, ["--experimental-strip-types", "demo/insights-gallery/serve.mjs", `--providers=${providerPath}`, `--ui-url=${ui.href}`, `--ready-file=${readyPath}`], { stdio: "ignore", detached: true })
  let ready = false
  for (let attempt = 0; attempt < 600; attempt++) {
    if (harness.exitCode !== null) throw Error("The isolated MCP test harness exited before becoming ready")
    try { JSON.parse(await readFile(readyPath, "utf8")); ready = true; break } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (!ready) throw Error("The isolated MCP test harness did not become ready")
  const check = spawn(process.execPath, ["demo/insights-gallery/check-partial-empty-mcp.mjs", readyPath], { stdio: "inherit" })
  const [code] = await once(check, "exit")
  assert.equal(code, 0, "The partial-source MCP check failed")
  const uiCheck = spawn(process.execPath, ["ui/e2e/insights-partial-empty-live.e2e.mjs", readyPath], { stdio: "inherit" })
  const [uiCode] = await once(uiCheck, "exit")
  assert.equal(uiCode, 0, "The partial-source UI check failed")
} finally {
  if (harness && harness.exitCode === null && harness.signalCode === null) {
    const exited = once(harness, "exit")
    try { process.kill(-harness.pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
    let timer
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
    clearTimeout(timer)
    if (harness.exitCode === null && harness.signalCode === null) {
      try { process.kill(-harness.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
      await exited
    }
  }
  // The gateway's HTTP transport may retain an idle keep-alive after the
  // harness exits; close our fixture's connections before waiting for close.
  await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections() })
  await rm(temporary, { recursive: true, force: true })
}

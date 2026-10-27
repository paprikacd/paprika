// Actual Insights processes and durable stores. Faults affect only this test
// gateway, allowing lost acknowledgements and partial imports to be exercised.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function until(predicate, message, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function listen(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server.address().port
}

function json(response, status, document) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(document))
}

export async function portableEnvironment(repository, staticURL) {
  const temporary = await mkdtemp(join(tmpdir(), "paprika-portable-"))
  const binary = join(temporary, "insights")
  const fixtures = []
  const providerRequests = []
  const build = spawn("go", ["build", "-o", binary, "./cmd/paprika-insights"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  build.stdout.on("data", data => { logs += data })
  build.stderr.on("data", data => { logs += data })
  const [status] = await once(build, "exit")
  assert.equal(status, 0, logs)
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost")
    const entry = { path: url.pathname, params: Object.fromEntries(url.searchParams) }
    providerRequests.push(entry)
    if (url.pathname.endsWith("/api/v1/query_range")) {
      const end = Number(url.searchParams.get("end")), query = url.searchParams.get("query") ?? ""
      const value = query.startsWith("portable_detail") ? 87.5 : query.includes(" + 1") ? 43 : 42
      json(response, 200, { status: "success", data: { resultType: "matrix", result: [{ metric: { __name__: "portable_metric", service: 'api"blue\\west\n{{literal}}', region: "melbourne" }, values: [[end - 60, String(value - 1)], [end - .25, String(value)]] }] } })
    } else if (url.pathname.endsWith("/api/search")) {
      const end = Number(url.searchParams.get("end"))
      json(response, 200, { traces: [{ traceID: "fedcba9876543210fedcba9876543210", rootServiceName: "portable-trace", rootTraceName: "GET /portable-import", startTimeUnixNano: String(BigInt(end) * 1_000_000_000n), durationMs: 31.25 }] })
    } else if (url.pathname.endsWith("/api/v1/label/__name__/values")) json(response, 200, { status: "success", data: ["portable_main", "portable_detail"] })
    else json(response, 404, { error: "Unexpected portability fixture endpoint" })
  })
  const upstreamURL = `http://127.0.0.1:${await listen(upstream)}`

  async function fixture(name, ids = { metrics: "destination-metrics", traces: "destination-traces" }) {
    const root = join(temporary, name)
    await mkdir(root, { recursive: true })
    const providers = [
      { id: ids.metrics, name: `${name} metrics`, type: "prometheus", url: `${upstreamURL}/${name}/metrics` },
      { id: ids.traces, name: `${name} traces`, type: "tempo", url: `${upstreamURL}/${name}/traces` },
    ]
    await writeFile(join(root, "providers.json"), JSON.stringify({ providers }))
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise(resolve => reservation.close(resolve))
    const serviceURL = `http://127.0.0.1:${port}`
    let service, serviceLogs = "", closed = false
    const requests = [], faults = []
    async function start() {
      service = spawn(binary, ["--dev", `--listen=127.0.0.1:${port}`, `--data-dir=${join(root, "data")}`, `--providers=${join(root, "providers.json")}`], { cwd: repository, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, stdio: ["ignore", "pipe", "pipe"] })
      service.stdout.on("data", data => { serviceLogs += data })
      service.stderr.on("data", data => { serviceLogs += data })
      await until(async () => { try { return (await fetch(`${serviceURL}/readyz`)).ok } catch { return false } }, `Insights ${name} did not start: ${serviceLogs}`)
    }
    async function stop() {
      if (!service || service.exitCode !== null || service.signalCode !== null) return
      const ended = once(service, "exit")
      service.kill("SIGTERM")
      const force = setTimeout(() => service.kill("SIGKILL"), 5000)
      await ended
      clearTimeout(force)
    }
    const gateway = createServer(async (request, response) => {
      const incoming = new URL(request.url, "http://localhost")
      const api = incoming.pathname.startsWith("/api/insights/")
      const target = new URL(api ? `${incoming.pathname.replace(/^\/api\/insights/, "/api")}${incoming.search}` : request.url, api ? serviceURL : staticURL)
      const body = []
      for await (const chunk of request) body.push(chunk)
      const buffer = Buffer.concat(body)
      const entry = { method: request.method, path: target.pathname, headers: { "if-match": request.headers["if-match"], "if-none-match": request.headers["if-none-match"] }, document: buffer.length && api ? JSON.parse(buffer.toString()) : undefined }
      if (api) requests.push(entry)
      const fault = api && faults.find(item => item.remaining > 0 && (!item.method || item.method === request.method) && item.path.test(target.pathname) && (!item.match || item.match(entry)))
      if (fault) { fault.remaining--; entry.fault = fault.mode }
      if (fault?.wait) await fault.wait(entry)
      if (fault?.mode === "before") { entry.status = fault.status ?? 503; json(response, entry.status, { error: "Simulated import interruption before persistence" }); return }
      const forward = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, result => {
        entry.status = result.statusCode
        if (fault?.mode === "after") {
          result.resume()
          result.once("end", () => { entry.acknowledgementLost = true; json(response, 502, { error: "Simulated lost write acknowledgement" }) })
        } else { response.writeHead(result.statusCode, result.headers); result.pipe(response) }
      })
      forward.on("error", () => { if (!response.destroyed && !response.headersSent) json(response, 502, { error: "Test gateway upstream unavailable" }); else response.destroy() })
      response.once("close", () => { if (!response.writableEnded) forward.destroy() })
      forward.end(buffer)
    })
    await start()
    const gatewayURL = `http://127.0.0.1:${await listen(gateway)}`
    const result = {
      name, ids, providers, serviceURL, gatewayURL, requests, faults,
      async api(path, method = "GET", document, headers = {}, expected = 200) {
        const response = await fetch(`${serviceURL}/api/${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(document === undefined ? {} : { body: JSON.stringify(document) }) })
        const text = await response.text()
        assert.equal(response.status, expected, `${method} ${name}/${path}: ${text}`)
        return { document: text ? JSON.parse(text) : undefined, etag: response.headers.get("etag") }
      },
      async restart() { await stop(); await start() },
      async close() { if (closed) return; closed = true; await stop(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) },
    }
    fixtures.push(result)
    return result
  }

  return {
    fixture, providerRequests,
    requestEvidence() { return fixtures.map(item => ({ name: item.name, requests: item.requests })) },
    async close() {
      await Promise.allSettled(fixtures.map(item => item.close()))
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
      await rm(temporary, { recursive: true, force: true })
    },
  }
}

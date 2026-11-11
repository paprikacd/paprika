// Loopback HTTP server for the design playground. The Insights harness asks it for
// Prometheus range data, and the real gateway and Insights normaliser turn that
// into the chart result. The values and gaps are those of the Playwright review's
// resolver; series names and labels come from the label set, as they do for a real
// provider (see docs/guides/local-dashboard-polish.md). Tests may inject a resolver.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { polishQuery } from "./dashboard-polish.mjs"

// The Insights service resolves saved-query bindings before it calls the provider.
// An unresolved binding is a bug, so the fixture rejects it as the Playwright route did.
export const referenceQueryResolver = request => {
  assert.ok(!request.query.includes("{{"), "Saved-query bindings must resolve before querying")
  return polishQuery(request)
}

const maxBodyBytes = 32 * 1024

function send(response, status, document) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  response.end(JSON.stringify(document))
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) throw Object.assign(new Error("Query request is too large"), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Starts a server on 127.0.0.1. POST /query accepts the Insights query JSON
 * and answers with the resolver's QueryResult. A resolver error becomes a 500
 * with its message, so an unknown fixture query fails visibly.
 */
export async function startQueryFixtureServer(resolver = referenceQueryResolver, { port = 0 } = {}) {
  if (typeof resolver !== "function") throw new TypeError("A query resolver function is required")
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") return send(response, 200, { status: "ok" })
      if (request.method !== "POST" || request.url !== "/query") return send(response, 404, { error: "Not found" })
      const text = await readBody(request)
      let query
      try { query = JSON.parse(text) } catch { return send(response, 400, { error: "Query must be JSON" }) }
      if (!query || typeof query !== "object" || typeof query.providerId !== "string" || typeof query.query !== "string") {
        return send(response, 400, { error: "Query must include providerId and query" })
      }
      let result
      try {
        result = await resolver(structuredClone(query))
      } catch (error) {
        return send(response, 500, { error: error.message })
      }
      if (!result || typeof result !== "object") return send(response, 500, { error: "The fixture resolver returned no result" })
      return send(response, 200, result)
    } catch (error) {
      return send(response, error.status ?? 500, { error: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  const { port: bound } = server.address()
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

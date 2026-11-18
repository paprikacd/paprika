import assert from "node:assert/strict"

// Insights reads provider data over the gateway's REST routes with the caller's
// delegated bearer. MCP remains the agent-facing protocol and the Data sources
// status, so these helpers check each boundary by its own receipts.
const restDataPaths = new Set(["/observe/api/providers", "/observe/api/query", "/observe/api/explore"])

export async function readObserveProtocol(baseURL) {
  const response = await fetch(`${baseURL}/__test/requests`)
  assert.equal(response.status, 200, "The real fixture must expose its protocol receipts")
  return response.json()
}

function assertNoCredentials(receipts) {
  const serialized = JSON.stringify(receipts.gateway)
  assert.ok(!serialized.includes("fixture-provider-secret") && !serialized.includes("Bearer "), "Protocol receipts must not retain credentials")
}

// assertObserveREST checks that each required REST route was called, and returns
// every REST data receipt. Each receipt carries the request body it sent.
export function assertObserveREST(receipts, requiredPaths = []) {
  assert.ok(Array.isArray(receipts.gateway) && receipts.gateway.length, "Observe gateway requests must be recorded")
  const rest = receipts.gateway.filter(item => restDataPaths.has(item.path))
  for (const path of requiredPaths) assert.ok(rest.some(item => item.path === path), `Expected a REST ${path} call`)
  assertNoCredentials(receipts)
  return rest
}

// assertObserveMCP checks the required MCP tools/call names and returns the MCP
// calls. It no longer forbids REST: the two protocols are checked separately.
export function assertObserveMCP(receipts, requiredTools = []) {
  assert.ok(Array.isArray(receipts.gateway) && receipts.gateway.length, "Observe gateway requests must be recorded")
  const calls = receipts.gateway.filter(item => item.path === "/observe/mcp" && item.method === "tools/call")
  for (const name of requiredTools) assert.ok(calls.some(item => item.tool === name), `Expected an actual Observe MCP tools/call for ${name}`)
  assertNoCredentials(receipts)
  return calls
}

// assertMetricCall finds the REST query for one provider, query, range and step.
// Pass the receipts returned by assertObserveREST.
export function assertMetricCall(restCalls, { provider, query, from, to, step }) {
  const match = restCalls.find(item => item.path === "/observe/api/query" && item.body?.provider === provider && item.body.signal === "metrics" && item.body.query === query && Date.parse(item.body.start) === Date.parse(from) && Date.parse(item.body.end) === Date.parse(to) && item.body.stepSeconds === step)
  assert.ok(match, "The exact provider, query, time range and step must cross the REST query boundary")
  return match.body
}

// assertNoLegacyDataTools checks that no MCP query_* tool was called. Use it only
// where the suite makes no agent-facing query_* call of its own.
export function assertNoLegacyDataTools(receipts) {
  const calls = receipts.gateway.filter(item => item.path === "/observe/mcp" && item.method === "tools/call")
  for (const name of ["query_metrics", "query_traces", "query_logs", "query_records"]) {
    assert.ok(!calls.some(item => item.tool === name), `Insights must not read provider data through MCP ${name}`)
  }
}

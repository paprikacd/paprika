import assert from "node:assert/strict"

export async function readObserveProtocol(baseURL) {
  const response = await fetch(`${baseURL}/__test/requests`)
  assert.equal(response.status, 200, "The real fixture must expose its protocol receipts")
  return response.json()
}

export function assertObserveMCP(receipts, requiredTools = []) {
  assert.ok(Array.isArray(receipts.gateway) && receipts.gateway.length, "Observe gateway requests must be recorded")
  const rest = receipts.gateway.filter(item => /^\/observe\/api\/(providers|query|explore)$/.test(item.path))
  assert.deepEqual(rest, [], "Shared dashboard data must never fall back to the Observe REST data endpoints")
  const calls = receipts.gateway.filter(item => item.path === "/observe/mcp" && item.method === "tools/call")
  for (const name of requiredTools) assert.ok(calls.some(item => item.tool === name), `Expected an actual Observe MCP tools/call for ${name}`)
  const serialized = JSON.stringify(receipts.gateway)
  assert.ok(!serialized.includes("fixture-provider-secret") && !serialized.includes("Bearer "), "Protocol receipts must not retain credentials")
  return calls
}

export function assertMetricCall(calls, { provider, query, from, to, step }) {
  const match = calls.find(item => item.tool === "query_metrics" && item.arguments?.provider === provider && item.arguments.query === query && Date.parse(item.arguments.start) === Date.parse(from) && Date.parse(item.arguments.end) === Date.parse(to) && item.arguments.step_seconds === step)
  assert.ok(match, "The exact provider, query, time range and step must cross the MCP tools/call boundary")
  return match.arguments
}

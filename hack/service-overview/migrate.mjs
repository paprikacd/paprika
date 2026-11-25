// Narrow Service overview saved-query migration; caller supplies authenticated MCP.
// The plan and the verified writes come from hack/insights-patch, so this file only declares the set and its preflight.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { apply, plan } from "../insights-patch/apply.mjs"

export const patches = JSON.parse(await readFile(new URL("./queries.json", import.meta.url), "utf8"))

export async function migrate(call, { expectedProviderId, apply: write = false } = {}) {
  assert.ok(typeof expectedProviderId === "string" && expectedProviderId, "Declare the expected metrics provider")
  const set = {
    version: 1,
    description: "Service overview saved-query migration",
    savedQueries: Object.entries(patches).map(([id, patch]) => ({ id, patch })),
  }
  const preflight = (entry, current) => {
    const document = current.document
    assert.equal(document.kind, "metrics")
    assert.equal(document.providerId, expectedProviderId, `${entry.id} has an unexpected provider`)
    assert.ok(document.parameters?.some(item => item.name === "service" && item.type === "string"), `${entry.id} needs its existing string service parameter`)
  }
  // Read and validate the full set before the first write. Never retry conflicts.
  const planned = await plan(call, set, { preflight })
  if (!write) return planned
  const receipt = await apply(call, planned)
  if (receipt.error) throw new Error(receipt.error)
  return receipt.items
}

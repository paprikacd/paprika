// Narrow Service overview saved-query migration; caller supplies authenticated MCP.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"

export const patches = JSON.parse(await readFile(new URL("./queries.json", import.meta.url), "utf8"))
export async function migrate(call, { expectedProviderId, apply = false } = {}) {
  assert.ok(typeof expectedProviderId === "string" && expectedProviderId, "Declare the expected metrics provider")
  const plan = []
  // Read and validate the full set before the first write. Never retry conflicts.
  for (const [id, patch] of Object.entries(patches)) {
    const before = await call("get_saved_query", { id })
    assert.ok(before.etag, `${id} needs its exact current ETag`)
    assert.equal(before.document?.id, id)
    assert.equal(before.document.kind, "metrics")
    assert.equal(before.document.providerId, expectedProviderId, `${id} has an unexpected provider`)
    assert.ok(before.document.parameters?.some(item => item.name === "service" && item.type === "string"), `${id} needs its existing string service parameter`)
    const desired = { ...before.document, ...patch, metadata: { ...before.document.metadata, ...patch.metadata } }
    plan.push({ id, before, desired, patch, state: isDeepStrictEqual(before.document, desired) ? "unchanged" : "planned" })
  }
  if (apply) for (const item of plan) {
    if (item.state === "unchanged") continue
    const after = await call("patch_saved_query", { id: item.id, etag: item.before.etag, patch: item.patch })
    assert.deepEqual(after.document, item.desired, `${item.id} write changed unexpected fields`)
    const persisted = await call("get_saved_query", { id: item.id })
    assert.deepEqual(persisted.document, item.desired, `${item.id} did not persist`)
    assert.equal(persisted.etag, after.etag, `${item.id} changed during verification`)
    item.after = persisted; item.state = "updated"
  }
  return plan
}

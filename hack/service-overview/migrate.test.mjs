import assert from "node:assert/strict"
import test from "node:test"
import { patches, migrate } from "./migrate.mjs"

function fixture() {
  const documents = new Map(Object.keys(patches).map(id => [id, { etag: `"${id}-v1"`, document: { id, schemaVersion: 1, name: id, kind: "metrics", providerId: "expected", query: "old", imageUrl: "https://example.test/icon.png", tags: ["keep"], metadata: { owner: "keep" }, parameters: [{ name: "service", type: "string", defaultValue: "uptime-api" }] } }]))
  const calls = []
  const call = async (name, args) => {
    calls.push({ name, args }); const current = documents.get(args.id)
    if (name === "get_saved_query") return structuredClone(current)
    assert.equal(name, "patch_saved_query"); assert.equal(args.etag, current.etag)
    const next = { document: { ...current.document, ...args.patch, metadata: { ...current.document.metadata, ...args.patch.metadata } }, etag: `"${args.id}-v2"` }
    documents.set(args.id, next); return structuredClone(next)
  }
  return { documents, calls, call }
}
test("preview reads fresh ETags without writing", async () => {
  const f = fixture(), result = await migrate(f.call, { expectedProviderId: "expected" })
  assert.equal(result.length, 6); assert.ok(result.every(item => item.state === "planned"))
  assert.ok(f.calls.every(item => item.name === "get_saved_query"))
})
test("apply preserves unrelated fields, validates each write and is idempotent", async () => {
  const f = fixture(), first = await migrate(f.call, { expectedProviderId: "expected", apply: true })
  assert.equal(first.length, 6); assert.ok(first.every(item => item.state === "updated"))
  for (const { document } of f.documents.values()) {
    assert.deepEqual(document.tags, ["keep"]); assert.equal(document.metadata.owner, "keep")
    assert.equal(document.imageUrl, "https://example.test/icon.png"); assert.equal(document.parameters[0].defaultValue, "uptime-api")
  }
  f.calls.length = 0
  const second = await migrate(f.call, { expectedProviderId: "expected", apply: true })
  assert.ok(second.every(item => item.state === "unchanged")); assert.ok(f.calls.every(item => item.name === "get_saved_query"))
})
test("preflight rejects an unexpected provider before any writes", async () => {
  const f = fixture(); f.documents.get(Object.keys(patches).at(-1)).document.providerId = "other"
  await assert.rejects(migrate(f.call, { expectedProviderId: "expected", apply: true }), /provider/)
  assert.ok(f.calls.every(item => item.name === "get_saved_query"))
})
test("a concurrent edit conflict stops immediately without retrying or overwriting it", async () => {
  const f = fixture(), calls = []
  await assert.rejects(migrate(async (name, args) => {
    calls.push(name); if (name === "patch_saved_query") throw new Error("ETag conflict")
    return f.call(name, args)
  }, { expectedProviderId: "expected", apply: true }), /ETag conflict/)
  assert.equal(calls.filter(name => name === "patch_saved_query").length, 1)
})

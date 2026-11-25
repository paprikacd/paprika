import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { applyDashboardPatch, mergePatch } from "../../ui/src/features/insights/dashboard-patch.ts"
import { apply, plan, validatePatchSet } from "./apply.mjs"
import { runCli } from "./cli.mjs"

const etag = (n) => `"${String(n).padStart(64, "0")}"`
const widget = (id, title, y = 0) => ({ id, title, type: "stat", providerId: "metrics", query: "up", unit: "", options: { decimals: 2 }, layout: { x: 0, y, w: 6, h: 4 } })
const document = () => ({ schemaVersion: 1, id: "svc", title: "Service", timeRange: "1h", widgets: [widget("a", "Rate"), widget("b", "Errors", 4)] })
const TOKEN = "sentinel-token-never-written"

// A fake Observe MCP endpoint that applies writes with the shared merge and enforces exact ETags.
function fakeObserve({ dashboards, savedQueries = {}, lint = () => ({ errorCount: 0, warningCount: 0, issues: [] }), failPatchFor } = {}) {
  const calls = []
  let version = 1
  const store = {
    dashboards: Object.fromEntries(Object.entries(dashboards).map(([id, doc]) => [id, { etag: etag(version++), document: doc }])),
    savedQueries: Object.fromEntries(Object.entries(savedQueries).map(([id, doc]) => [id, { etag: etag(version++), document: doc }])),
  }
  const call = async (name, args) => {
    calls.push(name)
    if (name === "get_dashboard" || name === "get_saved_query") {
      const entry = (name === "get_dashboard" ? store.dashboards : store.savedQueries)[args.id]
      if (!entry) throw new Error(`not_found: ${args.id}`)
      return structuredClone(entry)
    }
    if (name === "validate_dashboard") return lint(args.document)
    if (name === "patch_dashboard") {
      const entry = store.dashboards[args.id]
      if (failPatchFor === args.id) throw new Error("document has changed; get the latest document and ETag before retrying")
      assert.equal(args.etag, entry.etag, "stale ETag")
      const result = applyDashboardPatch(entry.document, args)
      if (result.error) throw new Error(result.error.message)
      entry.document = result.document
      entry.etag = etag(++version)
      return { document: structuredClone(entry.document), etag: entry.etag, placements: result.placements }
    }
    if (name === "patch_saved_query") {
      const entry = store.savedQueries[args.id]
      assert.equal(args.etag, entry.etag, "stale ETag")
      entry.document = mergePatch(entry.document, args.patch)
      entry.etag = etag(++version)
      return { document: structuredClone(entry.document), etag: entry.etag }
    }
    throw new Error(`unexpected tool ${name}`)
  }
  return { call, calls, store }
}

const dashboardSet = (overrides = {}) => ({
  version: 1,
  description: "test",
  dashboards: [{ id: "svc", message: "Tidy the rate panel", widget_edits: [{ op: "update", id: "a", patch: { title: "Request rate" } }] }],
  ...overrides,
})

test("plan reads and validates but does not write", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() } })
  const [item] = await plan(fake.call, dashboardSet())
  assert.equal(item.state, "planned")
  assert.equal(item.expected.widgets[0].title, "Request rate")
  assert.ok(fake.calls.every(name => name === "get_dashboard" || name === "validate_dashboard"))
})

test("apply writes each verified change once, and a second plan is unchanged", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() }, savedQueries: { q: { id: "q", name: "Up", query: "up", metadata: { owner: "team" } } } })
  const set = dashboardSet({ savedQueries: [{ id: "q", patch: { metadata: { owner: "ops" } } }] })
  const receipt = await apply(fake.call, await plan(fake.call, set))
  assert.equal(receipt.error, undefined)
  assert.deepEqual(receipt.items.map(item => item.state), ["updated", "updated"])
  assert.equal(receipt.items[0].afterEtag, fake.store.dashboards.svc.etag)
  assert.equal(fake.store.savedQueries.q.document.metadata.owner, "ops")

  fake.calls.length = 0
  const again = await plan(fake.call, set)
  assert.deepEqual(again.map(item => item.state), ["unchanged", "unchanged"])
  const idle = await apply(fake.call, again)
  assert.deepEqual(idle.items.map(item => item.state), ["unchanged", "unchanged"])
  assert.ok(fake.calls.every(name => !name.startsWith("patch_")))
})

test("a missing target blocks the whole plan before any write", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() } })
  const set = dashboardSet({ dashboards: [...dashboardSet().dashboards, { id: "missing", widget_edits: [{ op: "remove", id: "a" }] }] })
  await assert.rejects(plan(fake.call, set), /not_found: missing/)
  assert.ok(fake.calls.every(name => !name.startsWith("patch_")))
})

test("a lint error blocks the plan before any write", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() }, lint: () => ({ errorCount: 1, warningCount: 0, issues: [{ ruleId: "layout.overlap" }] }) })
  await assert.rejects(plan(fake.call, dashboardSet()), /fails validation/)
  assert.ok(fake.calls.every(name => !name.startsWith("patch_")))
})

test("a conflict stops the run without retrying or touching later targets", async () => {
  const fake = fakeObserve({ dashboards: { svc: document(), other: { ...document(), id: "other" } }, failPatchFor: "svc" })
  const set = dashboardSet({ dashboards: [...dashboardSet().dashboards, { id: "other", patch: { title: "Other" } }] })
  const receipt = await apply(fake.call, await plan(fake.call, set))
  assert.match(receipt.error, /changed; get the latest/)
  assert.deepEqual(receipt.items.map(item => item.state), ["failed", "planned"])
  assert.equal(fake.calls.filter(name => name === "patch_dashboard").length, 1)
  assert.equal(fake.store.dashboards.other.document.title, "Service")
})

test("a receipt written by the CLI holds no token", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() } })
  const dir = await mkdtemp(join(tmpdir(), "insights-patch-"))
  const receiptPath = join(dir, "receipt.json")
  const setPath = join(dir, "set.json")
  const { writeFile } = await import("node:fs/promises")
  await writeFile(setPath, JSON.stringify(dashboardSet()))
  try {
    const code = await runCli({
      argv: [setPath, "--apply", "--receipt", receiptPath],
      env: { PAPRIKA_OBSERVE_URL: "https://observe.example.test/mcp", PAPRIKA_OBSERVE_TOKEN: TOKEN },
      makeCall: (url, token) => {
        assert.equal(token, TOKEN)
        return fake.call
      },
      print() {},
      printError() {},
    })
    assert.equal(code, 0)
    const text = await readFile(receiptPath, "utf8")
    assert.ok(!text.includes(TOKEN))
    assert.equal(JSON.parse(text).items[0].state, "updated")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a set that lists one document twice, or patches an immutable saved-query field, is refused", () => {
  const twice = dashboardSet({ dashboards: [...dashboardSet().dashboards, { id: "svc", patch: { title: "Again" } }] })
  assert.throws(() => validatePatchSet(twice), /dashboard svc is listed more than once/)
  assert.throws(() => validatePatchSet(dashboardSet({ savedQueries: [{ id: "q", patch: { kind: "logs" } }] })), /q: patch cannot change kind/)
  assert.throws(() => validatePatchSet(dashboardSet({ savedQueries: [{ id: "q", patch: { name: "x" } }, { id: "q", patch: { name: "y" } }] })), /saved query q is listed more than once/)
})

test("a check that answers without an error count blocks the plan", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() }, lint: () => ({ issues: [] }) })
  await assert.rejects(plan(fake.call, dashboardSet()), /returned no errorCount/)
  assert.ok(fake.calls.every(name => !name.startsWith("patch_")))
})

test("a write against an ETag that moved after the plan stops with a receipt and no retry", async () => {
  const fake = fakeObserve({ dashboards: { svc: document(), other: { ...document(), id: "other" } } })
  const set = dashboardSet({ dashboards: [...dashboardSet().dashboards, { id: "other", patch: { title: "Other" } }] })
  const planned = await plan(fake.call, set)
  // Another writer saves svc between the plan and the apply.
  fake.store.dashboards.svc.etag = etag(99)
  fake.calls.length = 0
  const receipt = await apply(fake.call, planned)
  assert.match(receipt.error, /^svc: .*stale ETag/)
  assert.deepEqual(receipt.items.map(item => [item.id, item.state, item.afterEtag]), [["svc", "failed", null], ["other", "planned", null]])
  assert.deepEqual(fake.calls, ["patch_dashboard"])
  assert.equal(fake.store.dashboards.other.document.title, "Service")
})

test("a write that lands but does not verify keeps its new ETag in the receipt", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() } })
  const planned = await plan(fake.call, dashboardSet())
  const call = async (name, args) => {
    const result = await fake.call(name, args)
    return name === "patch_dashboard" ? { ...result, document: { ...result.document, title: "Rewritten by the server" } } : result
  }
  const receipt = await apply(call, planned)
  assert.match(receipt.error, /write changed unexpected fields/)
  assert.equal(receipt.items[0].state, "failed")
  assert.equal(receipt.items[0].afterEtag, fake.store.dashboards.svc.etag)
})

test("a CLI dry run reads and plans but never writes, and its receipt holds no token", async () => {
  const fake = fakeObserve({ dashboards: { svc: document() } })
  const dir = await mkdtemp(join(tmpdir(), "insights-patch-"))
  const receiptPath = join(dir, "receipt.json")
  const setPath = join(dir, "set.json")
  const { writeFile } = await import("node:fs/promises")
  await writeFile(setPath, JSON.stringify(dashboardSet()))
  const printed = []
  try {
    const code = await runCli({
      argv: [setPath, "--receipt", receiptPath],
      env: { PAPRIKA_OBSERVE_URL: "https://observe.example.test/mcp", PAPRIKA_OBSERVE_TOKEN: TOKEN },
      makeCall: () => fake.call,
      print: line => printed.push(line),
      printError: line => printed.push(line),
    })
    assert.equal(code, 0)
    assert.ok(fake.calls.every(name => !name.startsWith("patch_")))
    assert.equal(fake.store.dashboards.svc.document.widgets[0].title, "Rate")
    const text = await readFile(receiptPath, "utf8")
    assert.ok(!text.includes(TOKEN))
    assert.ok(!printed.join("\n").includes(TOKEN))
    assert.deepEqual(JSON.parse(text).items.map(item => item.state), ["planned"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the set format rejects unknown fields and invalid edits", () => {
  assert.throws(() => validatePatchSet({ version: 2, dashboards: [] }), /version/)
  assert.throws(() => validatePatchSet(dashboardSet({ dashboards: [{ id: "svc", op: "update", patch: { title: "x" } }] })), /unknown field op/)
  assert.throws(() => validatePatchSet(dashboardSet({ dashboards: [{ id: "svc", widget_edits: [{ op: "update", id: "a" }] }] })), /svc/)
})

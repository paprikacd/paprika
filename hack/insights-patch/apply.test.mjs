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

test("the set format rejects unknown fields and invalid edits", () => {
  assert.throws(() => validatePatchSet({ version: 2, dashboards: [] }), /version/)
  assert.throws(() => validatePatchSet(dashboardSet({ dashboards: [{ id: "svc", op: "update", patch: { title: "x" } }] })), /unknown field op/)
  assert.throws(() => validatePatchSet(dashboardSet({ dashboards: [{ id: "svc", widget_edits: [{ op: "update", id: "a" }] }] })), /svc/)
})

// Plans and applies reviewed dashboard and saved-query patches through an authenticated Observe MCP client.
// The merge is the one the UI uses (ui/src/features/insights/dashboard-patch.ts), so a plan shows exactly what
// the canvas would hold. Plans read every target and validate every merged dashboard before the first write.
// A conflict or failure stops the run; nothing is retried.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { applyDashboardPatch, mergePatch, validateDashboardPatch } from "../../ui/src/features/insights/dashboard-patch.ts"

const ITEM_FIELDS = { dashboards: ["id", "message", "patch", "widget_edits", "expect"], savedQueries: ["id", "patch", "expect"] }

/** Throws unless the value is a version-1 patch set. Dashboard patches are checked with the shared validator. */
export function validatePatchSet(set) {
  assert.ok(set && typeof set === "object" && !Array.isArray(set), "patch set must be a JSON object")
  assert.equal(set.version, 1, "patch set version must be 1")
  assert.ok(set.dashboards === undefined || Array.isArray(set.dashboards), "dashboards must be an array")
  assert.ok(set.savedQueries === undefined || Array.isArray(set.savedQueries), "savedQueries must be an array")
  for (const entry of set.dashboards ?? []) {
    for (const key of Object.keys(entry)) assert.ok(ITEM_FIELDS.dashboards.includes(key), `${entry.id}: unknown field ${key}`)
    assert.ok(typeof entry.id === "string" && entry.id, "every dashboard needs an id")
    const checked = validateDashboardPatch(patchArguments(entry))
    assert.equal(checked.error, null, `${entry.id}: ${checked.error?.message}`)
  }
  for (const entry of set.savedQueries ?? []) {
    for (const key of Object.keys(entry)) assert.ok(ITEM_FIELDS.savedQueries.includes(key), `${entry.id}: unknown field ${key}`)
    assert.ok(typeof entry.id === "string" && entry.id, "every saved query needs an id")
    assert.ok(entry.patch && typeof entry.patch === "object" && !Array.isArray(entry.patch) && Object.keys(entry.patch).length > 0, `${entry.id}: saved query patch must be a nonempty object`)
  }
  return set
}

export async function loadPatchSet(path) {
  return validatePatchSet(JSON.parse(await readFile(path, "utf8")))
}

function patchArguments(entry) {
  return {
    ...(entry.patch !== undefined ? { patch: entry.patch } : {}),
    ...(entry.widget_edits !== undefined ? { widget_edits: entry.widget_edits } : {}),
  }
}

function assertExpect(entry, document) {
  for (const [key, value] of Object.entries(entry.expect ?? {}))
    assert.ok(isDeepStrictEqual(document?.[key], value), `${entry.id}: ${key} is not the reviewed value`)
}

async function planDashboard(call, entry, preflight) {
  const current = await call("get_dashboard", { id: entry.id })
  assert.ok(current?.etag, `${entry.id} needs its exact current ETag`)
  assert.equal(current.document?.id, entry.id)
  assertExpect(entry, current.document)
  await preflight?.(entry, current)
  const input = patchArguments(entry)
  const args = { id: entry.id, etag: current.etag, ...input, ...(entry.message ? { message: entry.message } : {}) }
  const base = { collection: "dashboards", id: entry.id, beforeEtag: current.etag, before: current.document, args, placements: [], findings: null, changes: null }
  const result = applyDashboardPatch(current.document, input)
  if (result.error) {
    if (result.error.reason === "unchanged") return { ...base, expected: current.document, state: "unchanged" }
    throw new Error(`${entry.id}: ${result.error.message}`)
  }
  // The merged dashboard is linted before any write; the server's save is the authority, but a plan must not write a document Insights would reject.
  const findings = await call("validate_dashboard", { document: result.document })
  if ((findings?.errorCount ?? 0) > 0) throw new Error(`${entry.id} fails validation: ${JSON.stringify(findings.issues ?? [])}`)
  return { ...base, expected: result.document, placements: result.placements, changes: result.changes, findings, state: "planned" }
}

async function planSavedQuery(call, entry, preflight) {
  const current = await call("get_saved_query", { id: entry.id })
  assert.ok(current?.etag, `${entry.id} needs its exact current ETag`)
  assert.equal(current.document?.id, entry.id)
  assertExpect(entry, current.document)
  await preflight?.(entry, current)
  const expected = mergePatch(current.document, entry.patch)
  const state = isDeepStrictEqual(current.document, expected) ? "unchanged" : "planned"
  return {
    collection: "saved-queries",
    id: entry.id,
    beforeEtag: current.etag,
    before: current.document,
    args: { id: entry.id, etag: current.etag, patch: entry.patch },
    expected,
    placements: [],
    findings: null,
    changes: null,
    state,
  }
}

/**
 * Reads every target and returns one plan item per dashboard and saved query, in set order. Writes nothing.
 * `preflight(entry, current)` may throw to block the whole plan.
 */
export async function plan(call, set, { preflight } = {}) {
  validatePatchSet(set)
  const items = []
  for (const entry of set.dashboards ?? []) items.push(await planDashboard(call, entry, preflight))
  for (const entry of set.savedQueries ?? []) items.push(await planSavedQuery(call, entry, preflight))
  return items
}

export function receiptOf(items, { startedAt, finishedAt = new Date().toISOString(), error } = {}) {
  return {
    version: 1,
    startedAt,
    finishedAt,
    items: items.map(({ collection, id, state, beforeEtag, afterEtag = null, before, expected, after = null, changes, placements, findings }) => ({
      collection,
      id,
      state,
      beforeEtag,
      afterEtag,
      before,
      expected,
      after,
      changes,
      placements,
      findings,
    })),
    ...(error ? { error } : {}),
  }
}

/**
 * Writes the planned items in order, verifying each. A failure stops the run and is reported in the receipt;
 * the item that failed is "failed" and the later items stay "planned".
 */
export async function apply(call, planned, { now = () => new Date().toISOString() } = {}) {
  const startedAt = now()
  const items = planned.map((item) => ({ ...item }))
  let error
  for (const item of items) {
    if (item.state !== "planned") continue
    const write = item.collection === "dashboards" ? "patch_dashboard" : "patch_saved_query"
    const read = item.collection === "dashboards" ? "get_dashboard" : "get_saved_query"
    try {
      const written = await call(write, item.args)
      assert.deepEqual(written.document, item.expected, `${item.id} write changed unexpected fields`)
      const persisted = await call(read, { id: item.id })
      assert.deepEqual(persisted.document, item.expected, `${item.id} did not persist`)
      assert.equal(persisted.etag, written.etag, `${item.id} changed during verification`)
      item.afterEtag = persisted.etag
      item.after = persisted.document
      item.state = "updated"
    } catch (cause) {
      item.state = "failed"
      error = `${item.id}: ${cause instanceof Error ? cause.message : String(cause)}`
      break
    }
  }
  return receiptOf(items, { startedAt, finishedAt: now(), error })
}

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { validateDashboardPatch } from "../../ui/src/features/insights/dashboard-patch.ts"
import { validatePatchSet } from "../insights-patch/apply.mjs"

const set = JSON.parse(await readFile(new URL("./patches.json", import.meta.url), "utf8"))

test("the presentation patch set is valid for the applier", () => {
  assert.doesNotThrow(() => validatePatchSet(set))
  assert.equal(set.version, 1)
})

test("every presentation edit passes the shared dashboard patch validator", () => {
  for (const dashboard of set.dashboards) {
    assert.ok(dashboard.message, `${dashboard.id} needs a commit message`)
    for (const edit of dashboard.widget_edits) {
      assert.equal(edit.op, "update", `${dashboard.id}/${edit.id} must be an update`)
      assert.equal(validateDashboardPatch({ widget_edits: [edit] }).error, null, `${dashboard.id}/${edit.id}`)
    }
  }
})

// Checks the Insights suite manifest against the files in e2e/ and the CI smoke set.
// Run from ui/: node --test e2e/insights-suites.test.mjs
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const e2e = fileURLToPath(new URL("./", import.meta.url))
const manifest = JSON.parse(readFileSync(new URL("./insights-suites.json", import.meta.url), "utf8"))
const files = readdirSync(e2e).filter((name) => /^insights.*\.e2e\.mjs$/.test(name)).sort()
const listed = manifest.suites.map((suite) => suite.file)
const tagged = (tag) => manifest.suites.filter((suite) => suite.tags.includes(tag)).map((suite) => suite.file)

// The membership of the CI smoke tag. Changing it is a deliberate CI change: update this list and ci.yml together.
const SMOKE = [
  "e2e/insights-query-inspector.e2e.mjs",
  "e2e/insights-dashboard-query.e2e.mjs",
  "e2e/insights-observe-authoring.e2e.mjs",
  "e2e/insights-render-worker.e2e.mjs",
  "e2e/insights-tooltip-peers.e2e.mjs",
  "e2e/insights-compact-stat.e2e.mjs",
  "e2e/insights-compact-stat-compare.e2e.mjs",
  "e2e/insights-status-history-axis.e2e.mjs",
  "e2e/insights-dashboard-polish.e2e.mjs",
  "e2e/insights-presentation.e2e.mjs",
  "e2e/insights-variable-filter.e2e.mjs",
  "e2e/insights-repository-examples.e2e.mjs",
  "e2e/insights-record-charts.e2e.mjs",
  "e2e/insights-rich-charts.e2e.mjs",
  "e2e/insights-chart-system.e2e.mjs",
  "e2e/insights-editor-focus.e2e.mjs",
  "e2e/insights-edit-performance.e2e.mjs",
  "e2e/insights-tooltip-structure.e2e.mjs",
  "e2e/insights-tooltip-motion.e2e.mjs",
  "e2e/insights-hex-contour.e2e.mjs",
  "e2e/insights-builtin-selection.e2e.mjs",
  "e2e/insights-phone-shell.e2e.mjs",
]

test("every insights e2e script is listed exactly once", () => {
  assert.deepEqual(listed.filter((file, index) => listed.indexOf(file) !== index), [])
  assert.deepEqual([...listed].sort(), files.map((name) => `e2e/${name}`))
})

test("every listed suite uses known tags and needs", () => {
  for (const suite of manifest.suites) {
    for (const tag of suite.tags) assert.ok(tag in manifest.tags, `${suite.file} has unknown tag ${tag}`)
    for (const need of suite.needs) assert.ok(need in manifest.needs, `${suite.file} has unknown need ${need}`)
    assert.ok(["dev", "export"].includes(suite.server), `${suite.file} has unknown server ${suite.server}`)
    assert.ok(suite.timeoutSeconds > 0, `${suite.file} needs a timeout`)
  }
})

test("smoke tag is exactly the CI smoke set, in CI order", () => {
  assert.deepEqual(tagged("smoke"), SMOKE)
})

test("ci.yml runs the smoke tag with one retry", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")
  assert.match(ci, /node e2e\/run-insights\.mjs --tag smoke --retries 1/)
})

test("no suite depends on the rtk CLI", () => {
  for (const name of files) {
    assert.doesNotMatch(readFileSync(e2e + name, "utf8"), /"rtk"/, `${name} spawns rtk`)
  }
})

test("perf suites run against the static export", () => {
  for (const suite of manifest.suites.filter((entry) => entry.tags.includes("perf"))) {
    assert.equal(suite.server, "export", `${suite.file} must run against ui/out`)
  }
})

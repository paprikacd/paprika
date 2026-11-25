// Checks the Insights suite manifest against the files in e2e/ and the CI smoke set.
// Run from ui/: node --test e2e/insights-suites.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { changedFiles, decideRelevance, globToRegExp, relevance } from "./insights-relevance.mjs"

const e2e = fileURLToPath(new URL("./", import.meta.url))
const repository = fileURLToPath(new URL("../../", import.meta.url))
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

test("smoke skip globs match only the paths they name", () => {
  const cases = [
    ["**/*.md", "README.md", true],
    ["**/*.md", "ui/src/features/insights/gamma/README.md", true],
    ["**/*.md", "ui/src/notes.md.ts", false],
    ["**/*.md", "README.MD", false],
    ["docs/**/*.png", "docs/a.png", true],
    ["docs/**/*.png", "docs/design/insights/shot.png", true],
    ["docs/**/*.png", "ui/public/docs/a.png", false],
    [".agents/**", ".agents/skills/x/SKILL.md", true],
    [".agents/**", "x.agents/y", false],
    ["landing/**", "landing/src/page.tsx", true],
    ["landing/**", "landing", false],
    ["landing/**", "ui/landing/page.tsx", false],
    ["docs/*.json", "docs/a.json", true],
    ["docs/*.json", "docs/design/a.json", false],
    ["docs/?.md", "docs/a.md", false],
    ["docs/[ab].md", "docs/a.md", false],
  ]
  for (const [glob, path, expected] of cases) assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`)
})

test("relevance decision skips only when every changed file is in smokeSkipPaths", () => {
  const skip = manifest.smokeSkipPaths
  assert.equal(decideRelevance([], skip).relevant, true, "an empty diff runs")
  assert.equal(decideRelevance(["docs/guides/a.md", ".agents/skills/x.md"], skip).relevant, false)
  assert.equal(decideRelevance(["docs/guides/a.md", "internal/insights/schema.go"], skip).relevant, true)
  assert.equal(decideRelevance(["docs/design/insights/dashboard.schema.json"], skip).relevant, true, "the embedded schema is code")
  assert.equal(decideRelevance(["docs/design/insights/schemas.go"], skip).relevant, true)
  assert.equal(decideRelevance(["some/unknown/file"], skip).relevant, true)
})

// The skip list may only name files that no build, binary or suite reads. A tracked file that matches it must be prose,
// an image, or sit in a tree that no Insights build reads (.agents, landing). docs/design/insights is a Go package that
// embeds its JSON schemas into the service, so a docs/** rule would skip real code changes.
test("smokeSkipPaths match no code or data that a smoke build can read", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" })
  assert.equal(listed.status, 0, listed.stderr)
  const skip = manifest.smokeSkipPaths.map(globToRegExp)
  const unsafe = listed.stdout.split("\0").filter(Boolean)
    .filter((file) => skip.some((pattern) => pattern.test(file)))
    .filter((file) => !/\.(md|png|jpg)$/.test(file) && !file.startsWith(".agents/") && !file.startsWith("landing/"))
  assert.deepEqual(unsafe, [])
})

function scratchRepository(t) {
  const directory = mkdtempSync(join(tmpdir(), "insights-relevance-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = (args) => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: directory, encoding: "utf8" })
    return result.status === 0 ? result.stdout : undefined
  }
  const write = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
  const commit = (message) => {
    assert.notEqual(git(["add", "-A"]), undefined)
    assert.notEqual(git(["commit", "-q", "--allow-empty", "-m", message]), undefined)
    return git(["rev-parse", "HEAD"]).trim()
  }
  assert.notEqual(git(["init", "-q", "-b", "master"]), undefined)
  write("internal/insights/service.go", "package insights\n// a body long enough for rename detection to pair the files\n".repeat(20))
  write("docs/guide.md", "# Guide\n")
  return { git, write, commit }
}

test("relevance against a real repository fails safe", (t) => {
  const repo = scratchRepository(t)
  const skip = manifest.smokeSkipPaths
  const base = repo.commit("base")

  assert.equal(relevance(base, skip, repo.git).relevant, true, "no commits since the base runs")
  assert.equal(relevance("", skip, repo.git).relevant, true, "an empty base runs")
  assert.equal(relevance("0".repeat(40), skip, repo.git).relevant, true, "the all-zero push base runs")
  assert.equal(relevance("HEAD", skip, repo.git).relevant, true, "a ref name is not accepted as a base")
  assert.equal(relevance("1".repeat(40), skip, repo.git).relevant, true, "an unknown commit runs")

  repo.write("docs/guide.md", "# Guide\n\nMore.\n")
  repo.commit("docs only")
  assert.equal(relevance(base, skip, repo.git).relevant, false, "a docs-only change skips")

  // Renaming a Go file into docs/ as markdown must still count the old Go path.
  assert.notEqual(repo.git(["mv", "internal/insights/service.go", "docs/service.md"]), undefined)
  const afterRename = repo.commit("rename code into docs")
  assert.deepEqual(changedFiles(base, repo.git).sort(), ["docs/guide.md", "docs/service.md", "internal/insights/service.go"])
  assert.equal(relevance(base, skip, repo.git).relevant, true, "a rename out of a code path runs")

  assert.notEqual(repo.git(["rm", "-q", "docs/service.md"]), undefined)
  const beforeCode = repo.commit("delete a doc")
  assert.equal(relevance(afterRename, skip, repo.git).relevant, false, "deleting a doc skips")

  repo.write("ui/src/a.ts", "export const a = 1\n")
  const withCode = repo.commit("add code")
  assert.notEqual(repo.git(["rm", "-q", "ui/src/a.ts"]), undefined)
  repo.commit("delete code")
  assert.equal(relevance(withCode, skip, repo.git).relevant, true, "deleting a code file runs")
  assert.equal(relevance(beforeCode, skip, repo.git).relevant, true, "an add and delete that cancel out leave an empty diff, which runs")

  assert.equal(relevance(base, skip, () => undefined).relevant, true, "a git error runs")
})

test("the --relevance command prints one GITHUB_OUTPUT line and runs on doubt", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run-insights.mjs", import.meta.url)), "--relevance", "not-a-sha"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "relevant=true\n")
})

// Runs the real runner over throwaway suites. INSIGHTS_E2E_URL is set, so no server starts.
function runProbes(t, probes, retries) {
  const state = mkdtempSync(join(tmpdir(), "insights-runner-"))
  const files = []
  t.after(() => {
    for (const file of files) rmSync(file, { force: true })
    rmSync(state, { recursive: true, force: true })
  })
  const names = Object.entries(probes).map(([name, body]) => {
    const file = `e2e/insights-zz-probe-${process.pid}-${name}.e2e.mjs`
    const path = join(e2e, "..", file)
    files.push(path)
    writeFileSync(path, body)
    return file
  })
  const runner = fileURLToPath(new URL("./run-insights.mjs", import.meta.url))
  return spawnSync(process.execPath, [runner, "--retries", String(retries), ...names], {
    cwd: join(e2e, ".."), encoding: "utf8", env: { ...process.env, INSIGHTS_E2E_URL: "http://127.0.0.1:9", PROBE_STATE: state, GITHUB_ACTIONS: "true" },
  })
}

const failsOnce = `import { existsSync, writeFileSync } from "node:fs"
const marker = process.env.PROBE_STATE + "/" + process.argv[1].split("/").pop()
if (!existsSync(marker)) { writeFileSync(marker, ""); process.exit(1) }
`

test("a suite that passes only on retry is reported as flaky, not passed", (t) => {
  const result = runProbes(t, { pass: "", flaky: failsOnce }, 1)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /^\s+flaky\s.*insights-zz-probe-\d+-flaky\.e2e\.mjs \(2 attempts\)$/m)
  assert.match(result.stdout, /^\s+passed\s.*insights-zz-probe-\d+-pass\.e2e\.mjs$/m)
  assert.match(result.stdout, /1 passed, 1 flaky \(passed only on retry\), 0 failed or timed out, of 2/)
  assert.match(result.stdout, /::warning title=Flaky Insights suite::e2e\/insights-zz-probe-\d+-flaky\.e2e\.mjs/)
})

test("a failing suite fails the run after retries, and later suites still run", (t) => {
  const result = runProbes(t, { broken: "process.exit(3)", after: "" }, 1)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /^\s+failed\s.*insights-zz-probe-\d+-broken\.e2e\.mjs \(2 attempts\)$/m)
  assert.match(result.stdout, /^\s+passed\s.*insights-zz-probe-\d+-after\.e2e\.mjs$/m)
  assert.match(result.stdout, /1 passed, 0 flaky \(passed only on retry\), 1 failed or timed out, of 2/)
})

test("without retries a first failure is a failure, not flaky", (t) => {
  const result = runProbes(t, { flaky: failsOnce }, 0)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /0 passed, 0 flaky \(passed only on retry\), 1 failed or timed out, of 1/)
})

test("e2e, demo and premium-ui commands do not depend on the rtk CLI", () => {
  const listed = spawnSync("git", ["grep", "-l", "-e", "\"rtk\"", "-e", "rtk proxy", "--", "ui/e2e", "demo", "docs/design/insights/premium-ui.json", "ui/package.json"], { cwd: repository, encoding: "utf8" })
  assert.ok(listed.status === 0 || listed.status === 1, listed.stderr)
  assert.deepEqual(listed.stdout.split("\n").filter(Boolean).filter((file) => file !== "ui/e2e/insights-suites.test.mjs"), [])
})

#!/usr/bin/env node
// Prints the UI import closure of the fleet-scale UI half, relative to --root, one path per line, sorted.
//
// The closure starts from the layout files of the app shell, from the page file of every route that
// ui/e2e/fleet-scale.spec.ts visits (its goto targets), and from every Next.js convention file (layout, template,
// error, loading, not-found, default, global-error) of each segment on the way to those pages. The convention-file
// slots are printed even when empty, so adding one lapses the waiver too. Each import is followed through the TypeScript
// parser: relative imports, the "@/" alias (ui/src), index files, ".js" specifiers that name a ".ts"/".tsx"
// source, and CSS imports. Bare package specifiers are not followed. A route with no page file fails loudly.
//
// Usage: node hack/ci/fleet-ui-closure.mjs --root <repo root> --typescript <path to typescript.js>
// Used by hack/ci/fleet-lapse.sh. Node 22 or later.
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

function fail(message) {
  process.stderr.write(`fleet-ui-closure: ${message}\n`)
  process.exit(1)
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) fail(`missing ${name}`)
  return process.argv[index + 1]
}

const root = path.resolve(option("--root"))
const ts = createRequire(import.meta.url)(path.resolve(option("--typescript")))
const uiSrc = path.join(root, "ui", "src")
const appDir = path.join(uiSrc, "app")
const specPath = path.join(root, "ui", "e2e", "fleet-scale.spec.ts")
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"]

const specText = fs.readFileSync(specPath, "utf8")
// Every goto call must name its route as a double-quoted literal, so no visited route can be missed.
const gotoCalls = [...specText.matchAll(/\.goto\(\s*([^\s,)]*)/g)]
if (gotoCalls.length === 0) fail(`no page.goto targets in ${path.relative(root, specPath)}`)
const gotoTargets = gotoCalls.map((match) => {
  const literal = /^"([^"]+)"$/.exec(match[1])
  if (!literal) fail(`a goto in ${path.relative(root, specPath)} does not name a double-quoted route: ${match[0]}`)
  return literal[1]
})

// Next.js bundles a segment's convention files into every route below it, so each one on the way to a visited page is
// part of what the UI half loads. Every slot is printed, whether or not a file fills it, so that adding one (a new
// loading.tsx adds a Suspense boundary) also lapses the waiver.
const conventionNames = ["layout", "template", "error", "loading", "not-found", "default", "global-error"]
const conventionExtensions = [".tsx", ".ts", ".jsx", ".js"]
const slots = new Set()
function addSegment(dir, names) {
  for (const name of names) {
    for (const ext of conventionExtensions) {
      const file = path.join(dir, name + ext)
      slots.add(file)
      if (fs.existsSync(file)) entries.add(file)
    }
  }
}

const entries = new Set([
  path.join(appDir, "layout.tsx"),
  path.join(appDir, "dashboard", "layout.tsx"),
  path.join(appDir, "dashboard", "applications", "page.tsx"),
])
for (const target of gotoTargets) {
  if (!target.startsWith("/")) fail(`page.goto target is not an absolute path: ${target}`)
  const pathname = target.split(/[?#]/)[0]
  const segments = pathname.split("/").filter(Boolean)
  const pageDir = path.join(appDir, ...segments)
  const page = conventionExtensions.map((ext) => path.join(pageDir, "page" + ext)).find((file) => fs.existsSync(file))
  if (!page) fail(`page.goto target ${target} has no route file under ${path.relative(root, pageDir)}`)
  entries.add(page)
  addSegment(pageDir, ["page"])
  let dir = appDir
  for (const segment of ["", ...segments]) {
    dir = path.join(dir, segment)
    addSegment(dir, conventionNames)
  }
}
for (const entry of entries) {
  if (!fs.existsSync(entry)) fail(`entry file is missing: ${path.relative(root, entry)}`)
}

function resolveImport(from, specifier) {
  let base
  if (specifier.startsWith("@/")) base = path.join(uiSrc, specifier.slice(2))
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier)
  else return null
  const candidates = [base, ...extensions.map((ext) => base + ext), ...extensions.map((ext) => path.join(base, "index" + ext))]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -3)
    for (const ext of [".ts", ".tsx"]) {
      if (fs.existsSync(stem + ext)) return stem + ext
    }
  }
  return null
}

const seen = new Set()
const queue = [...entries]
while (queue.length > 0) {
  const file = queue.pop()
  if (seen.has(file)) continue
  seen.add(file)
  if (file.endsWith(".css")) continue
  const info = ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true)
  for (const imported of info.importedFiles) {
    const resolved = resolveImport(file, imported.fileName)
    if (resolved) queue.push(resolved)
  }
}

const relative = [...new Set([...seen, ...slots])].map((file) => path.relative(root, file)).sort()
process.stdout.write(relative.map((file) => `${file}\n`).join(""))

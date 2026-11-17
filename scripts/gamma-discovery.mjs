#!/usr/bin/env node
// Dependency-free client for Gamma's Streamable HTTP MCP endpoint.
// See docs/design/insights/gamma-discovery.md for installation and source rules.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"

const project = resolve(fileURLToPath(new URL("../", import.meta.url)))
const { values } = parseArgs({ options: {
  endpoint: { type: "string", default: process.env.GAMMA_MCP_URL || "http://127.0.0.1:3000/api/mcp" },
  repo: { type: "string", default: process.env.GAMMA_SOURCE_DIR || join(homedir(), "projects/gamma") },
  search: { type: "string" }, component: { type: "string" }, brief: { type: "string" },
  system: { type: "string" }, output: { type: "string" }, metadata: { type: "boolean", default: false },
  manifest: { type: "boolean", default: false }, verify: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} })

if (values.help) {
  console.log(`Gamma catalogue discovery
  node scripts/gamma-discovery.mjs --verify
  node scripts/gamma-discovery.mjs --search "breadcrumb"
  node scripts/gamma-discovery.mjs --brief breadcrumb-trail --output /tmp/gamma-brief.json
  node scripts/gamma-discovery.mjs --component breadcrumb-trail --output /tmp/gamma-component.json
  node scripts/gamma-discovery.mjs --system gamma --output /tmp/gamma-tokens.json
  node scripts/gamma-discovery.mjs --manifest

--metadata omits source/CSS for --component. --endpoint and --repo override
the local defaults. Full bundles contain shared CSS; extract relevant rules.`)
  process.exit(0)
}
const actions = [values.search !== undefined, !!values.component, !!values.brief, !!values.system, values.manifest, values.verify].filter(Boolean)
assert.ok(actions.length <= 1, "Choose one discovery action")
const endpoint = new URL(values.endpoint)
assert.ok(["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password, "Use an HTTP(S) MCP endpoint without embedded credentials")
let id = 0
let protocolVersion = "2025-11-25"
async function rpc(method, params = {}, notification = false) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": protocolVersion },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  if (notification && response.status === 202) return
  assert.ok(response.ok, `Gamma ${method} returned HTTP ${response.status}`)
  const reply = await response.json()
  assert.ok(!reply.error, `Gamma ${method}: ${reply.error?.message}`)
  return reply.result
}
async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args })
  assert.ok(!result?.isError, `Gamma ${name}: ${result?.content?.find((item) => item.type === "text")?.text || "tool failed"}`)
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === "text").text)
}
const initialized = await rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "paprika-gamma-discovery", version: "1.0.0" } })
protocolVersion = initialized.protocolVersion
await rpc("notifications/initialized", {}, true)
const { tools } = await rpc("tools/list")
for (const name of ["gamma_search_catalogue", "gamma_get_component", "gamma_get_component_brief", "gamma_get_design_system"]) {
  assert.ok(tools.some((item) => item.name === name), `Gamma is missing ${name}`)
}

const selections = [
  ["button", "Toolbar actions and save states"],
  ["breadcrumb-trail", "Dashboard drilldown path and return navigation"],
  ["search-field", "Dashboard and provider filtering"],
  ["floating-field", "Named configuration and query fields"],
  ["search-combobox", "Provider, metric, and label selection"],
  ["switch", "Independent visualization options"],
  ["tabs", "Query, style, and layout settings"],
  ["action-menu", "Widget and dashboard action menus"],
  ["context-menu", "Optional secondary widget actions"],
  ["side-sheet", "Focused editing and mobile panels"],
  ["data-table", "Tabular metrics and trace detail"],
  ["filter-bar", "Query and drilldown filter context"],
  ["tree-navigator", "Dashboard folders and hierarchy"],
  ["calendar-picker", "Civil-date selection within a time-range workflow"],
  ["tooltip", "Short supplemental control descriptions"],
  ["badge", "Provider type and status metadata"],
  ["empty-state", "Empty dashboards and no-results states"],
  ["pagination", "Bounded table navigation"],
]
const hash = (source) => createHash("sha256").update(source).digest("hex")
let result
if (values.search !== undefined) {
  const found = await tool("gamma_search_catalogue", { kind: "component", query: values.search, limit: 100 })
  result = { query: values.search, total: found.total, hasMore: found.hasMore, items: found.items.map(({ id, slug, name, summary, uri, material }) => ({ id, slug, name, summary, uri, sourceFile: material?.sourceFile })) }
} else if (values.component) {
  result = await tool("gamma_get_component", { slug: values.component, includeSource: !values.metadata })
} else if (values.brief) {
  result = await tool("gamma_get_component_brief", { slug: values.brief })
} else if (values.system) {
  result = await tool("gamma_get_design_system", { id: values.system, mode: "light" })
} else if (values.manifest) {
  const repo = resolve(values.repo)
  const commit = execFileSync("rtk", ["proxy", "git", "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const sourceSkill = join(repo, "plugins/gamma/skills/explore-gamma/SKILL.md")
  const skillSource = await readFile(sourceSkill, "utf8")
  const components = []
  for (let offset = 0; offset < selections.length; offset += 3) {
    const batch = await Promise.all(selections.slice(offset, offset + 3).map(async ([slug, use]) => {
      const [bundle, brief] = await Promise.all([
        tool("gamma_get_component", { slug, includeSource: true }),
        tool("gamma_get_component_brief", { slug }),
      ])
      assert.ok(bundle.source?.length && bundle.css?.length, `Gamma did not return maintained source/styles for ${slug}`)
      const sourceFile = `src/components/${bundle.catalog.sourceFile}`
      const local = await readFile(join(repo, sourceFile), "utf8")
      // Gamma appends required license notices and flattens shared table engines
      // in standalone bundles, so a bundle can legitimately differ from its file.
      const sourceMatchesCheckout = hash(bundle.source) === hash(local)
      return {
        slug, name: bundle.catalog.name, category: bundle.catalog.category, use,
        uri: `gamma://explore/component/${slug}`, sourceFile, sourceSha256: hash(bundle.source),
        checkoutSourceSha256: hash(local), sourceMatchesCheckout,
        cssSha256: hash(bundle.css), cssBytes: Buffer.byteLength(bundle.css), defaultSystem: brief.designSystem,
        selection: { bestFor: brief.bestFor, avoidWhen: brief.avoidWhen },
        notes: bundle.catalog.notes,
        ...(bundle.catalog.origin ? { origin: bundle.catalog.origin } : {}),
        ...(bundle.catalog.license ? { license: bundle.catalog.license, licenseUrl: bundle.catalog.licenseUrl } : {}),
        references: bundle.references,
      }
    }))
    components.push(...batch)
  }
  result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    source: { repository: repo, commit, skill: sourceSkill, skillSha256: hash(skillSource), provenance: "Maintained Gamma React implementations; external reference links are design guidance, not imported source or licenses." },
    mcp: { endpoint: endpoint.href, protocolVersion, name: initialized.serverInfo.name, version: initialized.serverInfo.version, availableTools: tools.map((item) => item.name) },
    retrieval: { script: "scripts/gamma-discovery.mjs", readBriefBeforeAdapting: true, styles: "gamma_get_component currently returns shared library CSS. Extract component rules and dependencies, retaining Gamma token semantics and reference notices." },
    components,
  }
} else {
  const found = await tool("gamma_search_catalogue", { kind: "component", query: "breadcrumb", limit: 10 })
  assert.ok(found.items.some((item) => item.slug === "breadcrumb-trail"))
  const component = await tool("gamma_get_component", { slug: "button", includeSource: true })
  assert.ok(component.source.includes("export function GammaButton") && component.css.includes(".gamma-button"))
  result = { ok: true, endpoint: endpoint.href, server: { name: initialized.serverInfo.name, version: initialized.serverInfo.version }, protocolVersion, toolCount: tools.length, verified: ["initialize", "tools/list", "gamma_search_catalogue", "gamma_get_component"], sourceBytes: Buffer.byteLength(component.source), sharedCssBytes: Buffer.byteLength(component.css) }
}
const destination = values.output || (values.manifest ? join(project, "docs/design/insights/gamma-source-catalogue.json") : null)
if (destination) {
  const path = resolve(destination)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify({ written: path, ...(values.manifest ? { components: result.components.length } : {}) }))
} else console.log(JSON.stringify(result, null, 2))

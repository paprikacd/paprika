// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  contractReferenceMarkdown,
  dashboardJSONSchema,
  pluginConfigBundle,
  pluginConfigJSONSchema,
  stableJSON,
  type PluginConfigDefinition,
} from "./contract-artifacts"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { getWidgetDefinition } from "./widget-registry"

const docs = new URL("../../../../docs/design/insights/", import.meta.url)
const builtIns: string[] = JSON.parse(readFileSync(new URL("widget-plugins.json", docs), "utf8")).pluginIds

// slo-summary checks its configuration in the dashboard schema and slo.go, not in a plugin parser.
const configuredByDocument = new Set(["slo-summary"])

registerDefaultWidgetPlugins()

/** Every built-in plugin with its own configuration schema, in the order the registry lists them. */
function publishedDefinitions(): PluginConfigDefinition[] {
  return builtIns
    .filter((id) => !configuredByDocument.has(id))
    .map((id) => {
      const definition = getWidgetDefinition("plugin", id)
      if (!definition?.configSchema) throw new Error(`built-in plugin ${id} has no configSchema`)
      return { id, dataKind: definition.dataKind, configSchema: definition.configSchema }
    })
}

// `npm run schema:generate` sets UPDATE_INSIGHTS_CONTRACT=1 and writes the bundle. Otherwise the file must equal the builder output.
function checkOrWrite(path: URL, expected: string) {
  if (process.env.UPDATE_INSIGHTS_CONTRACT === "1") {
    mkdirSync(new URL(".", path), { recursive: true })
    writeFileSync(path, expected)
    return
  }
  expect(readFileSync(path, "utf8")).toBe(expected)
}

describe("built-in plugin configuration schemas", () => {
  it("gives every built-in plugin except slo-summary a configSchema", () => {
    const missing = builtIns
      .filter((id) => !configuredByDocument.has(id))
      .filter((id) => getWidgetDefinition("plugin", id)?.configSchema === undefined)
    expect(missing).toEqual([])
  })

  it("parses the default configuration of every built-in plugin that declares one", () => {
    // Some record plugins have no default and need a configuration, so an empty one is refused on purpose.
    const failures = builtIns
      .filter((id) => !configuredByDocument.has(id))
      .filter((id) => getWidgetDefinition("plugin", id)?.defaultConfig !== undefined)
      .flatMap((id) => {
        const definition = getWidgetDefinition("plugin", id)
        if (!definition?.parseConfig) return [`${id}: no parser`]
        try {
          definition.parseConfig(definition.defaultConfig)
          return []
        } catch (error) {
          return [`${id}: ${error instanceof Error ? error.message : String(error)}`]
        }
      })
    expect(failures).toEqual([])
  })

  it("derives parseConfig from a configSchema when a plugin gives only the schema", () => {
    const definition = getWidgetDefinition("plugin", "threshold-gauge")
    expect(definition?.configSchema).toBeDefined()
    expect(definition?.parseConfig?.({})).toEqual(definition?.parseConfig?.(undefined as never))
  })

  it("publishes the built-in plugin configuration bundle", () => {
    checkOrWrite(new URL("widget-plugin-configs.schema.json", docs), stableJSON(pluginConfigBundle(publishedDefinitions())))
  })

  it("publishes the generated contract reference", () => {
    checkOrWrite(
      new URL("contract-reference.md", docs),
      contractReferenceMarkdown(dashboardJSONSchema(), pluginConfigBundle(publishedDefinitions())),
    )
  })

  it("refuses a regex whose flag the published schema would lose", () => {
    const flagged = { id: "flagged", dataKind: "records", configSchema: z.object({ colour: z.string().regex(/^#[a-f]{6}$/i) }) }
    expect(() => pluginConfigJSONSchema(flagged)).toThrow(/has flags the published schema cannot carry/)
    const plain = { id: "plain", dataKind: "records", configSchema: z.object({ colour: z.string().regex(/^#[a-fA-F]{6}$/) }) }
    expect(() => pluginConfigJSONSchema(plain)).not.toThrow()
  })

  it("agrees with the conformance fixtures for every built-in plugin", () => {
    const cases: PluginConfigCase[] = JSON.parse(readFileSync(new URL("conformance/plugin-configs.json", docs), "utf8")).cases
    const problems = cases.flatMap((entry) => {
      const schema = getWidgetDefinition("plugin", entry.pluginId)?.configSchema
      if (!schema) return [`${entry.name}: ${entry.pluginId} has no configSchema`]
      const result = schema.safeParse(entry.config ?? {})
      if (result.success !== entry.valid) return [`${entry.name}: Zod says ${result.success ? "valid" : "invalid"}`]
      // A gap case is refused by Zod only, so Go is expected to accept it and no pointer is checked.
      if (result.success || entry.pointer === undefined || entry.jsonSchemaGap) return []
      const first = result.error.issues.map((issue) => pointerOf(issue.path)).sort()[0] ?? ""
      return first.startsWith(entry.pointer) ? [] : [`${entry.name}: pointer ${entry.pointer} is not a prefix of ${first}`]
    })
    expect(problems).toEqual([])
  })

  it("has a valid and an invalid fixture for every built-in plugin with a schema", () => {
    const cases: PluginConfigCase[] = JSON.parse(readFileSync(new URL("conformance/plugin-configs.json", docs), "utf8")).cases
    const incomplete = publishedDefinitions().flatMap((definition) => {
      const mine = cases.filter((entry) => entry.pluginId === definition.id)
      return mine.some((entry) => entry.valid) && mine.some((entry) => !entry.valid) ? [] : [definition.id]
    })
    expect(incomplete).toEqual([])
  })
})

interface PluginConfigCase {
  name: string
  pluginId: string
  config: unknown
  valid: boolean
  pointer?: string
  jsonSchemaGap?: string
}

/** The RFC 6901 pointer of a Zod issue path. */
function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("")
}

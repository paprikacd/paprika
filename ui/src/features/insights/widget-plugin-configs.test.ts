// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { getWidgetDefinition } from "./widget-registry"

const builtIns: string[] = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/widget-plugins.json", import.meta.url), "utf8"),
).pluginIds

// slo-summary checks its configuration in the dashboard schema and slo.go, not in a plugin parser.
const configuredByDocument = new Set(["slo-summary"])

registerDefaultWidgetPlugins()

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
})

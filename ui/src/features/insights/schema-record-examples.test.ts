// @vitest-environment node
// The MCP authoring examples live on the Go service. Check them against the
// actual frontend plugin parsers too, since plugin config is intentionally an
// extensible envelope in the common dashboard JSON Schema.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { widgetSchema } from "./schema"
import { getWidgetDefinition } from "./widget-registry"
import { registerRecordWidgetPlugins } from "./plugins/records"

const source = readFileSync(new URL("../../../../internal/insights/schema.go", import.meta.url), "utf8")
function example(name: string) {
  const literal = source.match(new RegExp(`const ${name} = \u0060([^\u0060]+)\u0060`))?.[1]
  if (!literal) throw new Error(`Missing Go authoring example: ${name}`)
  return widgetSchema.parse(JSON.parse(literal))
}

describe("MCP record authoring examples", () => {
  registerRecordWidgetPlugins()
  it.each([
    ["schemaStyledTableExample", "record-table"],
    ["schemaGroupedTreemapExample", "record-treemap"],
  ])("accepts %s in the real %s parser", (name, pluginId) => {
    const widget = example(name)
    expect(widget.pluginId).toBe(pluginId)
    const definition = getWidgetDefinition("plugin", pluginId)
    expect(definition?.dataKind).toBe("records")
    expect(definition?.parseConfig?.(widget.config)).toEqual(widget.config)
  })
})

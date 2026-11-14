import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { getWidgetPlugins } from "./widget-registry"

// The committed list of built-in widget plugin ids. The Go lint reads the same
// file (docs/design/insights/schemas.go), so a plugin added or removed here must be
// committed with it. Regenerate after a deliberate change with
// UPDATE_WIDGET_PLUGINS=1 npx vitest run src/features/insights/widget-plugin-list.test.ts
const listPath = join(process.cwd(), "..", "docs", "design", "insights", "widget-plugins.json")

function registeredPluginIds(): string[] {
  registerDefaultWidgetPlugins()
  return getWidgetPlugins().map(plugin => plugin.id).sort()
}

describe("built-in widget plugin list", () => {
  it("matches the plugins the default registry registers", () => {
    const ids = registeredPluginIds()
    const encoded = `${JSON.stringify({ schemaVersion: 1, pluginIds: ids }, null, 2)}\n`
    if (process.env.UPDATE_WIDGET_PLUGINS === "1") {
      writeFileSync(listPath, encoded)
      return
    }
    expect(existsSync(listPath), "run with UPDATE_WIDGET_PLUGINS=1 to write the list").toBe(true)
    expect(readFileSync(listPath, "utf8")).toBe(encoded)
  })
})

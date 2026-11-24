import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { PLUGIN_DOCUMENT_CAPABILITIES } from "./plugins/plugin-capabilities"
import { getRegisteredWidgetPlugins } from "./widget-registry"

// The committed list of built-in widget plugin ids and their document capabilities. The Go lint reads the same
// file (docs/design/insights/schemas.go), so a plugin added or removed here, or a capability changed in
// plugins/plugin-capabilities.ts, must be committed with it. Regenerate after a deliberate change with
// UPDATE_WIDGET_PLUGINS=1 npx vitest run src/features/insights/widget-plugin-list.test.ts
const listPath = join(process.cwd(), "..", "docs", "design", "insights", "widget-plugins.json")

function registeredPluginIds(): string[] {
  registerDefaultWidgetPlugins()
  return getRegisteredWidgetPlugins().map(plugin => plugin.id).sort()
}

// Sorted ids and sorted capability names, so the committed file changes only when the table does.
function capabilityList(): Record<string, Record<string, true>> {
  return Object.fromEntries(Object.keys(PLUGIN_DOCUMENT_CAPABILITIES).sort().map(id => {
    const entry = PLUGIN_DOCUMENT_CAPABILITIES[id as keyof typeof PLUGIN_DOCUMENT_CAPABILITIES] as Record<string, true>;
    return [id, Object.fromEntries(Object.keys(entry).sort().map(key => [key, true as const]))];
  }));
}

describe("built-in widget plugin list", () => {
  it("matches the plugins the default registry registers and their document capabilities", () => {
    const ids = registeredPluginIds();
    const capabilities = capabilityList();
    for (const id of Object.keys(capabilities)) expect(ids, `capability for unregistered plugin ${id}`).toContain(id);
    const encoded = `${JSON.stringify({ schemaVersion: 1, pluginIds: ids, capabilities }, null, 2)}\n`;
    if (process.env.UPDATE_WIDGET_PLUGINS === "1") {
      writeFileSync(listPath, encoded)
      return
    }
    expect(existsSync(listPath), "run with UPDATE_WIDGET_PLUGINS=1 to write the list").toBe(true)
    expect(readFileSync(listPath, "utf8")).toBe(encoded)
  })
})

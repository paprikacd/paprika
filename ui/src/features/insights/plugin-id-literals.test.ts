import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Host code must read what a plugin declares (capabilities, sizing, configEditors), not name the plugin. Plugin
// modules under plugins/ register and name their own ids, so they are out of scope. Any other source file that
// names a built-in plugin id must be listed below with the reason it needs the id.
const root = join(process.cwd(), "src/features/insights");
const pluginIds: string[] = JSON.parse(
  readFileSync(join(process.cwd(), "..", "docs", "design", "insights", "widget-plugins.json"), "utf8"),
).pluginIds;

const allowed: Record<string, string> = {
  "explorer.tsx": "The explorer's view switcher maps each records view to the plugin that draws it.",
  "insights-app.tsx": "A records query opens on the record table, which is the default records view.",
  "schema.ts": "The stat icon enum names an icon, not a plugin; the SLO configuration check runs for the SLO plugin.",
  "slo.ts": "Exports the SLO plugin id that the SLO compiler and its checks name.",
  "widget-attention.ts": "Staleness and attention defaults. Moves to the registry's capabilities in a follow-up.",
  "widget-editor.tsx": "The visualization select lists the pie option by its id.",
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "plugins" || entry.name === "testdata" ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

function namedPluginIds(text: string): string[] {
  return pluginIds.filter((id) => text.includes(`"${id}"`));
}

describe("plugin ids in host code", () => {
  const files = sourceFiles(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));

  it("names a built-in plugin id only in files on the reviewed list", () => {
    const offenders = files
      .map((file) => ({ file: file.path, ids: namedPluginIds(file.text) }))
      .filter((file) => file.ids.length > 0 && !(file.file in allowed))
      .map((file) => `${file.file}: ${file.ids.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the reviewed list to files that still name a plugin id", () => {
    const stale = Object.keys(allowed).filter((file) => {
      const found = files.find((entry) => entry.path === file);
      return !found || namedPluginIds(found.text).length === 0;
    });
    expect(stale).toEqual([]);
  });
});

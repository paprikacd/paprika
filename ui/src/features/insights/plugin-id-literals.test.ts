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

// Each entry names the ids the file may spell and why. A file on the list cannot name any other plugin id.
const allowed: Record<string, { ids: readonly string[]; reason: string }> = {
  "explorer.tsx": {
    ids: ["record-list", "record-matrix", "record-table", "record-treemap", "records-bar", "records-line"],
    reason: "The explorer's records view switcher offers these plugins by id and maps each to its column fields.",
  },
  "shell/use-document-actions.ts": {
    ids: ["record-table"],
    reason: "A records query saved from the explorer opens on the record table, the default records view.",
  },
  "contract-artifacts.ts": {
    ids: ["slo-summary"],
    reason: "Publishes the SLO configuration rule into the widget JSON Schema, the same document check schema.ts holds.",
  },
  "schema.ts": {
    ids: ["pie", "slo-summary"],
    reason: "\"pie\" is a stat icon name, not the plugin. The SLO configuration check is a document rule for the SLO plugin, mirrored by internal/insights/slo.go.",
  },
  "slo.ts": {
    ids: ["slo-summary"],
    reason: "Exports the SLO plugin id that the SLO compiler and its checks name.",
  },
  "widget-attention.ts": {
    ids: ["record-table", "slo-summary", "status-grid", "status-history", "threshold-gauge"],
    reason: "Attention facts mirror internal/insights/dashboard_facts.go, which cannot read the UI registry; conformance/attention.json pins both.",
  },
  "widget-editor.tsx": {
    ids: ["pie"],
    reason: "The stat icon select offers the \"pie\" icon. It is not the pie plugin.",
  },
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "plugins" || entry.name === "testdata" ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

// Any quote style counts: "id", 'id' or `id`.
function namedPluginIds(text: string): string[] {
  return pluginIds.filter((id) => ["\"", "'", "`"].some((quote) => text.includes(`${quote}${id}${quote}`)));
}

describe("plugin ids in host code", () => {
  const files = sourceFiles(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));

  it("names a built-in plugin id only in files on the reviewed list", () => {
    const offenders = files
      .map((file) => ({ file: file.path, ids: namedPluginIds(file.text) }))
      .map((file) => ({ ...file, ids: file.ids.filter((id) => !allowed[file.file]?.ids.includes(id)) }))
      .filter((file) => file.ids.length > 0)
      .map((file) => `${file.file}: ${file.ids.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the reviewed list to files that still name a plugin id", () => {
    const stale = Object.entries(allowed).flatMap(([file, entry]) => {
      const found = files.find((source) => source.path === file);
      const named = found ? namedPluginIds(found.text) : [];
      return entry.ids.filter((id) => !named.includes(id)).map((id) => `${file}: ${id}`);
    });
    expect(stale).toEqual([]);
  });
});

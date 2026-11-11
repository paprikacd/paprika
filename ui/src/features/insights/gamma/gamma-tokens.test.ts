import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every --gamma-* name an Insights stylesheet or script reads must resolve to one of:
// a Gamma theme token, a name the same file declares for itself, or one of the
// CROSS_FILE_KNOBS below. The knobs are read by gamma/controls.module.css and set by
// the components that own each field, so each must still be declared somewhere in
// Insights; a typo in either place fails the test.
const CROSS_FILE_KNOBS = ["--gamma-field-font", "--gamma-field-font-size", "--gamma-field-min-height"];
const insightsRoot = join(process.cwd(), "src/features/insights");
const labRoot = join(process.cwd(), "../labs/widget-lab/src");
const themeFile = join(insightsRoot, "gamma/gamma-theme.module.css");

const cssDeclaration = /(--gamma-[a-z0-9-]+)\s*:/g;
const cssReference = /var\(\s*(--gamma-[a-z0-9-]+)/g;
// Script keys such as {"--gamma-x": value} declare; getPropertyValue("--gamma-x") reads.
const scriptDeclaration = /["'](--gamma-[a-z0-9-]+)["']\s*:/g;
const scriptReference = /["'](--gamma-[a-z0-9-]+)["'](?!\s*:)|var\(\s*(--gamma-[a-z0-9-]+)/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    // Unit tests use sentinel values such as var(--gamma-chart-9) as deliberately unknown input.
    return /\.(css|ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// A name ending in "-" is a prefix built at runtime, such as `--gamma-density-${index}`.
function names(text: string, pattern: RegExp, group = 1): Set<string> {
  return new Set([...text.matchAll(pattern)].map((match) => match[group] ?? match[2]).filter((name) => name && !name.endsWith("-")));
}

function declaredBy(file: string, text: string): Set<string> {
  return file.endsWith(".css") ? names(text, cssDeclaration) : names(text, scriptDeclaration);
}

function referencedBy(file: string, text: string): Set<string> {
  return file.endsWith(".css") ? names(text, cssReference) : names(text, scriptReference, 1);
}

it("resolves every gamma token that Insights and the widget lab read", () => {
  const theme = readFileSync(themeFile, "utf8");
  const themeTokens = declaredBy(themeFile, theme);
  const insightsFiles = sourceFiles(insightsRoot);
  const insightsDeclared = new Set<string>();
  for (const file of insightsFiles) for (const name of declaredBy(file, readFileSync(file, "utf8"))) insightsDeclared.add(name);
  for (const knob of CROSS_FILE_KNOBS) expect(insightsDeclared.has(knob), `${knob} must be declared in Insights`).toBe(true);

  const missing: string[] = [];
  for (const file of [...insightsFiles, ...sourceFiles(labRoot)]) {
    const text = readFileSync(file, "utf8");
    const local = declaredBy(file, text);
    for (const token of referencedBy(file, text)) {
      if (themeTokens.has(token) || local.has(token) || CROSS_FILE_KNOBS.includes(token)) continue;
      missing.push(`${relative(process.cwd(), file)} uses ${token}`);
    }
  }
  expect(missing).toEqual([]);
});

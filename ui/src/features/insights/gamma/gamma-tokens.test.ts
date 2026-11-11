import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every var(--gamma-*) an Insights stylesheet reads must be a Gamma theme token, or a
// token that the same file declares for its own component, or a --gamma-field-* knob
// that Gamma's code controls read and consumers set (see gamma/README.md).
const insightsRoot = join(process.cwd(), "src/features/insights");
const themeFile = join(insightsRoot, "gamma/gamma-theme.module.css");
const declaration = /(--gamma-[a-z0-9-]+)\s*:/g;
const reference = /var\(\s*(--gamma-[a-z0-9-]+)/g;

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

function names(css: string, pattern: RegExp): Set<string> {
  return new Set([...css.matchAll(pattern)].map((match) => match[1]));
}

it("declares every gamma token that Insights stylesheets reference", () => {
  const themeTokens = names(readFileSync(themeFile, "utf8"), declaration);
  expect(themeTokens.has("--gamma-focus")).toBe(true);
  const missing: string[] = [];
  for (const file of cssFiles(insightsRoot)) {
    const css = readFileSync(file, "utf8");
    const local = names(css, declaration);
    for (const token of names(css, reference)) {
      if (themeTokens.has(token) || local.has(token) || token.startsWith("--gamma-field-")) continue;
      missing.push(`${relative(process.cwd(), file)} uses ${token}`);
    }
  }
  expect(missing).toEqual([]);
});

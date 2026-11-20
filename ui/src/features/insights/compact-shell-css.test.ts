import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Compact view's layout is theme-independent: a rule that pairs a theme
// attribute with a compact density or shell attribute would make light and dark
// desktop layouts diverge again. The only permitted pairing is the dark palette
// block in gamma-theme, which may declare custom properties and nothing else.
const base = join(process.cwd(), "src/features/insights");
const files = [
  join(base, "insights.module.css"),
  ...readdirSync(join(base, "plugins")).filter(name => name.endsWith(".module.css")).map(name => join(base, "plugins", name)),
  join(base, "gamma/gamma-theme.module.css"),
  join(base, "gamma/gamma.module.css"),
  join(base, "gamma/controls.module.css"),
];

function stripComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Each rule prelude is the text between the previous brace or semicolon and its opening brace.
function rules(css: string) {
  const text = stripComments(css);
  const found: { prelude: string; body: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let start = i - 1;
    while (start >= 0 && !"{};".includes(text[start])) start--;
    const prelude = text.slice(start + 1, i).trim();
    let depth = 1;
    let end = i + 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}") depth--;
      end++;
    }
    found.push({ prelude, body: text.slice(i + 1, end - 1) });
  }
  return found;
}

const themed = /data-insights-theme/;
const compact = /data-density="compact"|data-compact-shell/;

it("never pairs a theme attribute with a compact density or shell selector", () => {
  for (const file of files) {
    const offenders = rules(readFileSync(file, "utf8")).filter(rule => themed.test(rule.prelude) && compact.test(rule.prelude));
    for (const rule of offenders) {
      // Only the dark palette block may pair them, and only to declare custom properties.
      const declarations = rule.body.split(";").map(part => part.trim()).filter(Boolean);
      const palette = file.endsWith("gamma/gamma-theme.module.css") && declarations.every(decl => decl.startsWith("--") || decl.startsWith("/*"));
      expect(palette, `${file}: ${rule.prelude}`).toBe(true);
    }
  }
});

it("keeps the compact layout rules keyed to the shell, not the dark theme", () => {
  const plugin = (name: string) => readFileSync(join(base, "plugins", name), "utf8");
  expect(plugin("operational-records.module.css")).toContain(":global([data-compact-shell]) .day {");
  expect(plugin("status-history.module.css")).toContain(":global([data-compact-shell]) .lanes.lanes");
  expect(plugin("records.module.css")).toContain(":global([data-compact-shell]) .compactTable:has(");
  expect(readFileSync(join(base, "insights.module.css"), "utf8")).toContain(".root[data-compact-shell] {\n    --insights-topbar-height: 32px;");
});

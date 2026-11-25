import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// The chart split rules: renderers and the chart kit import leaf modules, never the chart facade; plugins take the
// renderers through the facade, never from renderers/*; none of them hard-codes a list of hex colours. These fixtures
// run the repo's own config.
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIdsFor(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId);
}

const facadeImport = "import { EmptyState } from \"../chart-renderers\";\nexport const x = EmptyState;\n";
const hexList = "export const colours = [\"#112233\", \"#445566\"];\n";

describe("chart split lint guard", () => {
  beforeAll(() => ruleIdsFor("src/features/insights/plugins/records.tsx", "export {};\n"), 120_000);

  it.each([
    "src/features/insights/renderers/stat.tsx",
    "src/features/insights/chart-kit/index.ts",
  ])("rejects the chart-renderers facade import in %s", async (filePath) => {
    expect(await ruleIdsFor(filePath, facadeImport)).toContain("no-restricted-imports");
  }, 120_000);

  it("allows the facade import in plugins and the facade's other importers", async () => {
    expect(await ruleIdsFor("src/features/insights/plugins/records.tsx", facadeImport)).not.toContain("no-restricted-imports");
    expect(await ruleIdsFor("src/features/insights/charts.tsx", "import { EmptyState } from \"./chart-renderers\";\nexport const x = EmptyState;\n")).not.toContain("no-restricted-imports");
  }, 120_000);

  it("rejects a renderer imported past the facade in a plugin", async () => {
    const leaf = "import { EmptyState } from \"../renderers/empty-state\";\nexport const x = EmptyState;\n";
    expect(await ruleIdsFor("src/features/insights/plugins/records.tsx", leaf)).toContain("no-restricted-imports");
  }, 120_000);

  it.each([
    "src/features/insights/plugins/records.tsx",
    "src/features/insights/renderers/stat.tsx",
  ])("rejects a list of two hex colours in %s", async (filePath) => {
    expect(await ruleIdsFor(filePath, hexList)).toContain("no-restricted-syntax");
  }, 120_000);

  it("allows a single hex colour and lists of other strings", async () => {
    const ids = await ruleIdsFor("src/features/insights/plugins/records.tsx", "export const one = [\"#112233\"];\nexport const names = [\"a\", \"b\"];\n");
    expect(ids).not.toContain("no-restricted-syntax");
  }, 120_000);

  it("keeps the timer guard on renderers and plugins alongside the hex rule", async () => {
    const timer = "export const f = (x: () => void) => setTimeout(x, 180);\n";
    expect(await ruleIdsFor("src/features/insights/renderers/stat.tsx", timer)).toContain("no-restricted-syntax");
    expect(await ruleIdsFor("src/features/insights/plugins/records.tsx", timer)).toContain("no-restricted-syntax");
  }, 120_000);
});

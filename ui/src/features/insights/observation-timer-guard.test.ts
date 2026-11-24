import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// The lint guard keeps hover and focus grace out of insights hosts. These fixtures run the repo's own config.
const eslint = new ESLint({ cwd: process.cwd() });
const scheduled = "export const hide = (close: () => void) => setTimeout(close, 180);\n";

async function ruleIdsFor(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map(message => message.ruleId);
}

describe("observation timer lint guard", () => {
  // The first lint pays for loading the config and the TypeScript parser.
  beforeAll(() => ruleIdsFor("src/features/insights/plugins/records.tsx", "export {};\n"), 120_000);
  it.each([
    "src/features/insights/plugins/records.tsx",
    "src/features/insights/plugins/new-host.tsx",
    "src/features/insights/chart-renderers.tsx",
    "src/features/insights/renderers/stat.tsx",
    "src/features/insights/fixture-renderers.tsx",
    "src/features/insights/stat-sparkline.tsx",
    "src/features/insights/plugins/slo-summary.tsx",
  ])("rejects setTimeout in %s", async filePath => {
    expect(await ruleIdsFor(filePath, scheduled)).toContain("no-restricted-syntax");
  }, 120_000);

  it("rejects window.setTimeout as well", async () => {
    const code = "export const hide = (close: () => void) => window.setTimeout(close, 180);\n";
    expect(await ruleIdsFor("src/features/insights/plugins/records.tsx", code)).toContain("no-restricted-syntax");
  });

  it.each([
    "src/features/insights/tooltip-dismiss.ts",
    "src/features/insights/observation-owner.ts",
  ])("allows setTimeout in the owner itself, %s", async filePath => {
    expect(await ruleIdsFor(filePath, scheduled)).not.toContain("no-restricted-syntax");
  });
});

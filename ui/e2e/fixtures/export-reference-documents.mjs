// Writes the reference fixture dashboards to a directory as JSON, so the CI lint can check them with the
// save-path rules. No stack is needed: the bundles are the same definitions the browser suites import.
// Usage: node --experimental-strip-types ui/e2e/fixtures/export-reference-documents.mjs OUT_DIR
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { referenceDashboardBundles } from "./reference-dashboard-data.ts";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: export-reference-documents.mjs OUT_DIR");
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
let written = 0;
for (const bundle of referenceDashboardBundles) {
  for (const dashboard of bundle.dashboards) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(dashboard.id)) throw Error(`unsafe dashboard id ${dashboard.id}`);
    await writeFile(join(outDir, `${dashboard.id}.json`), `${JSON.stringify(dashboard, null, 2)}\n`);
    written++;
  }
}
console.log(`wrote ${written} reference dashboards to ${resolve(outDir)}`);

// Writes the local gallery's dashboard documents to a directory as JSON, so the
// documents can be checked offline with `paprika-insights lint DIR`. No stack is
// needed: the provider IDs are placeholders, which the lint does not read.
// Usage: node --experimental-strip-types demo/insights-gallery/export-documents.mjs OUT_DIR
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { galleryDocuments } from "./dashboards.mjs";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: export-documents.mjs OUT_DIR");
  process.exit(2);
}
const { dashboards } = galleryDocuments({
  metrics: "metrics-provider-id",
  traces: "traces-provider-id",
  records: "records-provider-id",
});
await mkdir(outDir, { recursive: true });
for (const dashboard of dashboards) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(dashboard.id)) throw Error(`unsafe dashboard id ${dashboard.id}`);
  await writeFile(join(outDir, `${dashboard.id}.json`), `${JSON.stringify(dashboard, null, 2)}\n`);
}
console.log(`wrote ${dashboards.length} gallery dashboards to ${resolve(outDir)}`);

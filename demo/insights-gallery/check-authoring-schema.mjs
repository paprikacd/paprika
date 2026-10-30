// Read-only schema discovery and range-query check against a local gallery.
// Connection details stay in the receipt's private file and are never printed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const path = process.argv[2];
if (!path) throw Error("Usage: node demo/insights-gallery/check-authoring-schema.mjs <gallery-ready.json>");
const receipt = JSON.parse(await readFile(path, "utf8"));
assert.equal(receipt.syntheticData, true);
const origin = new URL(receipt.url);
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"));
const endpoint = new URL(connection.mcpURL);
for (const url of [origin, endpoint]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && !url.search && !url.hash);
assert.equal(endpoint.pathname, "/observe/mcp");
assert.ok(connection.mcpViewerToken);
let id = 0;
async function call(name, args) {
  const requestID = ++id;
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestID, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  const body = await response.text();
  const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === requestID) : JSON.parse(body);
  assert.ok(envelope?.result, `${name}: no result`);
  assert.notEqual(envelope.result.isError, true, `${name}: tool failed`);
  return envelope.result.structuredContent;
}

const savedSchema = await call("get_insights_schema", { kind: "saved_query" });
const widgetSchema = await call("get_insights_schema", { kind: "widget" });
assert.ok(savedSchema.notes.some(note => note.includes('"range":"start"') && note.includes("does not automatically filter SQL")));
assert.ok(widgetSchema.notes.some(note => note.includes("config.showRowNumbers") && note.includes("not source-wide ranks")));
const example = savedSchema.examples.find(item => item.id === "service-history");
assert.ok(example, "Range-aware saved-query example must be discoverable");
assert.equal(example.kind, "records");
const template = JSON.parse(example.query.replace("{{service}}", JSON.stringify("checkout")));
assert.deepEqual(template.parameters, ["checkout", { range: "start" }, { range: "end" }]);
assert.match(template.sql, /observed_at >= \$2 AND observed_at <= \$3/);

// Replace only illustrative view/column names with the local sample schema;
// retain the discovered placeholders, variable and range references.
template.sql = template.sql.replace("observed_at, requests FROM reporting.service_history", "observed_at, up::int AS requests FROM gallery.service_probe_samples");
assert.match(template.sql, /gallery\.service_probe_samples/);
const query = JSON.stringify(template);
const provider = (await (await fetch(new URL("/api/insights/providers", origin))).json()).providers.find(item => item.providerRef === "observability/gallery-postgresql");
assert.ok(provider?.capabilities.includes("records"));
const end = Math.floor(Date.now() / 60_000) * 60_000;
async function records(start, finish) {
  const result = await call("query_records", { provider: provider.providerRef, query, start: new Date(start).toISOString(), end: new Date(finish).toISOString(), limit: 1000 });
  assert.equal(result.state, "OK");
  return result.data;
}
const present = await records(end - 86400_000, end);
const historical = await records(Date.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-02T00:00:00Z"));
assert.ok(present.rows.length > 0, "Current synthetic samples should be returned");
assert.equal(historical.rows.length, 0, "An empty historical window must not return current observations");
console.log("PASS read-only MCP schema: row numbers, SQL range bindings, example and real PostgreSQL historical window");

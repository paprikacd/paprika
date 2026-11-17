// Verify text-only MCP clients receive actionable failures as well as the
// authoritative structured result. Writes only a unique local fixture and
// deletes that same document with its exact ETag.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(receipt.syntheticData, true);
const origin = new URL(receipt.url);
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"));
const endpoint = new URL(connection.mcpURL);
for (const url of [origin, endpoint]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && !url.search && !url.hash);

const source = await fetch(new URL("/api/insights/dashboards/local-gallery-signal-kit", origin));
assert.equal(source.status, 200);
const doc = await source.json();
const id = `mcp-feedback-${Date.now()}`;
doc.id = id;
doc.title = "MCP feedback test";
doc.widgets = doc.widgets.filter(widget => widget.id === "expected-error" || widget.id === "expected-empty");
const missing = doc.widgets.find(widget => widget.id === "expected-empty");
missing.queryRef.id = `missing-${Date.now()}`;
const path = new URL(`/api/insights/dashboards/${id}`, origin);
const created = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(doc) });
assert.equal(created.status, 200, await created.text());
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag");
assert.ok(etag);
try {
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: { id } } }), signal: AbortSignal.timeout(45_000) });
  assert.equal(response.status, 200);
  const body = await response.text();
  const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === 1) : JSON.parse(body);
  assert.equal(envelope.error, undefined);
  assert.notEqual(envelope.result?.isError, true);
  const result = envelope.result;
  const widget = result.structuredContent.widgets.find(item => item.id === missing.id);
  assert.equal(widget.error.code, "missing_saved_query");
  const failed = result.structuredContent.signals.find(item => item.state === "error");
  assert.ok(["invalid_query", "provider_error"].includes(failed?.error?.code));
  const text = result.content.find(item => item.type === "text").text;
  assert.ok(text.includes('error "missing_saved_query"'), text);
  assert.ok(text.includes(`error "${failed.error.code}"`), text);
  console.log("PASS MCP compact text: missing saved query and real provider error are actionable and match structured results");
} finally {
  const deleted = await fetch(path, { method: "DELETE", headers: { "If-Match": etag } });
  assert.equal(deleted.status, 204, `Unable to remove test fixture: ${deleted.status}`);
}

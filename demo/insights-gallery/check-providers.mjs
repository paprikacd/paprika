// Exercise every saved query against the local real providers, without browser
// request interception. Never send credentials or requests outside loopback.
import { writeFile } from "node:fs/promises";
const origin = process.argv[2], output = process.argv[3];
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw Error("A literal loopback demo URL is required");
async function json(path, options = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    if (response.status === 429 && attempt < 7) { await new Promise(done => setTimeout(done, 300 * (attempt + 1))); continue; }
    return { status: response.status, body };
  }
  throw Error(`Repeated rate limiting: ${path}`);
}
const all = (await json("/api/insights/saved-queries")).body.queries.filter(item => item.id.startsWith("local-ab-") || item.id.startsWith("local-linked-") || item.id.startsWith("local-availability-") || item.id.startsWith("local-market-") || item.id.startsWith("local-edge-") || item.id.startsWith("local-reliability-") || item.id.startsWith("local-stress-") || item.id.startsWith("local-signal-"));
const reports = [];
for (const query of all) {
 for (const scenario of ["default", "alternate"]) {
  const alternate = { service: "payments", cluster: "delta", gateway: "delta", pipeline: "delta", sector: "Financials", company: "DEMO003", node: "node-02", source: "tempo" };
  let expanded = query.query;
  for (const parameter of query.parameters ?? []) {
    const value = scenario === "alternate" ? (alternate[parameter.name] ?? parameter.defaultValue) : parameter.defaultValue;
    expanded = expanded.replaceAll(`{{${parameter.name}}}`, JSON.stringify(value));
  }
  // Incidents are discrete, not continuous telemetry. A recent one-hour
  // window may correctly contain no event, especially as the demo ages;
  // exercise the seeded historical incidents over the board's 30-day window.
  const end = Math.floor(Date.now() / 1000);
  const incidentHistory = ["local-ab-reliability-room-incidents", "local-reliability-attention", "local-reliability-events", "local-reliability-severity", "local-signal-incidents"].includes(query.id);
  // Company and node histories are discrete hourly observations, seeded for two days;
  // a one-hour range can correctly be empty as the demo stack ages.
  const discreteHistory = ["local-ab-fleet-atlas-resources", "local-ab-market-lens-history", "local-market-sector-history", "local-market-company-history", "local-ab-collection-control-failures", "local-edge-blocked-requests", "local-edge-gateway-events"].includes(query.id);
  const start = end - (incidentHistory ? 30 * 86400 : discreteHistory ? 7 * 86400 : 3600);
  const response = await json("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: query.providerId, kind: query.kind, query: expanded, start, end, step: 60 }) });
  const data = response.body;
  const count = query.kind === "metrics" ? (data.series ?? []).reduce((sum, series) => sum + (series.points ?? []).filter(point => typeof point.value === "number" && Number.isFinite(point.value)).length, 0) : query.kind === "records" ? data.records?.rows?.length ?? 0 : data.traces?.length ?? 0;
  const expected = query.id === "local-signal-empty" ? "empty" : query.id === "local-signal-error" ? "error" : "data";
  const matches = expected === "empty" ? response.status === 200 && count === 0 : expected === "error" ? response.status === 502 && data.error === "provider query failed; check the query and provider configuration" : response.status === 200 && count > 0;
  reports.push({ id: query.id, scenario, kind: query.kind, status: response.status, count, expected, matches, ...(response.status !== 200 ? { error: data.error ?? data.error_description ?? "Query failed" } : {}) });
  console.log(`${matches ? "PASS" : "FAIL"} ${query.id} ${scenario} ${query.kind} expected=${expected} status=${response.status} results=${count}`);
 }
}
if (output) await writeFile(output, JSON.stringify(reports, null, 2));
if (reports.length !== all.length * 2 || all.length < 65 || reports.some(item => !item.matches)) process.exitCode = 1;

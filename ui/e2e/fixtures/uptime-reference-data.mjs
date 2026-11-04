// Deterministic local-only examples for the monitor map and UTC daily views.
// These fixtures are not application templates or a production data source.
const end = Date.parse("2026-10-28T12:00:00Z");
const day = 86400000;
const thresholds = [{ value: 0, color: "#cb5a5e", label: "Unavailable" }, { value: 1, color: "#50b878", label: "Available" }];
const variable = { name: "scope", label: "Environment", defaultValue: "production", options: ["production", "staging"] };
export const uptimeExampleQueries = ["monitors", "history"].map(kind => ({
  schemaVersion: 1, id: `uptime-example-${kind}`, name: `Sample ${kind} observations`,
  providerId: "example-prometheus", kind: "metrics", query: `paprika_uptime_example_${kind}{scope={{scope}}}`,
  description: "Deterministic sample observations; not a production provider.", tags: ["sample", "availability"],
  parameters: [{ name: "scope", type: "string", defaultValue: "production" }],
}));
const widget = (id, title, pluginId, source, layout, config) => ({
  id, title, type: "plugin", pluginId, dataKind: "metrics", providerId: "example-prometheus",
  query: uptimeExampleQueries.find(query => query.id === `uptime-example-${source}`).query,
  queryRef: { id: `uptime-example-${source}`, bindings: [{ parameter: "scope", source: "variable", variable: "scope" }] },
  unit: "", options: { thresholds, showTooltip: true, showLegend: true, decimals: 0 }, config, layout,
});
export const uptimeExample = {
  schemaVersion: 1, id: "local-uptime-study", title: "Monitor availability · Sample data", folder: "Reference studies · sample",
  description: "Illustrative monitor observations. Status colors summarize samples, not measured availability over time.",
  timeRange: "7d", customTimeRange: { from: new Date(end - 30 * day).toISOString(), to: new Date(end).toISOString() }, refreshInterval: 0,
  variables: [variable], widgets: [
    widget("sample-monitor-grid", "Current monitor observations", "status-grid", "monitors", { x: 0, y: 0, w: 6, h: 5 }, { maxSeries: 512 }),
    widget("sample-uptime-calendar", "Daily observations · API", "uptime-calendar", "history", { x: 6, y: 0, w: 6, h: 5 }, { maxDays: 90, maxSeries: 1 }),
    widget("sample-uptime-timeline", "Service observations by day", "uptime-timeline", "history", { x: 0, y: 5, w: 12, h: 7 }, { maxDays: 90, maxSeries: 6 }),
  ],
};
export function installUptimeExample(fixture) {
  fixture.documents.set(uptimeExample.id, structuredClone(uptimeExample));
  for (const query of uptimeExampleQueries) fixture.savedQueries.set(query.id, structuredClone(query));
}
export function uptimeExampleResult(request) {
  const match = request.query.match(/^paprika_uptime_example_(monitors|history)\{scope=("(?:\\.|[^"\\])*")\}$/);
  if (!match) throw Error("Unsupported uptime example query");
  const scope = JSON.parse(match[2]);
  if (!["production", "staging"].includes(scope)) return { series: [] };
  const shift = scope === "production" ? 0 : 3;
  const inRange = point => point && point.timestamp >= request.start * 1000 && point.timestamp <= request.end * 1000;
  if (match[1] === "monitors") return { series: Array.from({ length: 480 }, (_, index) => ({
    name: `monitor-${String(index + 1).padStart(3, "0")}`, labels: { monitor: `monitor-${String(index + 1).padStart(3, "0")}`, scope },
    points: [{ timestamp: end - day, value: 1 }, { timestamp: end, value: index % 47 === 5 + shift ? null : index % 37 === 9 + shift ? 0 : 1 }].filter(inRange),
  })) };
  const names = ["API", "Web", "Worker", "Database", "Gateway"];
  return { series: names.map((name, index) => ({ name, labels: { service: name, scope }, points: Array.from({ length: 31 }, (_, offset) => {
    if ((offset + index * 5 + shift) % 43 === 4) return null;
    const value = (offset + index * 7 + shift) % 37 === 13 ? 0 : (offset + index * 3 + shift) % 41 === 17 ? null : 1;
    return { timestamp: end - (30 - offset) * day, value };
  }).filter(inRange) })) };
}

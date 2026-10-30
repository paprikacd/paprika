// Read-only MCP integration check against one isolated local gallery harness.
// The receipt identifies the private connection file; tokens are never printed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const receiptPath = process.argv[2];
if (!receiptPath) throw Error("Usage: node demo/insights-gallery/check-mcp-bundles.mjs <gallery-ready.json>");
const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
const origin = new URL(receipt.url);
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"));
const endpoint = new URL(connection.mcpURL);
for (const url of [origin, endpoint]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && !url.search && !url.hash, "Only a loopback harness is supported");
assert.equal(receipt.syntheticData, true, "Expected the isolated synthetic gallery receipt");
assert.equal(endpoint.pathname, "/observe/mcp");
assert.ok(connection.mcpViewerToken, "The read-only fixture token is required");

let rpcID = 0;
async function mcp(method, params) {
  const id = ++rpcID;
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(45_000) });
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
  const body = await response.text();
  const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id) : JSON.parse(body);
  assert.ok(envelope, `${method}: no response`);
  assert.equal(envelope.error, undefined, `${method}: ${envelope.error?.message}`);
  assert.notEqual(envelope.result?.isError, true, `${method}: tool returned an error`);
  return envelope.result;
}
async function dashboard(id) {
  const response = await fetch(new URL(`/api/insights/dashboards/${encodeURIComponent(id)}`, origin), { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `read ${id}: HTTP ${response.status}`);
  return { document: await response.json(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") };
}
async function tracesForScope(query, service, cluster, queryBounds) {
  const expression = query.query.replaceAll("{{service}}", JSON.stringify(service)).replaceAll("{{cluster}}", JSON.stringify(cluster));
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(new URL("/api/insights/query", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: query.providerId, kind: "traces", query: expression, start: Date.parse(queryBounds.start) / 1000, end: Date.parse(queryBounds.end) / 1000, step: 60 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < 7) { await new Promise(done => setTimeout(done, 500 * (attempt + 1))); continue; }
    assert.equal(response.status, 200, `Trace scope ${service}/${cluster}: HTTP ${response.status}`);
    return (await response.json()).traces ?? [];
  }
  throw Error(`Trace scope ${service}/${cluster} remained rate-limited`);
}
const selected = {
  "local-gallery-service-pulse": { variables: { service: "payments" }, widget: "traces", field: "service", value: "payments" },
  "local-gallery-fleet-atlas": { variables: { cluster: "delta", node: "node-02" }, widget: "selected-node-detail", field: "node", value: "node-02" },
  "local-gallery-edge-watch": { variables: { gateway: "delta", location: "Tokyo sample 2" }, widget: "geo-selected-detail", field: "label", value: "Tokyo sample 2" },
  "local-gallery-market-lens": { variables: { sector: "Financials", company: "DEMO003" }, widget: "selected-company", field: "ticker", value: "DEMO003" },
  "local-gallery-reliability-room": { variables: { service: "payments" } },
  "local-gallery-collection-control": { variables: { pipeline: "delta", source: "tempo" }, widget: "selected-source-detail", field: "source", value: "tempo" },
  "local-gallery-signal-kit": { variables: { service: "payments", cluster: "delta" } },
  "local-gallery-availability-lab": { variables: { service: "payments", cluster: "delta" } },
};
assert.deepEqual([...receipt.dashboards].sort(), [...Object.keys(selected), "local-gallery-stress-lab"].sort(), "Receipt must list the expected local demos");
const tool = (await mcp("tools/list", {})).tools.find(item => item.name === "query_dashboard");
assert.equal(tool?.annotations?.readOnlyHint, true, "Observe must advertise dashboard collection as read-only");
assert.equal(tool?.outputSchema?.properties?.schemaVersion?.const, 1);
const catalogResponse = await fetch(new URL("/api/insights/saved-queries", origin), { signal: AbortSignal.timeout(30_000) });
assert.equal(catalogResponse.status, 200);
const catalog = new Map((await catalogResponse.json()).queries.map(query => [query.id, query]));
const end = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
const bounds = { start: new Date(end - 3600_000).toISOString(), end: new Date(end).toISOString(), history_points: 8, max_series: 8, max_traces: 3 };
const aggregate = { dashboards: 0, bundles: 0, widgets: 0, metrics: 0, records: 0, traces: 0, deduplicated: 0 };
const signalFor = (bundle, id) => bundle.signals.find(signal => signal.id === bundle.widgets.find(widget => widget.id === id)?.signalId);
async function queryBundle(id, variables, queryBounds = bounds) {
  // The demo shares the real gateway's per-subject admission limit. Retry only
  // explicit capacity rejections; a partial provider result is never accepted.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(done => setTimeout(done, 1500 * (attempt + 1)));
    const result = await mcp("tools/call", { name: "query_dashboard", arguments: { id, variables, ...queryBounds } });
    const failures = result.structuredContent?.signals?.filter(signal => signal.state === "error") ?? [];
    if (!failures.some(signal => signal.error?.code === "rate_limited")) return result;
  }
  throw Error(`${id}: provider queries remained rate-limited after retries`);
}
for (const id of Object.keys(selected)) {
  const saved = await dashboard(id), scenario = selected[id];
  let baseline;
  for (const [name, variables] of [["default", {}], ["alternate", scenario.variables]]) {
    // The Reliability calendar contains discrete incident starts. A one-hour
    // window can legitimately have none, so exercise its 30-day study window.
    // These boards include seeded discrete records. A one-hour window may
    // correctly contain no events as the demo ages.
    const days = id === "local-gallery-reliability-room" ? 30 : ["local-gallery-market-lens", "local-gallery-fleet-atlas", "local-gallery-edge-watch", "local-gallery-collection-control"].includes(id) ? 7 : 0;
    const scenarioBounds = days ? { ...bounds, start: new Date(end - days * 86400_000).toISOString() } : bounds;
    const response = await queryBundle(id, variables, scenarioBounds);
    const bundle = response.structuredContent;
    assert.ok(bundle, `${id}/${name}: missing structured result`);
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.dashboard.id, id);
    assert.equal(bundle.dashboard.etag, saved.etag, `${id}/${name}: ETag mismatch`);
    const contextText = response.content.find(item => item.type === "text")?.text ?? "";
    assert.ok(contextText.includes(`Range ${JSON.stringify(bundle.range.start)} to ${JSON.stringify(bundle.range.end)}; step=${bundle.range.stepSeconds}s`), `${id}/${name}: text snapshot range missing`);
    assert.ok(contextText.includes(`observed at ${JSON.stringify(bundle.observedAt)}`), `${id}/${name}: text observation time missing`);
    assert.ok(contextText.includes(`dashboard ETag=${JSON.stringify(bundle.dashboard.etag)}`), `${id}/${name}: text dashboard revision missing`);
    for (const [key, value] of Object.entries(bundle.variables)) assert.ok(contextText.includes(`${JSON.stringify(key)}=${JSON.stringify(value)}`), `${id}/${name}: effective text variable ${key} missing`);
    const hasExpectedExamples = id === "local-gallery-signal-kit";
    assert.equal(bundle.state, hasExpectedExamples ? "partial" : "ok", `${id}/${name}: bundle is ${bundle.state}; ${bundle.signals.filter(signal => signal.state !== "ok").map(signal => `${signal.id}:${signal.state}:${signal.error?.code ?? ""}`).join(", ")}`);
    assert.equal(bundle.widgets.length, saved.document.widgets.length);
    for (const signal of bundle.signals) {
      if (signal.kind !== "metrics" || signal.error) continue;
      assert.ok(Number.isInteger(signal.seriesReturned) && signal.seriesReturned >= 0, `${id}/${name}: missing bounded provider series count`);
      assert.equal(signal.seriesOmitted, signal.seriesReturned - (signal.series?.length ?? 0), `${id}/${name}: omitted series count`);
      assert.equal(Boolean(signal.seriesTruncated), signal.seriesOmitted > 0, `${id}/${name}: series truncation flag`);
      const line = contextText.split("\n").find(text => text.startsWith(`${signal.id} `));
      if (line) assert.ok(line.includes(`returned series=${signal.seriesReturned} (bounded response), omitted summaries=${signal.seriesOmitted}`), `${id}/${name}: compact count context`);
      else assert.ok(contextText.includes("structuredContent"), `${id}/${name}: omitted compact signal not disclosed`);
    }
    for (const widget of bundle.widgets) {
      const authored = saved.document.widgets.find(item => item.id === widget.id);
      assert.equal(widget.savedQueryId, authored.queryRef?.id, `${id}/${widget.id}: saved-query identity`);
      assert.equal(widget.annotationSavedQueryId, authored.annotationSource?.queryRef?.id, `${id}/${widget.id}: annotation saved-query identity`);
      for (const [signalID, queryRef, kind, fallback] of [
        [widget.signalId, authored.queryRef, authored.type === "plugin" ? authored.dataKind : authored.type === "traces" ? "traces" : "metrics", authored.providerId],
        [widget.annotationSignalId, authored.annotationSource?.queryRef, "records", undefined],
      ]) {
        if (!signalID) continue;
        const signal = bundle.signals.find(item => item.id === signalID);
        assert.ok(signal, `${id}/${widget.id}: referenced signal missing`);
        assert.equal(signal.kind, kind, `${id}/${widget.id}: normalized signal kind`);
        const query = queryRef ? catalog.get(queryRef.id) : undefined;
        const provider = query?.providerId ?? fallback;
        if (!signal.error) assert.equal(signal.providerId, provider, `${id}/${widget.id}: resolved provider`);
        if (queryRef && query) assert.ok(bundle.savedQueries.some(item => item.id === queryRef.id && item.etag), `${id}/${widget.id}: saved query revision`);
      }
    }
    for (const [key, value] of Object.entries(variables)) assert.equal(bundle.variables[key], value, `${id}/${name}: variable ${key}`);
    if (id === "local-gallery-reliability-room") {
      const widget = bundle.widgets.find(item => item.id === "budget");
      const signal = signalFor(bundle, "budget");
      const last = signal?.series?.find(series => series.index === signal.primarySeries)?.last;
      const thresholds = saved.document.widgets.find(item => item.id === "budget")?.options?.thresholds;
      assert.ok(widget && last && thresholds?.length, "Budget must have an observed value and authored visual bands");
      let selected = thresholds[0];
      for (const threshold of thresholds) {
        if (threshold.value > last.value) break;
        selected = threshold;
      }
      assert.deepEqual(widget.threshold, { state: "matched", boundary: selected.value, color: selected.color, ...(selected.label ? { label: selected.label } : {}) }, "MCP band must match the displayed primary value and widget's own thresholds");
      assert.ok(contextText.includes(`widget "budget": configured visual band="matched"; boundary=${selected.value}; color=${JSON.stringify(selected.color)}`), "Compact text must identify the configured budget band");
    }
    if (id === "local-gallery-market-lens") {
      for (const widgetID of ["history", "selected-company-history"]) {
        const records = signalFor(bundle, widgetID)?.records;
        const dateIndex = records?.columns.findIndex(column => column.key === "day") ?? -1;
        assert.ok(records?.returned > 0 && dateIndex >= 0 && records.rows.length > 0, `${widgetID} must return observed history`);
        assert.ok(records.rows.every(row => Date.parse(row[dateIndex]) >= Date.parse(bundle.range.start) && Date.parse(row[dateIndex]) <= Date.parse(bundle.range.end)), `${widgetID} contains an observation outside the dashboard range`);
      }
    }
    if (id === "local-gallery-fleet-atlas") {
      const expectedCluster = variables.cluster ?? "omega";
      const conditions = signalFor(bundle, "states"), ready = signalFor(bundle, "nodes");
      assert.equal(conditions?.series?.length, 8, "Eight observed node conditions must be available");
      assert.ok(conditions.series.every(series => series.labels.cluster === expectedCluster && series.labels.node), "Node condition identities must follow the shared cluster");
      assert.ok(conditions.series.every(series => [0, 1, 2].includes(series.last?.value)), "Node condition samples must be observed states");
      assert.equal(ready?.series?.[0]?.last?.value, conditions.series.filter(series => series.last.value > 0).length, "Ready count must include ready and pressure observations only");
    }
    if (id === "local-gallery-collection-control") {
      const expectedCluster = variables.pipeline ?? "omega";
      const throughput = saved.document.widgets.find(widget => widget.id === "throughput");
      assert.equal(throughput?.type, "timeseries", "The throughput series must be overlaid rather than stacked");
      assert.equal(throughput?.options?.display, "area");
      assert.equal(throughput?.queryRef?.id, "local-ab-collection-control-throughput", "The chart must retain its live saved query");
      assert.deepEqual(new Set(signalFor(bundle, "throughput")?.series?.map(series => series.labels.signal)), new Set(["metrics", "logs", "traces"]), "Throughput must expose the three independent provider series");
      const jobs = signalFor(bundle, "job-states");
      assert.equal(jobs?.series?.length, 6, "Six sampled job histories must be returned");
      assert.ok(jobs.series.every(series => series.labels.cluster === expectedCluster && series.labels.task), "Each job history must use the selected cluster and task identity");
      assert.equal(new Set(jobs.series.map(series => series.labels.task)).size, 6, "Scrape and backfill must not split task identities");
    }
    if (id === "local-gallery-service-pulse") {
      const traceSignal = signalFor(bundle, "traces");
      const trace = traceSignal?.traces?.examples?.[0];
      const traceLine = contextText.split("\n").find(line => line.startsWith(`${traceSignal?.id} `));
      assert.ok(trace && traceLine, "The selected service must have a real trace sample in both response forms");
      assert.ok(traceLine.includes(`trace=${JSON.stringify(trace.traceId)}`) && traceLine.includes(`status=${JSON.stringify(trace.status)}`), "Compact text must expose the sampled trace identity and status");
      if (trace.durationMs !== undefined) assert.ok(traceLine.includes(`duration=${trace.durationMs} ms`));
      if (trace.startTime !== undefined) assert.ok(traceLine.includes(`start=${trace.startTime} ms`));
      const rate = signalFor(bundle, "request-history");
      assert.deepEqual(new Set(rate?.series?.map(series => series.labels.service)), new Set([variables.service ?? "checkout", "catalog", "worker"]), "Service Pulse must show the selected service with catalog and worker rates");
      const text = response.content.find(item => item.type === "text")?.text ?? "";
      const rateLine = text.split("\n").find(line => line.startsWith(`${rate.id} `));
      assert.ok(rateLine, "Compact MCP text must include the request-rate signal");
      for (const service of [variables.service ?? "checkout", "catalog", "worker"]) {
        assert.ok(rateLine.includes(`"service"="${service}"`), `Compact MCP text must identify ${service}`);
      }
      assert.equal((rateLine.match(/last valid=/g) ?? []).length, 3, "Compact MCP text must include all three request-rate observations");
      assert.equal(bundle.widgets.find(widget => widget.id === "error-history")?.unit, "×", "Burn rate must be expressed as a multiple of the error budget");
      assert.ok(signalFor(bundle, "error-history")?.series?.some(series => series.valid > 0), "Burn rate needs recorded observations");
    }
    if (id === "local-gallery-collection-control") {
      const text = response.content.find(item => item.type === "text")?.text ?? "";
      assert.ok(text.includes('"Freshness by source": ok; first view="threshold-gauge"'), "Text-only clients must see the gauge visualization identity");
    }
    if (id === "local-gallery-signal-kit") {
      const expectedCluster = variables.cluster ?? "omega";
      const nodeShares = signalFor(bundle, "node-ratio-shares");
      assert.equal(bundle.widgets.find(widget => widget.id === "node-ratio-shares")?.savedQueryId, "local-signal-node-ratios");
      assert.equal(nodeShares?.series?.length, 8, "Pie example needs eight distinct recorded node ratios");
      assert.ok(nodeShares.series.every(series => series.labels.cluster === expectedCluster && series.labels.node && series.last?.value > 0), "Pie data must follow the selected cluster");
      const rate = signalFor(bundle, "request-history");
      assert.ok(rate?.series?.length >= 2, "Signal Kit should return both selected service and worker");
      assert.ok(rate.series.every(series => series.labels.cluster === expectedCluster), `Signal Kit request rate must use ${expectedCluster}`);
      const expectedService = variables.service ?? "checkout";
      assert.ok(rate.series.some(series => series.labels.service === expectedService));
      const traceWidget = saved.document.widgets.find(item => item.id === "cluster-traces");
      const traceSignal = signalFor(bundle, "cluster-traces");
      const traceQuery = catalog.get("local-signal-cluster-traces");
      assert.ok(traceQuery && traceWidget, "The trace view and saved query must exist");
      assert.equal(traceWidget?.queryRef?.id, traceQuery?.id, "The trace view must use its saved query");
      assert.equal(bundle.widgets.find(widget => widget.id === "cluster-traces")?.savedQueryId, traceQuery.id, "The MCP view must identify the saved query");
      for (const variable of ["service", "cluster"]) {
        assert.ok(traceWidget.queryRef.bindings.some(binding => binding.parameter === variable && binding.variable === variable), `Trace view must bind the shared ${variable}`);
      }
      assert.equal(traceSignal?.kind, "traces", "Trace view must expose a normalized trace signal");
      assert.ok(traceSignal.traces?.examples?.length > 0, "MCP must return trace examples for the selected service and cluster");
      assert.ok(traceSignal.traces.examples.every(trace => trace.service === expectedService), "Every trace example must belong to the selected service");
      const traceText = contextText.split("\n").find(line => line.startsWith(`${traceSignal.id} `));
      assert.ok(traceText && traceSignal.traces.examples.every(trace => traceText.includes(`trace=${JSON.stringify(trace.traceId)}`)), "Compact text must include the observed trace identities");
      // Trace summaries intentionally omit arbitrary resource attributes. Check
      // their identities against the same provider query, plus a different
      // cluster, rather than inventing cluster labels in the MCP response.
      const [matching, other] = await Promise.all([
        tracesForScope(traceQuery, expectedService, expectedCluster, scenarioBounds),
        tracesForScope(traceQuery, expectedService, expectedCluster === "omega" ? "delta" : "omega", scenarioBounds),
      ]);
      assert.ok(matching.length && other.length, "Both synthetic clusters must have trace observations");
      const matchingIds = new Set(matching.map(trace => trace.traceId));
      const otherIds = new Set(other.map(trace => trace.traceId));
      for (const trace of traceSignal.traces.examples) {
        assert.ok(!otherIds.has(trace.traceId), "MCP trace must not come from the other cluster");
        if (!matchingIds.has(trace.traceId)) {
          // Tempo may return a different bounded search page between the
          // bundle and this follow-up as the rolling fixture grows. Restrict
          // the comparison around that trace rather than assuming pagination
          // ordering is stable or treating a capped page as exhaustive.
          assert.ok(Number.isFinite(trace.startTime), "A missing trace must have a timestamp for scoped comparison");
          const near = { ...scenarioBounds, start: new Date(Math.max(Date.parse(scenarioBounds.start), trace.startTime - 30_000)).toISOString(), end: new Date(Math.min(Date.parse(scenarioBounds.end), trace.startTime + 30_000)).toISOString() };
          const nearby = await tracesForScope(traceQuery, expectedService, expectedCluster, near);
          assert.ok(nearby.some(entry => entry.traceId === trace.traceId), "MCP trace must be returned by its selected cluster");
        }
      }
      for (const widgetId of ["request-history", "latency", "states", "latency-distribution"]) {
        const widget = saved.document.widgets.find(item => item.id === widgetId);
        assert.ok(widget?.queryRef?.bindings.some(binding => binding.parameter === "cluster" && binding.variable === "cluster"), `${widgetId}: missing shared cluster binding`);
      }
      const annotations = saved.document.widgets.find(item => item.id === "request-history")?.annotationSource;
      assert.ok(annotations?.queryRef?.bindings.some(binding => binding.parameter === "cluster" && binding.variable === "cluster"), "Incident markers must use the selected cluster");
      const rateWidget = bundle.widgets.find(item => item.id === "request-history");
      const events = bundle.signals.find(item => item.id === rateWidget?.annotationSignalId);
      const scopeColumn = events?.records?.columns.findIndex(column => column.key === "scope") ?? -1;
      assert.ok(scopeColumn >= 0, "Incident marker records must expose their scope even when the window is empty");
      assert.ok(events.records.rows.every(row => row[scopeColumn] === expectedCluster), "Incident markers must belong to the selected cluster");
      const oldSamples = bundle.widgets.find(item => item.id === "expected-stale")?.freshness;
      assert.equal(oldSamples?.state, "stale", "The intentionally old returned sample must be reported as stale");
      assert.ok(oldSamples.ageSeconds > oldSamples.thresholdSeconds && Number.isFinite(oldSamples.lastTimestamp));
      const text = response.content.find(item => item.type === "text")?.text ?? "";
      assert.ok(text.includes('widget "expected-stale": returned sample freshness=stale'), "Compact text must disclose the stale sample");
    }
    const savedIds = new Set(bundle.savedQueries.map(query => query.id));
    for (const widget of saved.document.widgets) {
      const reportedWidget = bundle.widgets.find(item => item.id === widget.id);
      assert.ok(reportedWidget, `${id}/${name}/${widget.id}: widget metadata missing`);
      assert.equal(reportedWidget.type, widget.type, `${id}/${name}/${widget.id}: visualization type mismatch`);
      if (widget.type === "plugin") {
        assert.equal(reportedWidget.pluginId, widget.pluginId, `${id}/${name}/${widget.id}: plugin visualization identity missing`);
        assert.equal(reportedWidget.dataKind, widget.dataKind, `${id}/${name}/${widget.id}: plugin input kind mismatch`);
      } else {
        assert.equal(reportedWidget.pluginId, undefined, `${id}/${name}/${widget.id}: unexpected plugin identity`);
        assert.equal(reportedWidget.dataKind, undefined, `${id}/${name}/${widget.id}: unexpected plugin input kind`);
      }
      if (widget.annotationSource?.endColumn) {
        assert.equal(reportedWidget.annotationColumns?.end, widget.annotationSource.endColumn, `${id}/${name}/${widget.id}: annotation interval end mapping missing`);
      }
      assert.ok(savedIds.has(widget.queryRef.id), `${id}/${name}/${widget.id}: saved query missing`);
      const signal = signalFor(bundle, widget.id);
      assert.ok(signal, `${id}/${name}/${widget.id}: no signal`);
      if (hasExpectedExamples && widget.id === "expected-empty") {
        assert.equal(signal.state, "empty", "The absent synthetic metric must be reported as empty");
        assert.ok(!signal.error && !signal.series?.length, "Empty data is not a provider error");
        aggregate.widgets++;
        continue;
      }
      if (hasExpectedExamples && widget.id === "expected-error") {
        assert.equal(signal.state, "error", "The deliberately invalid query must be reported as an error");
        assert.ok(["invalid_query", "provider_error"].includes(signal.error?.code), `Unexpected provider error: ${signal.error?.code}`);
        aggregate.widgets++;
        continue;
      }
      assert.equal(signal.state, "ok", `${id}/${name}/${widget.id}: ${signal.state} ${signal.error?.message ?? ""}`);
      if (signal.series?.length) { assert.ok(signal.series.some(series => series.valid > 0)); aggregate.metrics++; }
      else if (signal.records) { assert.ok(signal.records.returned > 0); aggregate.records++; }
      else if (signal.traces) { assert.ok(signal.traces.returned > 0); aggregate.traces++; }
      else throw Error(`${id}/${name}/${widget.id}: no metrics, records or traces`);
      aggregate.widgets++;
    }
    if (name === "alternate" && scenario.widget) {
      const signal = signalFor(bundle, scenario.widget);
      if (signal.traces) assert.ok(signal.traces.examples.some(trace => trace[scenario.field] === scenario.value), `${id}: trace service override did not reach Tempo`);
      else {
        const column = signal.records.columns.findIndex(item => item.key === scenario.field);
        assert.ok(column >= 0 && signal.records.rows.some(row => row[column] === scenario.value), `${id}: selected record ${scenario.field} did not reach PostgreSQL`);
      }
    }
    if (name === "default") baseline = bundle;
    else {
      // A returned variable alone is not evidence that provider inputs changed.
      // Require at least one independently bound signal to actually change for
      // every variable with a single-variable widget query.
      for (const variable of Object.keys(variables)) {
        const independentlyBound = saved.document.widgets.filter(widget => {
          const bindings = widget.queryRef?.bindings?.filter(binding => binding.source === "variable") ?? [];
          return bindings.length === 1 && bindings[0].variable === variable;
        });
        if (!independentlyBound.length) continue; // Dependent selections are asserted from exact record/trace fields above.
        const fingerprint = signal => JSON.stringify({ series: signal.series?.map(series => ({ labels: series.labels, last: series.last?.value })), records: signal.records?.rows, traces: signal.traces?.examples?.map(trace => [trace.service, trace.traceId]) });
        assert.ok(independentlyBound.some(widget => fingerprint(signalFor(baseline, widget.id)) !== fingerprint(signalFor(bundle, widget.id))), `${id}: changing ${variable} did not change any independently bound signal`);
      }
    }
    assert.ok(bundle.queryCount.executed <= bundle.queryCount.planned);
    aggregate.deduplicated += bundle.queryCount.deduplicated;
    aggregate.bundles++;
    console.log(`PASS ${id} ${name}: ${bundle.widgets.length} widgets, ${bundle.queryCount.executed} provider queries, ${bundle.queryCount.deduplicated} deduplicated`);
  }
  aggregate.dashboards++;
}
// Compare the same real provider result with a tighter compact-output limit.
const narrow = (await queryBundle("local-gallery-fleet-atlas", { cluster: "omega" }, { ...bounds, widget_ids: ["states"], max_series: 1 })).structuredContent;
const narrowSignal = signalFor(narrow, "states");
assert.equal(narrowSignal.seriesReturned, 8, "Fetched node series count must come from Prometheus");
assert.equal(narrowSignal.seriesOmitted, 7, "One retained summary must disclose seven fetched omissions");
assert.equal(narrowSignal.series.length, 1);
assert.equal(narrowSignal.seriesTruncated, true);
const emptyResponse = await queryBundle("local-gallery-signal-kit", {}, { ...bounds, widget_ids: ["expected-empty"] });
const empty = signalFor(emptyResponse.structuredContent, "expected-empty");
assert.equal(empty?.kind, "metrics");
assert.equal(empty?.state, "empty", "The real Prometheus provider must return a successful empty result");
assert.equal(empty?.seriesReturned, 0, "Successful empty metrics must retain their zero provider-series count");
assert.equal(empty?.seriesOmitted, 0, "Successful empty metrics must retain their zero omitted-series count");
assert.ok(emptyResponse.content.find(item => item.type === "text")?.text.includes("returned series=0 (bounded response), omitted summaries=0"), "Compact text must also disclose both zero counts");
// This dashboard deliberately exceeds the source limits. A machine reader must
// see a partial state rather than treating its bounded preview as a full count.
const stressEnd = Date.now() - 1000;
const stressResponse = await queryBundle("local-gallery-stress-lab", { cluster: "delta", service: "payments" }, { ...bounds, start: new Date(stressEnd - 3600_000).toISOString(), end: new Date(stressEnd).toISOString() });
const stress = stressResponse.structuredContent;
assert.equal(stress.state, "ok", "The queries themselves should succeed");
for (const id of ["stress-monitors", "stress-records", "stress-traces"]) {
  const signal = signalFor(stress, id);
  assert.equal(signal.state, "ok", `${id}: expected a successful bounded query`);
  assert.equal(signal.truncated, true, `${id}: missing truncation signal`);
  assert.equal(signal.providerTruncated, true, `${id}: missing provider truncation signal`);
  const text = stressResponse.content.find(item => item.type === "text")?.text ?? "";
  const line = text.split("\n").find(item => item.startsWith(`${signal.id} `));
  assert.ok(line?.includes("partial source response"), `${id}: text-only clients must see source truncation`);
}
const monitorText = stressResponse.content.find(item => item.type === "text").text.split("\n").find(line => line.startsWith(`${signalFor(stress, "stress-monitors").id} `));
assert.ok(monitorText?.includes("series preview truncated"), "Compact metric output must disclose omitted series separately");
assert.equal(signalFor(stress, "stress-records").records.returned, 1000);
assert.ok(signalFor(stress, "stress-records").records.rowsTruncated, "Compact records must flag their smaller preview");
assert.equal(signalFor(stress, "stress-traces").traces.returned, 100, "Stress dashboard must report the bounded Tempo page");
console.log("PASS stress bundle: source and compact-preview truncation are explicit");
// Exercise the saved 30-day preset itself, including its Tempo query. The
// The other regular checks use a one-hour bound for comparisons.
const longRange = (await mcp("tools/call", { name: "query_dashboard", arguments: { id: "local-gallery-reliability-room", variables: { service: "checkout" }, history_points: 8, max_series: 8, max_traces: 3 } })).structuredContent;
assert.equal(longRange.state, "ok", `30-day reliability bundle: ${longRange.signals.filter(signal => signal.state !== "ok").map(signal => `${signal.id}:${signal.error?.code}`).join(", ")}`);
assert.equal(Date.parse(longRange.range.end) - Date.parse(longRange.range.start), 30 * 86400_000);
assert.ok(signalFor(longRange, "incident-traces").traces.returned > 0, "30-day Tempo trace query must return data");
console.log("PASS 30-day Reliability preset: Prometheus, PostgreSQL and Tempo bundle");
// Confirm Signal Kit's selected cluster against actual historical incidents;
// its current one-hour annotation query may legitimately return no records.
const signalHistory = (await queryBundle("local-gallery-signal-kit", { service: "payments", cluster: "delta" }, { ...bounds, start: new Date(end - 30 * 86400_000).toISOString() })).structuredContent;
const historicalEvents = signalHistory.signals.find(item => item.id === signalHistory.widgets.find(item => item.id === "request-history")?.annotationSignalId);
const historicalScope = historicalEvents?.records?.columns.findIndex(column => column.key === "scope") ?? -1;
assert.ok(historicalScope >= 0 && historicalEvents.records.rows.length > 0);
assert.ok(historicalEvents.records.rows.every(row => row[historicalScope] === "delta"));
console.log("PASS 30-day Signal Kit incident annotations respect the selected cluster");
assert.ok(aggregate.metrics && aggregate.records && aggregate.traces, "All three provider types must return data");
assert.ok(aggregate.deduplicated > 0, "Shared saved queries should be deduplicated");
console.log(`PASS ${aggregate.dashboards} dashboards, ${aggregate.bundles} bundles, ${aggregate.widgets} widget results (${aggregate.metrics} metrics, ${aggregate.records} records, ${aggregate.traces} traces); ${aggregate.deduplicated} queries deduplicated`);

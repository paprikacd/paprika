// Local gallery compositions. Documents are seeded into an isolated Insights
// store; telemetry comes from the real local Prometheus/Tempo/PostgreSQL stack.
import { chartFixtureCollections } from "../../ui/e2e/fixtures/rich-chart-data.ts";

const sql = (statement, variable) => JSON.stringify({ sql: statement, parameters: ["__PAPRIKA_PARAMETER__"] }).replace('"__PAPRIKA_PARAMETER__"', `{{${variable}}}`);
// Range values are prepared timestamp parameters, not SQL text substitutions.
const sqlRange = (statement, variable) => JSON.stringify({ sql: statement, parameters: ["__PAPRIKA_PARAMETER__", { range: "start" }, { range: "end" }] }).replace('"__PAPRIKA_PARAMETER__"', `{{${variable}}}`);
// The connector rejects the SQL keyword CLUSTER even as a column identifier.
// Read the demo's existing cluster column by JSON key without weakening that guard.
const q = {
  "service-pulse": {
    requests: 'sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[5m]))',
    errors: '100 * sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}},code="5xx"}[5m])) / clamp_min(sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[5m])), 0.001)',
    latency: '1000 * histogram_quantile(0.95, sum by (le) (rate(paprika_demo_request_duration_seconds_bucket{cluster="omega",service={{service}}}[5m])))',
    availability: '100 * avg_over_time(paprika_demo_service_up{cluster="omega",service={{service}}}[1h])',
    "latency-buckets": 'sum by (le) (rate(paprika_demo_request_duration_seconds_bucket{cluster="omega",service={{service}}}[5m]))',
    states: 'paprika_demo_component_up{cluster="omega",service={{service}}}',
    traces: '{ resource.service.name = {{service}} }',
  },
  "fleet-atlas": {
    cpu: '100 * avg(paprika_demo_node_cpu_ratio{cluster={{cluster}}})',
    nodes: 'sum(paprika_demo_node_condition_state{cluster={{cluster}}} > bool 0)',
    memory: '100 * avg(paprika_demo_node_memory_ratio{cluster={{cluster}}})',
    pressure: 'sum(paprika_demo_node_disk_free_bytes{cluster={{cluster}}} < bool 40000000000)',
    "node-cpu": '100 * paprika_demo_node_cpu_ratio{cluster={{cluster}}}',
    resources: sqlRange(`SELECT n.node, round((h.cpu_ratio*100)::numeric,2)::double precision AS cpu, round((n.memory_ratio*100)::numeric,2)::double precision AS memory, round((n.disk_used_ratio*100)::numeric,2)::double precision AS disk, CASE WHEN n.disk_used_ratio > (1 - 40000000000.0 / 128000000000.0) THEN 'Disk pressure' WHEN h.cpu_ratio >= 0.7 THEN 'CPU near limit' ELSE 'Healthy' END AS status, (SELECT json_agg(json_build_object('timestamp',to_char(recent.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'value',recent.cpu_ratio*100) ORDER BY recent.observed_at)::text FROM (SELECT x.observed_at,x.cpu_ratio FROM gallery.node_history x WHERE to_jsonb(x)->>'cluster'=to_jsonb(n)->>'cluster' AND x.node=n.node AND x.observed_at >= $2::timestamptz AND x.observed_at <= $3::timestamptz ORDER BY x.observed_at DESC LIMIT 240) recent) AS history FROM gallery.nodes n JOIN LATERAL (SELECT cpu_ratio FROM gallery.node_history x WHERE to_jsonb(x)->>'cluster'=to_jsonb(n)->>'cluster' AND x.node=n.node AND x.observed_at >= $2::timestamptz AND x.observed_at <= $3::timestamptz ORDER BY observed_at DESC LIMIT 1) h ON true WHERE to_jsonb(n)->>'cluster'=$1 ORDER BY cpu DESC`, "cluster"),
    states: 'paprika_demo_node_condition_state{cluster={{cluster}}}',
    disk: '100 * (1 - avg(paprika_demo_node_disk_free_bytes{cluster={{cluster}}} / paprika_demo_node_disk_total_bytes{cluster={{cluster}}}))',
  },
  "edge-watch": {
    ingress: 'paprika_demo_network_mbps{cluster={{gateway}},direction="inbound"}',
    egress: 'paprika_demo_network_mbps{cluster={{gateway}},direction="outbound"}',
    blocked: '100 * sum(rate(paprika_demo_edge_requests_total{cluster={{gateway}},outcome="blocked"}[5m])) / clamp_min(sum(rate(paprika_demo_edge_requests_total{cluster={{gateway}}}[5m])),0.001)',
    connections: 'paprika_demo_edge_connections{cluster={{gateway}}}',
    flow: 'paprika_demo_network_mbps{cluster={{gateway}}}',
    destinations: 'paprika_demo_destination_requests{cluster={{gateway}}}',
    locations: sql("SELECT label,latitude,longitude,requests AS value,status FROM (SELECT label,latitude,longitude,requests,status FROM gallery.geo_events d WHERE to_jsonb(d)->>'cluster'=$1 UNION ALL SELECT label,latitude,longitude,requests,status FROM gallery.geo_global_events g WHERE to_jsonb(g)->>'cluster'=$1) observations ORDER BY requests DESC", "gateway"),
    outcomes: 'sum by (outcome) (rate(paprika_demo_edge_requests_total{cluster={{gateway}}}[5m]))',
    risks: sqlRange(`SELECT s.source, s.country, s.risk, s.status, (SELECT json_agg(json_build_object('timestamp',to_char(recent.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'value',recent.requests) ORDER BY recent.observed_at)::text FROM (SELECT h.observed_at,h.requests FROM gallery.edge_source_history h WHERE to_jsonb(h)->>'cluster'=to_jsonb(s)->>'cluster' AND h.source=s.source AND h.observed_at >= $2::timestamptz AND h.observed_at <= $3::timestamptz ORDER BY h.observed_at DESC LIMIT 240) recent) AS trend FROM gallery.edge_sources s WHERE to_jsonb(s)->>'cluster'=$1 ORDER BY s.risk DESC`, "gateway"),
    "geo-events": sql("SELECT label, latitude, longitude, requests, status FROM gallery.geo_events e WHERE to_jsonb(e)->>'cluster'=$1 ORDER BY label", "gateway"),
  },
  "market-lens": {
    companies: 'paprika_demo_market_companies{sector={{sector}}}',
    interest: 'paprika_demo_market_short_percent{sector={{sector}}}',
    change: 'paprika_demo_market_change{sector={{sector}}}',
    coverage: 'paprika_demo_market_coverage_percent{sector={{sector}}}',
    "companies-list": sqlRange(`SELECT c.symbol AS ticker,c.name AS company,c.sector,(c.market_cap/1000000000.0)::double precision AS market_cap,c.short_percent AS short_interest,(SELECT json_agg(json_build_object('timestamp',to_char(recent.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'value',recent.value) ORDER BY recent.observed_at)::text FROM (SELECT h.observed_at,h.value FROM gallery.company_history h WHERE h.symbol=c.symbol AND h.observed_at >= $2::timestamptz AND h.observed_at <= $3::timestamptz ORDER BY h.observed_at DESC LIMIT 240) recent) AS history FROM gallery.companies c WHERE c.sector=$1 ORDER BY c.short_percent DESC`, "sector"),
    history: sqlRange('SELECT h.observed_at AS day,avg(h.value)::double precision AS short_interest,avg(c.coverage_percent)::double precision AS coverage FROM gallery.company_history h JOIN gallery.companies c ON c.symbol=h.symbol WHERE c.sector=$1 AND h.observed_at >= $2::timestamptz AND h.observed_at <= $3::timestamptz GROUP BY h.observed_at ORDER BY h.observed_at', "sector"),
  },
  "reliability-room": {
    availability: '100 * avg_over_time(paprika_demo_probe_up{cluster="omega",service={{service}}}[30d])',
    target: '99.9 + 0 * sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[1h]))',
    budget: '100 * clamp_min(1 - (1 - avg_over_time(paprika_demo_probe_up{cluster="omega",service={{service}}}[30d])) / 0.001, 0)',
    "incident-count": 'sum(1 - paprika_demo_service_up{cluster="omega",service={{service}}})',
    burn: 'label_replace((sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}},code="5xx"}[1h])) / clamp_min(sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[1h])),0.001)) / 0.001,"window","1h","","") or label_replace((sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}},code="5xx"}[6h])) / clamp_min(sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[6h])),0.001)) / 0.001,"window","6h","","")',
    incidents: sqlRange("SELECT started_at AS date,service,summary AS label,(extract(epoch FROM (least(coalesce(ended_at,$3::timestamptz),$3::timestamptz)-started_at))/60.0)::double precision AS value,severity AS status,CASE WHEN ended_at IS NULL OR ended_at>$3::timestamptz THEN 'Active' ELSE 'Resolved' END AS state FROM gallery.incidents i WHERE service=$1 AND to_jsonb(i)->>'cluster'='omega' AND started_at<=$3::timestamptz AND (ended_at IS NULL OR ended_at>=$2::timestamptz) ORDER BY started_at DESC", "service"),
  },
  "collection-control": {
    ingested: 'sum(rate(paprika_demo_pipeline_items_total{cluster={{pipeline}},signal="metrics"}[5m]))',
    freshness: 'quantile(0.95,paprika_demo_source_freshness_seconds{cluster={{pipeline}}})',
    rejected: '100 * sum(rate(paprika_demo_pipeline_rejected_total{cluster={{pipeline}}}[5m])) / clamp_min(sum(rate(paprika_demo_pipeline_items_total{cluster={{pipeline}}}[5m])),0.001)',
    sources: 'count(paprika_demo_source_freshness_seconds{cluster={{pipeline}}})',
    throughput: 'sum by (signal) (rate(paprika_demo_pipeline_items_total{cluster={{pipeline}}}[5m]))',
    "source-freshness": 'paprika_demo_source_freshness_seconds{cluster={{pipeline}}}',
    topology: sql("SELECT source,target,items AS value,state AS status FROM gallery.pipeline_edges e WHERE to_jsonb(e)->>'cluster'=$1 ORDER BY source,target", "pipeline"),
    "job-states": 'paprika_demo_job_execution_state{cluster={{pipeline}}}',
    failures: sqlRange("SELECT started_at AS started,job AS source,pipeline,(duration_ms/1000.0)::double precision AS duration_s,message,state AS status FROM gallery.jobs j WHERE to_jsonb(j)->>'cluster'=$1 AND state <> 'Succeeded' AND started_at >= $2::timestamptz AND started_at <= $3::timestamptz ORDER BY started_at DESC", "pipeline"),
  },
};
const variables = {
  "service-pulse": ["service", "Service", ["checkout", "payments"]],
  "fleet-atlas": ["cluster", "Cluster", ["omega", "delta"]],
  "edge-watch": ["gateway", "Cluster", ["omega", "delta"]],
  "market-lens": ["sector", "Sector", ["Technology", "Financials"]],
  "reliability-room": ["service", "Service", ["checkout", "payments"]],
  "collection-control": ["pipeline", "Cluster", ["omega", "delta"]],
};

export function galleryDocuments(providers) {
  const dashboards = [], savedQueries = [];
  for (const collection of chartFixtureCollections) {
    const key = collection.id.replace(/^artboard-/, ""), [variable, label, choices] = variables[key];
    const dashboard = structuredClone(collection.sample.dashboards[0]);
    dashboard.id = `local-gallery-${key}`; dashboard.title = `${collection.title} · Local demo`;
    dashboard.description = "Synthetic sample data from the local Prometheus, Tempo and PostgreSQL providers.";
    dashboard.folder = "Local gallery demos"; dashboard.variables = [{ name: variable, label, defaultValue: choices[0], options: choices }];
    dashboard.timeRange = key === "service-pulse" ? "1h" : key === "edge-watch" ? "30m" : key === "reliability-room" ? "30d" : "6h"; dashboard.refreshInterval = 0;
    for (const original of collection.sample.savedQueries) {
      const keyPart = original.id.slice(`ab-${key}-`.length), query = q[key][keyPart];
      if (!query) throw Error(`Missing gallery query for ${original.id}`);
      savedQueries.push({ ...original, id: `local-${original.id}`, query, providerId: providers[original.kind],
        description: "Synthetic local provider data; safe for demonstrations.",
        parameters: [{ name: variable, label, type: "string", defaultValue: choices[0] }],
      });
    }
    for (const widget of dashboard.widgets) {
      const oldId = widget.queryRef.id, keyPart = oldId.slice(`ab-${key}-`.length);
      widget.providerId = providers[widget.dataKind ?? (widget.type === "traces" ? "traces" : "metrics")];
      widget.query = q[key][keyPart];
      // A saved query can be shared by several original widgets. Replace the
      // reference rather than mutating a shared object returned by the clone.
      widget.queryRef = { id: `local-${oldId}`, bindings: [{ parameter: variable, source: "variable", variable }] };
    }
    if (key === "service-pulse") {
      const serviceParameter = { name: "service", label: "Service", type: "string", defaultValue: "checkout" };
      const comparisonQuery = 'sum by (service) (rate(paprika_demo_requests_total{cluster="omega",service=~"worker|catalog"}[5m])) or sum by (service) (rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[5m]))';
      const burnQuery = '(sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}},code="5xx"}[1h])) / clamp_min(sum(rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[1h])),0.001)) / 0.001';
      savedQueries.push({ schemaVersion: 1, id: "local-service-comparison", name: "Service Pulse request rate by service", kind: "metrics", providerId: providers.metrics, query: comparisonQuery, description: "Synthetic selected service, catalog and worker request rates in omega.", parameters: [serviceParameter] },
        { schemaVersion: 1, id: "local-service-burn", name: "Service Pulse error budget burn rate", kind: "metrics", providerId: providers.metrics, query: burnQuery, description: "One-hour request error rate divided by the 0.1% error budget for a 99.9% objective.", parameters: [serviceParameter] });
      dashboard.widgets.find(widget => widget.id === "latency-distribution").config.bucketUnit = "s";
      dashboard.widgets.find(widget => widget.id === "availability").title = "Observed up · last hour";
      const states = dashboard.widgets.find(widget => widget.id === "states");
      states.config = { ...states.config, labelField: "component", showTimeAxis: true };
      Object.assign(dashboard.widgets.find(widget => widget.id === "request-history"), { title: "Request rate by service", query: comparisonQuery, queryRef: { id: "local-service-comparison", bindings: [{ parameter: "service", source: "variable", variable: "service" }] },
        annotationSource: { queryRef: { id: "local-ab-reliability-room-incidents", bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, timestampColumn: "date", labelColumn: "label", severityColumn: "status" } });
      const serviceChart = dashboard.widgets.find(widget => widget.id === "request-history");
      serviceChart.options = { ...serviceChart.options, tooltipView: { type: "timeseries", title: "Selected service · request history", height: 120, showGrid: false, showAxis: false, source: { type: "saved", ref: { id: "local-ab-service-pulse-requests", bindings: [{ parameter: "service", source: "label", label: "service" }] } } } };
      serviceChart.drilldowns = [{ id: "service-traces", title: "View service traces", dashboardId: "local-gallery-reliability-room", carryTimeRange: true, bindings: [{ variable: "service", source: "label", value: "service" }] }];
      dashboard.description += " Incident markers are read from synthetic PostgreSQL records. Burn rate compares one-hour request errors with a 99.9% objective.";
      Object.assign(dashboard.widgets.find(widget => widget.id === "error-history"), { title: "Error budget burn rate · 1h", query: burnQuery, unit: "×", queryRef: { id: "local-service-burn", bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, annotationSource: { queryRef: { id: "local-ab-reliability-room-incidents", bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, timestampColumn: "date", labelColumn: "label", severityColumn: "status" } });
    }
    if (key === "fleet-atlas") {
      dashboard.widgets.find(widget => widget.id === "nodes").title = "Ready nodes · observed";
      const nodeStates = dashboard.widgets.find(widget => widget.id === "states");
      nodeStates.title = "Node condition history · observed";
      nodeStates.unit = "";
      nodeStates.options = { ...nodeStates.options, decimals: 0, thresholds: [{ value: 0, color: "#e45d50", label: "Unavailable" }, { value: 1, color: "#e4ac35", label: "Pressure" }, { value: 2, color: "#20b88b", label: "Ready" }] };
      nodeStates.config = { ...nodeStates.config, labelField: "node", showTimeAxis: true, maxSeries: 8, maxPoints: 120, segmented: true };
      nodeStates.selectionBindings = [{ variable: "node", source: "label", value: "node" }];
      dashboard.description += " Node readiness and conditions are independent synthetic observations; the ready count includes observed ready and pressure states only, and missing samples are unknown.";
      const resource = dashboard.widgets.find(widget => widget.id === "resources");
      resource.description = "CPU uses the latest observation in the selected range and the sparkline shows up to its latest 240 samples. Memory and disk are seed-time snapshots.";
      resource.config = { columns: ["node", "cpu", "memory", "disk", "history", "status"], pageSize: 10, density: "compact", showSearch: false, cellStyles: [
        { column: "cpu", display: "bar-segments", min: 0, max: 100, segments: 20, unit: "%" },
        { column: "memory", display: "bar", min: 0, max: 100, unit: "%" },
        { column: "disk", display: "color-text", unit: "%" },
        { column: "history", display: "sparkline", unit: "%" },
      ] };
      resource.options = { ...resource.options, thresholds: [{ value: 0, color: "#36a66c", label: "Normal" }, { value: 60, color: "#d4a320", label: "Warning" }, { value: 80, color: "#cf4d4d", label: "High" }] };
      resource.layout = { ...resource.layout, x: 6, w: 6 };
      dashboard.widgets.find(widget => widget.id === "node-cpu").layout = { x: 0, y: 3, w: 6, h: 6 };
      dashboard.variables.push({ name: "node", label: "Node", defaultValue: "node-01", options: Array.from({ length: 8 }, (_, i) => `node-${String(i + 1).padStart(2, "0")}`) });
      resource.selectionBindings = [{ variable: "node", source: "label", value: "node" }];
      const multiple = dashboard.widgets.find(widget => widget.id === "cpu-meter");
      const source = dashboard.widgets.find(widget => widget.id === "node-cpu");
      Object.assign(multiple, { title: "CPU by node · aligned histories", pluginId: "small-multiples", providerId: source.providerId, query: source.query, queryRef: structuredClone(source.queryRef), unit: "%", config: { columns: 4, maxSeries: 8, maxPoints: 120 }, layout: { x: 0, y: 14, w: 12, h: 5 }, options: { decimals: 1, showGrid: true, showTooltip: true, min: 0, max: 100 } });
      const nodeHistory = '100 * paprika_demo_node_cpu_ratio{cluster={{cluster}},node={{node}}}';
      const nodeDetail = JSON.stringify({ sql: "SELECT node, namespace, cores, round((memory_ratio*100)::numeric,1)::double precision AS memory_percent, round((disk_used_ratio*100)::numeric,1)::double precision AS disk_percent FROM gallery.nodes n WHERE to_jsonb(n)->>'cluster'=$1 AND node=$2", parameters: ["__CLUSTER__", "__NODE__"] }).replace('"__CLUSTER__"', '{{cluster}}').replace('"__NODE__"', '{{node}}');
      const nodeParameters = [{ name: "cluster", label: "Cluster", type: "string", defaultValue: "omega" }, { name: "node", label: "Node", type: "string", defaultValue: "node-01" }];
      const nodeBindings = nodeParameters.map(({ name }) => ({ parameter: name, source: "variable", variable: name }));
      savedQueries.push({ schemaVersion: 1, id: "local-linked-node-history", name: "Selected node CPU", kind: "metrics", providerId: providers.metrics, query: nodeHistory, parameters: nodeParameters },
        { schemaVersion: 1, id: "local-linked-node-detail", name: "Selected node details", kind: "records", providerId: providers.records, query: nodeDetail, parameters: nodeParameters });
      dashboard.widgets.push({ id: "selected-node-history", title: "Selected node · CPU", type: "timeseries", providerId: providers.metrics, query: nodeHistory, unit: "%", queryRef: { id: "local-linked-node-history", bindings: nodeBindings }, options: { decimals: 1, showGrid: true, showTooltip: true, min: 0, max: 100 }, layout: { x: 0, y: 19, w: 8, h: 4 } },
        { id: "selected-node-detail", title: "Selected node · resources", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: nodeDetail, unit: "%", queryRef: { id: "local-linked-node-detail", bindings: nodeBindings }, config: { columns: ["node", "namespace", "cores", "memory_percent", "disk_percent"], showSearch: false }, layout: { x: 8, y: 19, w: 4, h: 4 } });
    }
    if (key === "market-lens") {
      dashboard.description = "Synthetic local provider data. Sector filters the summary and company table; composition and sector trends show all sectors. Company details, ranks and composition are seed-time snapshots; history charts and sparklines use the selected time range. Composition shows the four largest companies per sector.";
      const compositionQuery = JSON.stringify({ sql: "SELECT c.symbol AS ticker, c.name AS company, c.sector, (c.market_cap/1000000000.0)::double precision AS market_cap, c.short_percent AS short_interest FROM gallery.companies c WHERE c.symbol IN (SELECT x.symbol FROM gallery.companies x WHERE x.sector=c.sector ORDER BY x.market_cap DESC LIMIT 4) ORDER BY c.sector, c.market_cap DESC", parameters: [] });
      const sectorHistoryQuery = JSON.stringify({ sql: "SELECT h.observed_at AS day, c.sector, avg(h.value)::double precision AS short_interest FROM gallery.company_history h JOIN gallery.companies c ON c.symbol=h.symbol WHERE h.observed_at >= $1::timestamptz AND h.observed_at <= $2::timestamptz GROUP BY h.observed_at,c.sector ORDER BY h.observed_at,c.sector", parameters: [{ range: "start" }, { range: "end" }] });
      const companyHistoryQuery = sqlRange("SELECT observed_at AS day, value AS short_interest FROM gallery.company_history WHERE symbol=$1 AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz ORDER BY observed_at", "company");
      const companyParameter = { name: "company", label: "Company", type: "string", defaultValue: "DEMO001" };
      savedQueries.push(
        { schemaVersion: 1, id: "local-market-composition", name: "Company composition across sectors", kind: "records", providerId: providers.records, query: compositionQuery, parameters: [] },
        { schemaVersion: 1, id: "local-market-sector-history", name: "Short interest by sector", kind: "records", providerId: providers.records, query: sectorHistoryQuery, parameters: [] },
        { schemaVersion: 1, id: "local-market-company-history", name: "Selected company history", kind: "records", providerId: providers.records, query: companyHistoryQuery, parameters: [companyParameter] },
      );
      const composition = dashboard.widgets.find(widget => widget.id === "composition");
      Object.assign(composition, { query: compositionQuery, queryRef: { id: "local-market-composition", bindings: [] }, config: { ...composition.config, group: "sector", colorField: "short_interest" } });
      dashboard.widgets.find(widget => widget.id === "rankings").description = "Seed-time company snapshot. Sparklines show up to the latest 240 observations in the selected range.";
      dashboard.widgets.find(widget => widget.id === "rankings").config = { columns: ["ticker", "company", "short_interest", "history"], pageSize: 10, density: "compact", showSearch: false, cellStyles: [{ column: "history", display: "sparkline", unit: "%" }] };
      const history = dashboard.widgets.find(widget => widget.id === "history");
      Object.assign(history, { title: "Short interest by sector · recent history", query: sectorHistoryQuery, queryRef: { id: "local-market-sector-history", bindings: [] }, config: { x: "day", y: ["short_interest"], group: "sector" } });
      dashboard.variables.push({ name: "company", label: "Company", defaultValue: "DEMO001" });
      for (const id of ["composition", "rankings"]) {
        dashboard.widgets.find(widget => widget.id === id).selectionBindings = [{ variable: "company", source: "label", value: "ticker" }];
      }
      const detailQuery = JSON.stringify({
        sql: "SELECT symbol AS ticker, name AS company, concat('Sector: ', sector, ' · Short interest: ', short_percent::text, '%') AS detail FROM gallery.companies WHERE symbol=$1",
        parameters: ["__COMPANY__"],
      }).replace('"__COMPANY__"', '{{company}}');
      savedQueries.push({ schemaVersion: 1, id: "local-market-company-detail", name: "Selected company details", kind: "records", providerId: providers.records, query: detailQuery,
        description: "Synthetic company details selected from the treemap or table.",
        parameters: [companyParameter] });
      dashboard.widgets.push({ ...structuredClone(dashboard.widgets.find(widget => widget.id === "rankings")), id: "selected-company", title: "Selected company", pluginId: "record-list", query: detailQuery,
        queryRef: { id: "local-market-company-detail", bindings: [{ parameter: "company", source: "variable", variable: "company" }] },
        selectionBindings: undefined, config: { title: "company", subtitle: "ticker", body: "detail" }, layout: { x: 0, y: 14, w: 12, h: 3 } });
      dashboard.widgets.push({ ...structuredClone(history), id: "selected-company-history", title: "Selected company · short interest history", query: companyHistoryQuery, queryRef: { id: "local-market-company-history", bindings: [{ parameter: "company", source: "variable", variable: "company" }] }, config: { x: "day", y: ["short_interest"] }, layout: { x: 0, y: 17, w: 12, h: 4 } });
    }
    if (key === "edge-watch") {
      const geo = q[key]["geo-events"];
      const parameter = { name: "gateway", label: "Gateway", type: "string", defaultValue: "omega" };
      const binding = [{ parameter: "gateway", source: "variable", variable: "gateway" }];
      const destinationQuery = sql("SELECT destination, traffic_mbps AS traffic, round((100*traffic_mbps / NULLIF(sum(traffic_mbps) OVER (),0))::numeric,2)::double precision AS percent FROM gallery.edge_destinations d WHERE to_jsonb(d)->>'cluster'=$1 ORDER BY traffic_mbps DESC", "gateway");
      const blockedQuery = sqlRange("SELECT occurred_at AS time, source, destination, rule, count, status FROM gallery.edge_blocked_requests e WHERE to_jsonb(e)->>'cluster'=$1 AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz ORDER BY occurred_at DESC", "gateway");
      savedQueries.push({ schemaVersion: 1, id: "local-edge-destinations", name: "Ranked destination traffic", kind: "records", providerId: providers.records, query: destinationQuery, parameters: [parameter] },
        { schemaVersion: 1, id: "local-edge-blocked-requests", name: "Recent blocked requests", kind: "records", providerId: providers.records, query: blockedQuery, parameters: [parameter] });
      const destinations = dashboard.widgets.find(widget => widget.id === "destinations");
      Object.assign(destinations, { title: "Top destinations", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: destinationQuery,
        queryRef: { id: "local-edge-destinations", bindings: binding }, config: { columns: ["destination", "traffic", "percent"], pageSize: 10, density: "compact", showSearch: false, showRowNumbers: true, cellStyles: [{ column: "traffic", display: "bar", min: 0, max: 500, unit: "Mb/s" }, { column: "percent", display: "color-text", unit: "%" }] }, color: "#00c8e0" });
      dashboard.widgets.find(widget => widget.id === "flow").config.seriesColors = [{ label: "direction", value: "inbound", color: "#00cee2" }, { label: "direction", value: "outbound", color: "#a879ef" }];
      dashboard.widgets.find(widget => widget.id === "flow").config.symmetricAxis = true;
      dashboard.widgets.find(widget => widget.id === "outcomes").config.seriesColors = [{ label: "outcome", value: "allowed", color: "#00cee2" }, { label: "outcome", value: "challenged", color: "#ffb128" }, { label: "outcome", value: "blocked", color: "#f4523c" }];
      const risks = dashboard.widgets.find(widget => widget.id === "risks");
      risks.title = "Risk by source";
      risks.description = "Seed-time source risk snapshot. Trends show up to the latest 240 observations in the selected range.";
      risks.config = { columns: ["source", "country", "trend", "risk", "status"], pageSize: 5, density: "compact", showSearch: false, showRowNumbers: true, cellStyles: [{ column: "trend", display: "sparkline", thresholdColumn: "risk" }, { column: "risk", display: "bar-segments", min: 0, max: 100, segments: 6, barColorMode: "value" }, { column: "status", display: "status-badge", mappings: [{ value: "Blocking", color: "#ef5a46" }, { value: "Challenging", color: "#f4b333" }, { value: "Monitoring", color: "#7992a1" }, { value: "Allowed", color: "#13c8a1" }] }] };
      risks.options = { ...risks.options, thresholds: [{ value: 0, color: "#13c8a1", label: "Low" }, { value: 40, color: "#f4b333", label: "Elevated" }, { value: 70, color: "#ef5a46", label: "High" }] };
      // The Edge reference uses a compact traffic row above a shallower
      // geography/outcomes/risk row. Keep the authored grid heights matched
      // across each row; the responsive projection still stacks them on mobile.
      for (const id of ["flow", "destinations"]) dashboard.widgets.find(widget => widget.id === id).layout.h = 5;
      for (const id of ["locations", "outcomes", "risks"]) dashboard.widgets.find(widget => widget.id === id).layout.h = 4;
      const map = dashboard.widgets.find(widget => widget.id === "locations");
      map.title = "Connection geography";
      map.config = { latitude: "latitude", longitude: "longitude", label: "label", value: "value", display: "density", showLocations: false, maxPoints: 500 };
      map.selectionBindings = [{ variable: "location", source: "label", value: "label" }];
      map.options = { ...map.options, thresholds: [{ value: 0, color: "#00cee2", label: "Low" }, { value: 250, color: "#ffb128", label: "Medium" }, { value: 400, color: "#f4523c", label: "High" }] };
      for (const [id, icon, color] of [["ingress","arrow-down","#00cde7"],["egress","arrow-up","#a77ef0"],["blocked","shield","#ef554a"],["connections","network","#f2ae30"]]) {
        const stat = dashboard.widgets.find(widget => widget.id === id);
        stat.color = color; stat.options = { ...stat.options, sparklinePlacement: "side", statIcon: icon };
      }
      dashboard.widgets.push({ id: "blocked-requests", title: "Recent blocked requests", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: blockedQuery, unit: "", queryRef: { id: "local-edge-blocked-requests", bindings: binding }, config: { columns: ["time", "source", "destination", "rule", "count", "status"], pageSize: 5, density: "compact", showSearch: false, cellStyles: [{ column: "status", display: "status-badge", mappings: [{ value: "Blocked", color: "#ef5a46" }] }] }, layout: { x: 0, y: 14, w: 12, h: 4 } });
      const edgeEvents = sqlRange("SELECT occurred_at AS date, label, severity AS status FROM gallery.edge_events e WHERE to_jsonb(e)->>'cluster'=$1 AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz ORDER BY occurred_at DESC", "gateway");
      savedQueries.push({ schemaVersion: 1, id: "local-edge-gateway-events", name: "Gateway events", kind: "records", providerId: providers.records, query: edgeEvents,
        description: "Synthetic gateway events for directional traffic annotations.", parameters: [{ name: "gateway", label: "Cluster", type: "string", defaultValue: "omega" }] });
      dashboard.widgets.find(widget => widget.id === "flow").annotationSource = { queryRef: { id: "local-edge-gateway-events", bindings: [{ parameter: "gateway", source: "variable", variable: "gateway" }] }, timestampColumn: "date", labelColumn: "label", severityColumn: "status" };
      savedQueries.push({ schemaVersion: 1, id: "local-edge-geo-events", name: "Edge geographic sample", kind: "records", providerId: providers.records, query: geo,
        description: "Synthetic geographic observations and request counts near named cities and regions.", parameters: [{ name: "gateway", label: "Cluster", type: "string", defaultValue: "omega" }] });
      dashboard.variables.push({ name: "location", label: "Location", defaultValue: "Melbourne sample 1" });
      const locationQuery = JSON.stringify({ sql: "SELECT label, latitude, longitude, requests, status FROM gallery.geo_events e WHERE to_jsonb(e)->>'cluster'=$1 AND label=$2 UNION ALL SELECT label, latitude, longitude, requests, status FROM gallery.geo_global_events g WHERE to_jsonb(g)->>'cluster'=$1 AND label=$2", parameters: ["__GATEWAY__", "__LOCATION__"] }).replace('"__GATEWAY__"', '{{gateway}}').replace('"__LOCATION__"', '{{location}}');
      savedQueries.push({ schemaVersion: 1, id: "local-edge-location-detail", name: "Selected geographic observation", kind: "records", providerId: providers.records, query: locationQuery,
        description: "Synthetic location details bound to the selected honeycomb record.", parameters: [{ name: "gateway", label: "Cluster", type: "string", defaultValue: "omega" }, { name: "location", label: "Location", type: "string", defaultValue: "Melbourne sample 1" }] });
      const base = { type: "plugin", pluginId: "geo-heatmap", dataKind: "records", providerId: providers.records, query: geo, unit: "requests",
        queryRef: { id: "local-edge-geo-events", bindings: [{ parameter: "gateway", source: "variable", variable: "gateway" }] }, options: { decimals: 0, showTooltip: true, showLegend: true } };
      dashboard.widgets.push({ ...structuredClone(base), id: "geo-density", title: "Request density · geographic hexes", config: { mode: "map", latitude: "latitude", longitude: "longitude", label: "label", value: "requests", aggregation: "sum", radius: 18, maxRecords: 500 }, layout: { x: 0, y: 18, w: 7, h: 6 } },
        { ...structuredClone(base), id: "geo-honeycomb", title: "Source requests · honeycomb", config: { mode: "grid", latitude: "latitude", longitude: "longitude", label: "label", value: "requests", aggregation: "mean", radius: 18, maxRecords: 500 },
          selectionBindings: [{ variable: "location", source: "label", value: "label" }],
          options: { ...base.options, tooltipView: { type: "plugin", pluginId: "record-table", dataKind: "records", title: "Recorded location", height: 160, config: { columns: ["label", "requests", "status"], pageSize: 5, showSearch: false }, source: { type: "saved", ref: { id: "local-edge-location-detail", bindings: [{ parameter: "gateway", source: "variable", variable: "gateway" }, { parameter: "location", source: "label", label: "label" }] } } } }, layout: { x: 7, y: 18, w: 5, h: 6 } },
        { type: "plugin", pluginId: "record-table", dataKind: "records", id: "geo-selected-detail", title: "Selected location · recorded detail", providerId: providers.records, query: locationQuery, unit: "", config: { columns: ["label", "latitude", "longitude", "requests", "status"], pageSize: 5, showSearch: false },
          queryRef: { id: "local-edge-location-detail", bindings: [{ parameter: "gateway", source: "variable", variable: "gateway" }, { parameter: "location", source: "variable", variable: "location" }] }, layout: { x: 0, y: 24, w: 12, h: 3 } });
    }
    if (key === "reliability-room") {
      // The selected request series can be checkout, payments, catalog or
      // worker; all four have synthetic metric and trace samples.
      dashboard.variables[0].options = ["checkout", "payments", "catalog", "worker"];
      dashboard.widgets = dashboard.widgets.filter(widget => widget.id !== "incidents" && widget.id !== "budget-meter");
      for (const [id, icon, color] of [["availability","shield","#12cbae"],["target","target","#309cfa"],["budget","pie","#f2b236"]]) {
        const widget = dashboard.widgets.find(item => item.id === id);
        widget.layout = { ...widget.layout, x: id === "availability" ? 0 : id === "target" ? 4 : 8, w: 4 };
        widget.color = color; widget.options = { ...widget.options, sparklinePlacement: "side", statIcon: icon };
      }
      dashboard.widgets.find(widget => widget.id === "availability").title = "Observed availability · 30d";
      dashboard.widgets.find(widget => widget.id === "target").title = "Target (SLO)";
      const budgetCard = dashboard.widgets.find(widget => widget.id === "budget");
      budgetCard.title = "Budget remaining · 30d";
      budgetCard.options = { ...budgetCard.options, showStatBar: true, min: 0, max: 100, thresholds: [{ value: 0, color: "#e8554e", label: "At risk" }, { value: 25, color: "#f2b236", label: "Warning" }, { value: 75, color: "#20cba3", label: "Healthy" }] };
      dashboard.widgets.find(widget => widget.id === "target").options.showSparkline = true;
      const events = sqlRange("SELECT started_at AS date, least(coalesce(ended_at,$3::timestamptz),$3::timestamptz) AS ended_at, summary AS label, severity AS status FROM gallery.incidents i WHERE service=$1 AND to_jsonb(i)->>'cluster'='omega' AND started_at<=$3::timestamptz AND (ended_at IS NULL OR ended_at>=$2::timestamptz) ORDER BY started_at DESC", "service");
      const incidentSeverity = sqlRange("SELECT started_at AS date, summary AS label, severity AS status, CASE severity WHEN 'warning' THEN 1.0 WHEN 'critical' THEN 2.0 ELSE NULL END::double precision AS value FROM gallery.incidents i WHERE service=$1 AND to_jsonb(i)->>'cluster'='omega' AND started_at>=$2::timestamptz AND started_at<=$3::timestamptz UNION ALL SELECT started_at AS date, summary AS label, severity AS status, NULL::double precision AS value FROM gallery.incident_severity_samples s WHERE service=$1 AND to_jsonb(s)->>'cluster'='omega' AND started_at>=$2::timestamptz AND started_at<=$3::timestamptz ORDER BY date DESC", "service");
      const timeline = 'min_over_time(paprika_demo_probe_up{cluster="omega"}[3h])';
      const attention = JSON.stringify({ sql: `SELECT service, round((100.0*sum(CASE WHEN up THEN 1 ELSE 0 END)/count(*))::numeric,2)::double precision AS availability, round((100*greatest(0, 1 - (1.0-sum(CASE WHEN up THEN 1 ELSE 0 END)::double precision/count(*))/0.001))::numeric,1)::double precision AS budget, CASE WHEN 1.0-sum(CASE WHEN up THEN 1 ELSE 0 END)::double precision/count(*) > 0.001 THEN 'At risk' ELSE 'Healthy' END AS status FROM gallery.service_probe_samples WHERE observed_at >= $1::timestamptz AND observed_at <= $2::timestamptz GROUP BY service ORDER BY availability`, parameters: [{ range: "start" }, { range: "end" }] });
      savedQueries.push({ schemaVersion: 1, id: "local-reliability-events", name: "Service incident intervals", kind: "records", providerId: providers.records, query: events, parameters: [{ name: "service", label: "Service", type: "string", defaultValue: "checkout" }] },
        { schemaVersion: 1, id: "local-reliability-severity", name: "Service incident severity", kind: "records", providerId: providers.records, query: incidentSeverity, description: "Synthetic incident severity ranks: warning=1, critical=2; unknown status remains missing.", parameters: [{ name: "service", label: "Service", type: "string", defaultValue: "checkout" }] },
        { schemaVersion: 1, id: "local-reliability-timeline", name: "Observed service states", kind: "metrics", providerId: providers.metrics, query: timeline, parameters: [] },
        { schemaVersion: 1, id: "local-reliability-attention", name: "Observed service availability summary", kind: "records", providerId: providers.records, query: attention, parameters: [] });
      const burn = dashboard.widgets.find(widget => widget.id === "burn");
      burn.title = "Availability burn rate · request errors";
      burn.options = { ...burn.options, seriesColors: [{ label: "window", value: "1h", color: "#348cf0" }, { label: "window", value: "6h", color: "#15c7a1" }] };
      burn.annotationSource = { queryRef: { id: "local-reliability-events", bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, timestampColumn: "date", endColumn: "ended_at", labelColumn: "label", severityColumn: "status" };
      dashboard.widgets.push({ id: "services-attention", title: "Services needing attention · recorded probes", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: attention, unit: "", queryRef: { id: "local-reliability-attention", bindings: [] }, config: { columns: ["service", "availability", "budget", "status"], pageSize: 6, density: "compact", showSearch: false, cellStyles: [{ column: "availability", display: "color-text", unit: "%" }, { column: "budget", display: "bar", min: 0, max: 100, unit: "%", barColorMode: "value" }, { column: "status", display: "status-badge", mappings: [{ value: "At risk", color: "#e8554e" }, { value: "Healthy", color: "#20cba3" }] }] }, options: { thresholds: [{ value: 0, color: "#e8554e", label: "At risk" }, { value: 25, color: "#eab640", label: "Warning" }, { value: 50, color: "#20cba3", label: "Healthy" }] }, layout: { x: 8, y: 3, w: 4, h: 6 } },
        { id: "service-timeline", title: "Service state · worst recorded probe per 3h", type: "plugin", pluginId: "status-history", dataKind: "metrics", providerId: providers.metrics, query: timeline, unit: "", queryRef: { id: "local-reliability-timeline", bindings: [] }, config: { labelField: "service", showTimeAxis: true, segmented: true, maxSeries: 6, maxPoints: 120 }, options: { showLegend: true, showTooltip: true, thresholds: [{ value: 0, color: "#e6504d", label: "Down" }, { value: 1, color: "#26c285", label: "Up" }] }, layout: { x: 0, y: 9, w: 8, h: 5 } });
      const calendar = dashboard.widgets.find(widget => widget.id === "calendar"); delete calendar.config.endDate;
      Object.assign(calendar, { title: "Incident severity by day · UTC", query: incidentSeverity, unit: "", queryRef: { id: "local-reliability-severity", bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, config: { ...calendar.config, value: "value", status: "status", label: "label", aggregation: "max", colorMode: "thresholds" }, options: { ...calendar.options, thresholds: [{ value: 1, color: "#eab640", label: "Warning" }, { value: 2, color: "#e8554e", label: "Critical" }] }, layout: { x: 8, y: 9, w: 4, h: 5 } });
      const incidentsList = dashboard.widgets.find(widget => widget.id === "incidents-list");
      incidentsList.title = "Recent incidents"; incidentsList.layout = { x: 0, y: 14, w: 12, h: 4 };
      incidentsList.config = { ...incidentsList.config, columns: ["date", "service", "label", "value", "state"], timeSelection: { start: "date", duration: "value", durationUnit: "minutes", paddingSeconds: 300 } };
      const serviceTrace = dashboards.find(item => item.id === "local-gallery-service-pulse").widgets.find(item => item.id === "traces");
      dashboard.widgets.push({ ...structuredClone(serviceTrace), id: "incident-traces", title: "Traces in selected window", layout: { x: 0, y: 18, w: 12, h: 6 } });
      dashboard.description += " Availability and budget describe recorded synthetic 30-day probe samples against a 99.9% target; burn rates describe request errors. The table is a separately seeded synthetic probe set.";
    }
    if (key === "collection-control") {
      // Each signal is an independent observed rate. Overlay the series
      // instead of stacking them, so every line and tooltip retains its value.
      const throughput = dashboard.widgets.find(widget => widget.id === "throughput");
      throughput.type = "timeseries";
      delete throughput.pluginId;
      delete throughput.dataKind;
      delete throughput.config;
      throughput.options = { ...throughput.options, display: "area", showLegend: true, showTooltip: true, seriesColors: [
        { label: "signal", value: "metrics", color: "#348cf0" },
        { label: "signal", value: "traces", color: "#8a7bf6" },
        { label: "signal", value: "logs", color: "#16c9c6" },
      ] };
      const freshness = dashboard.widgets.find(widget => widget.id === "source-freshness");
      // This demo's five-row gauge needs less height than the original bar
      // composition. Change only newly generated demo documents, not saved views.
      freshness.layout = { ...freshness.layout, h: 5 };
      Object.assign(freshness, { title: "Freshness by source", type: "plugin", pluginId: "threshold-gauge", dataKind: "metrics", config: { display: "linear", orientation: "horizontal", seriesMode: "all", maxSeries: 5, showThresholds: true, showStatus: true }, options: { min: 0, max: 60, decimals: 2, showLegend: true, showTooltip: true, thresholds: [{ value: 0, color: "#12cba1", label: "OK" }, { value: 30, color: "#f1b841", label: "Delayed" }, { value: 60, color: "#e95352", label: "Critical" }] } });
      const states = dashboard.widgets.find(widget => widget.id === "job-states");
      states.title = "Job execution history · sampled states";
      states.config = { ...states.config, maxSeries: 6, labelField: "task", showTimeAxis: true };
      states.options = { ...states.options, thresholds: [{ value: 0, color: "#e95352", label: "Failed" }, { value: 1, color: "#8a7bf6", label: "Running" }, { value: 2, color: "#12cba1", label: "Complete" }] };
      dashboard.description += " Job execution states are synthetic sampled metrics; recent job records are seeded independently.";
      const failures = dashboard.widgets.find(widget => widget.id === "failures");
      failures.title = "Recent failed or retrying jobs";
      failures.config = { columns: ["started", "source", "pipeline", "duration_s", "message", "status"], density: "compact", showSearch: false, pageSize: 5, cellStyles: [{ column: "status", display: "status-badge", mappings: [{ value: "Failed", color: "#e95352" }, { value: "Retrying", color: "#f1b841" }] }] };
      dashboard.variables.push({ name: "source", label: "Source", defaultValue: "prometheus", options: ["prometheus", "tempo", "shorted-api", "brandbrain", "market-sync"] });
      const sourceList = sql("SELECT source,state AS status,freshness_seconds,rows_processed FROM gallery.sources s WHERE to_jsonb(s)->>'cluster'=$1 ORDER BY source", "pipeline");
      const sourceHistory = 'paprika_demo_source_freshness_seconds{cluster={{pipeline}},source={{source}}}';
      const sourceDetail = JSON.stringify({ sql: "SELECT source,state AS status,freshness_seconds,rows_processed FROM gallery.sources s WHERE to_jsonb(s)->>'cluster'=$1 AND source=$2", parameters: ["__PIPELINE__", "__SOURCE__"] }).replace('"__PIPELINE__"', '{{pipeline}}').replace('"__SOURCE__"', '{{source}}');
      const pipelineParameter = { name: "pipeline", label: "Cluster", type: "string", defaultValue: "omega" };
      const sourceParameters = [pipelineParameter, { name: "source", label: "Source", type: "string", defaultValue: "prometheus" }];
      const sourceBindings = sourceParameters.map(({ name }) => ({ parameter: name, source: "variable", variable: name }));
      savedQueries.push({ schemaVersion: 1, id: "local-linked-sources", name: "Collection sources", kind: "records", providerId: providers.records, query: sourceList, parameters: [pipelineParameter] },
        { schemaVersion: 1, id: "local-linked-source-history", name: "Selected source freshness", kind: "metrics", providerId: providers.metrics, query: sourceHistory, parameters: sourceParameters },
        { schemaVersion: 1, id: "local-linked-source-detail", name: "Selected source details", kind: "records", providerId: providers.records, query: sourceDetail, parameters: sourceParameters });
      dashboard.widgets.push({ id: "sources-table", title: "Collection sources · select a row", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: sourceList, unit: "", queryRef: { id: "local-linked-sources", bindings: [{ parameter: "pipeline", source: "variable", variable: "pipeline" }] }, config: { columns: ["source", "status", "freshness_seconds", "rows_processed"], pageSize: 5, showSearch: false }, selectionBindings: [{ variable: "source", source: "label", value: "source" }], layout: { x: 0, y: 18, w: 5, h: 5 } },
        { id: "selected-source-history", title: "Selected source · freshness", type: "timeseries", providerId: providers.metrics, query: sourceHistory, unit: "s", queryRef: { id: "local-linked-source-history", bindings: sourceBindings }, options: { decimals: 1, showGrid: true, showTooltip: true }, layout: { x: 5, y: 18, w: 7, h: 5 } },
        { id: "selected-source-detail", title: "Selected source · details", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: sourceDetail, unit: "", queryRef: { id: "local-linked-source-detail", bindings: sourceBindings }, config: { columns: ["source", "status", "freshness_seconds", "rows_processed"], showSearch: false }, layout: { x: 0, y: 23, w: 12, h: 3 } });
    }
    // Reference studies use a compact top row without leaving an empty grid
    // track between the KPIs and the first chart.
    for (const widget of dashboard.widgets) {
      if (widget.type === "stat" && widget.layout.y === 0 && widget.layout.h === 3) widget.layout.h = 1;
      else if (widget.layout.y > 0) widget.layout.y -= 2;
    }
    dashboards.push(dashboard);
  }
  const service = dashboards.find(dashboard => dashboard.id === "local-gallery-service-pulse");
  const kit = structuredClone(service); kit.id = "local-gallery-signal-kit"; kit.title = "Signal Kit · Local demo";
  kit.description = "Synthetic component study. The no-observations, historical gap and invalid-query cards deliberately demonstrate empty, old returned samples and failed provider responses.";
  kit.variables.push({ name: "cluster", label: "Cluster", defaultValue: "omega", options: ["omega", "delta"] });
  const fleet = dashboards.find(dashboard => dashboard.id === "local-gallery-fleet-atlas");
  const selectedRate = 'sum by (cluster, service) (rate(paprika_demo_requests_total{cluster={{cluster}},service={{service}}}[5m])) or sum by (cluster, service) (rate(paprika_demo_requests_total{cluster={{cluster}},service="worker"}[5m]))';
  const emptyQuery = 'paprika_demo_intentionally_missing_metric{service="signal-kit"}';
  const invalidQuery = 'rate(';
  // Keep the sample gap relative to the selected range, rather than the time
  // the demo was seeded. The provider continues to be scraped normally: this
  // intentionally filters returned samples and does not imply source failure.
  const oldMetric = 'paprika_demo_source_freshness_seconds{cluster={{cluster}},source="tempo"}';
  const oldSamplesQuery = `${oldMetric} and on(cluster,source) ((timestamp(${oldMetric} @ end()) - time()) > 600)`;
  const nodeRatios = 'paprika_demo_node_cpu_ratio{cluster={{cluster}}}';
  const scopedTraces = '{ resource.service.name = {{service}} && resource.cluster = {{cluster}} }';
  const serviceParam = { name: "service", label: "Service", type: "string", defaultValue: "checkout" };
  const clusterParam = { name: "cluster", label: "Cluster", type: "string", defaultValue: "omega" };
  const serviceClusterBindings = ["service", "cluster"].map(variable => ({ parameter: variable, source: "variable", variable }));
  savedQueries.push({ schemaVersion: 1, id: "local-signal-rate", name: "Signal Kit request rates", kind: "metrics", providerId: providers.metrics, query: selectedRate,
    description: "Synthetic selected-service and worker request histories for the selected cluster.", parameters: [serviceParam, clusterParam] },
    { schemaVersion: 1, id: "local-signal-empty", name: "Signal Kit no observations", kind: "metrics", providerId: providers.metrics, query: emptyQuery,
      description: "Intentionally absent synthetic metric for demonstrating a genuine empty result.", parameters: [] },
    { schemaVersion: 1, id: "local-signal-error", name: "Signal Kit expected query error", kind: "metrics", providerId: providers.metrics, query: invalidQuery,
      description: "Intentionally invalid PromQL for demonstrating a genuine provider error.", parameters: [] },
    { schemaVersion: 1, id: "local-signal-old-samples", name: "Signal Kit historical sample gap", kind: "metrics", providerId: providers.metrics, query: oldSamplesQuery,
      description: "Synthetic history intentionally filtered to stop ten minutes before this demo started. This does not indicate provider health.", parameters: [clusterParam] },
    { schemaVersion: 1, id: "local-signal-node-ratios", name: "Signal Kit node CPU ratios", kind: "metrics", providerId: providers.metrics, query: nodeRatios,
      description: "Synthetic per-node CPU ratios for the selected cluster. Their relative shares are not cluster CPU core consumption.", parameters: [clusterParam] },
    { schemaVersion: 1, id: "local-signal-cluster-traces", name: "Signal Kit service traces", kind: "traces", providerId: providers.traces, query: scopedTraces,
      description: "Synthetic multi-span traces for the selected service and cluster, including failed requests.", parameters: [serviceParam, clusterParam] });
  const rate = structuredClone(service.widgets.find(widget => widget.id === "request-history"));
  Object.assign(rate, { title: "Request rate · selected service and worker", type: "timeseries", query: selectedRate,
    queryRef: { id: "local-signal-rate", bindings: serviceClusterBindings },
    options: { ...rate.options, display: "area", showLegend: true, showTooltip: true, seriesColors: [{ label: "service", value: "checkout", color: "#348cf0" }, { label: "service", value: "payments", color: "#348cf0" }, { label: "service", value: "worker", color: "#16bca6" }] },
    layout: { x: 0, y: 0, w: 12, h: 6 } });
  // Service Pulse's detail query and destination are scoped to omega. This
  // board has its own cluster selector, so do not inherit those bindings.
  delete rate.options.tooltipView; delete rate.drilldowns;
  delete rate.pluginId; delete rate.dataKind; delete rate.config;
  const latency = structuredClone(service.widgets.find(widget => widget.id === "latency"));
  Object.assign(latency, { title: "p95 latency", color: "#348cf0", options: { ...latency.options, showSparkline: true, sparklinePlacement: "background", statIcon: "activity" }, layout: { x: 0, y: 6, w: 6, h: 3 } });
  const memory = structuredClone(fleet.widgets.find(widget => widget.id === "disk-meter"));
  const fleetMemory = fleet.widgets.find(widget => widget.id === "memory");
  Object.assign(memory, { id: "memory-meter", title: "Memory used", providerId: fleetMemory.providerId, query: fleetMemory.query,
    queryRef: structuredClone(fleetMemory.queryRef), config: { display: "linear", orientation: "horizontal", label: "Memory used", showThresholds: true },
    options: { ...memory.options, min: 0, max: 100, showTooltip: true, thresholds: [{ value: 0, color: "#16bca6", label: "Within capacity" }, { value: 70, color: "#f0b13c", label: "Elevated" }, { value: 85, color: "#ec5a52", label: "Near limit" }] }, layout: { x: 6, y: 6, w: 6, h: 3 } });
  const empty = { id: "expected-empty", title: "No observations · expected", type: "stat", providerId: providers.metrics, query: emptyQuery, unit: "", queryRef: { id: "local-signal-empty", bindings: [] }, layout: { x: 0, y: 9, w: 4, h: 3 } };
  const oldSamples = { id: "expected-stale", title: "Old returned samples · expected", description: "Synthetic query filters out recent samples.", type: "stat", providerId: providers.metrics, query: oldSamplesQuery, unit: "s", color: "#d95050", options: { showSparkline: true, staleAfterSeconds: 300 }, queryRef: { id: "local-signal-old-samples", bindings: [{ parameter: "cluster", source: "variable", variable: "cluster" }] }, layout: { x: 4, y: 9, w: 4, h: 3 } };
  const error = { id: "expected-error", title: "Query error · expected", type: "stat", providerId: providers.metrics, query: invalidQuery, unit: "", queryRef: { id: "local-signal-error", bindings: [] }, layout: { x: 8, y: 9, w: 4, h: 3 } };
  const states = structuredClone(service.widgets.find(widget => widget.id === "states")); states.layout = { x: 0, y: 12, w: 6, h: 5 };
  const distribution = structuredClone(service.widgets.find(widget => widget.id === "latency-distribution")); distribution.layout = { x: 6, y: 12, w: 6, h: 5 };
  distribution.config = { ...distribution.config, colorScale: "logarithmic" };
  distribution.description = "Synthetic request-duration bucket rates. Logarithmic color spreads positive densities between the smallest and largest observations in shown buckets, before time sampling; zero remains separate.";
  // Service Pulse intentionally shows omega. Signal Kit exposes a cluster
  // selector, so each cloned service query must use both selected variables.
  for (const widget of [latency, states, distribution]) {
    const original = savedQueries.find(item => item.id === widget.queryRef.id);
    const query = original.query.replaceAll('cluster="omega"', 'cluster={{cluster}}');
    const id = `local-signal-${widget.id}`;
    savedQueries.push({ ...structuredClone(original), id, name: `Signal Kit ${widget.title}`, query, parameters: [serviceParam, clusterParam] });
    widget.query = query;
    widget.queryRef = { id, bindings: serviceClusterBindings };
  }
  const incidentQuery = JSON.stringify({ sql: "SELECT started_at AS date,service,to_jsonb(i)->>'cluster' AS scope,summary AS label,(extract(epoch FROM (least(coalesce(ended_at,$4::timestamptz),$4::timestamptz)-started_at))/60.0)::double precision AS value,severity AS status,CASE WHEN ended_at IS NULL OR ended_at>$4::timestamptz THEN 'Active' ELSE 'Resolved' END AS state FROM gallery.incidents i WHERE service=$1 AND to_jsonb(i)->>'cluster'=$2 AND started_at<=$4::timestamptz AND (ended_at IS NULL OR ended_at>=$3::timestamptz) ORDER BY started_at DESC", parameters: ["__SERVICE__", "__CLUSTER__", { range: "start" }, { range: "end" }] }).replace('"__SERVICE__"', '{{service}}').replace('"__CLUSTER__"', '{{cluster}}');
  savedQueries.push({ schemaVersion: 1, id: "local-signal-incidents", name: "Signal Kit incidents", kind: "records", providerId: providers.records, query: incidentQuery, parameters: [serviceParam, clusterParam] });
  if (rate.annotationSource) rate.annotationSource.queryRef = { id: "local-signal-incidents", bindings: serviceClusterBindings };
  const nodeShares = { id: "node-ratio-shares", title: "Share of observed node CPU ratios", description: "Relative shares of synthetic node CPU ratios, not a measurement of CPU core consumption.", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: providers.metrics, query: nodeRatios, unit: "", queryRef: { id: "local-signal-node-ratios", bindings: [{ parameter: "cluster", source: "variable", variable: "cluster" }] }, config: { donut: true }, options: { showTooltip: true, showLegend: true, decimals: 2 }, layout: { x: 0, y: 17, w: 6, h: 5 } };
  const clusterTraces = { ...structuredClone(service.widgets.find(widget => widget.id === "traces")), id: "cluster-traces", title: "Service traces · selected cluster", description: "Synthetic multi-span traces include successful and failed requests.", query: scopedTraces, queryRef: { id: "local-signal-cluster-traces", bindings: serviceClusterBindings }, layout: { x: 6, y: 17, w: 6, h: 5 } };
  kit.widgets = [rate, latency, memory, empty, oldSamples, error, states, distribution, nodeShares, clusterTraces];
  dashboards.push(kit);
  // A dedicated longer-range lab keeps the availability examples legible
  // without compressing the short-window operational charts in Signal Kit.
  const availability = structuredClone(service);
  availability.id = "local-gallery-availability-lab";
  availability.title = "Availability Lab · Local demo";
  availability.description = "Synthetic recorded probe samples; missing observations do not imply uptime.";
  availability.timeRange = "7d";
  availability.variables = [{ name: "cluster", label: "Cluster", defaultValue: "omega", options: ["omega", "delta"] }, { name: "service", label: "Service", defaultValue: "checkout", options: ["checkout", "payments"] }];
  const clusterParameter = { name: "cluster", label: "Cluster", type: "string", defaultValue: "omega" };
  const serviceParameter = { name: "service", label: "Service", type: "string", defaultValue: "checkout" };
  const probes = 'paprika_demo_probe_up{cluster={{cluster}},service={{service}}}';
  const monitors = 'paprika_demo_monitor_up{cluster={{cluster}}}';
  savedQueries.push({ schemaVersion: 1, id: "local-availability-probes", name: "Recorded service probes", kind: "metrics", providerId: providers.metrics, query: probes, parameters: [clusterParameter, serviceParameter] },
    { schemaVersion: 1, id: "local-availability-monitors", name: "Current monitor states", kind: "metrics", providerId: providers.metrics, query: monitors, parameters: [clusterParameter] });
  const bindings = (names) => names.map(variable => ({ parameter: variable, source: "variable", variable }));
  const thresholds = [{ value: 0, color: "#e34b4b", label: "Down" }, { value: 1, color: "#36b96b", label: "Up" }];
  const base = { type: "plugin", providerId: providers.metrics, dataKind: "metrics", unit: "", options: { showTooltip: true, showLegend: true, thresholds } };
  availability.widgets = [
    { ...base, id: "monitor-grid", title: "Current status of monitors", pluginId: "status-grid", query: monitors, queryRef: { id: "local-availability-monitors", bindings: bindings(["cluster"]) }, config: { maxSeries: 200 }, layout: { x: 0, y: 0, w: 12, h: 4 } },
    { ...base, id: "uptime-calendar", title: "Observed service status · UTC calendar", pluginId: "uptime-calendar", query: probes, queryRef: { id: "local-availability-probes", bindings: bindings(["cluster", "service"]) }, config: { maxDays: 7, maxSeries: 1 }, layout: { x: 0, y: 4, w: 6, h: 4 } },
    { ...base, id: "uptime-timeline", title: "Observed service status · daily timeline", pluginId: "uptime-timeline", query: probes, queryRef: { id: "local-availability-probes", bindings: bindings(["cluster", "service"]) }, config: { maxDays: 7, maxSeries: 1 }, layout: { x: 6, y: 4, w: 6, h: 4 } },
  ];
  dashboards.push(availability);

  // An intentionally oversized provider-backed dataset makes truncation,
  // missing values and outliers observable while exercising real selection,
  // query and MCP paths. Limits are disclosed rather than presented as totals.
  const stressRecords = sql("SELECT id, observed_at, latency_ms, requests, state FROM gallery.stress_observations s WHERE to_jsonb(s)->>'cluster'=$1 ORDER BY id", "cluster");
  savedQueries.push({ schemaVersion: 1, id: "local-stress-records", name: "Stress observations", kind: "records", providerId: providers.records, query: stressRecords,
    description: "Synthetic 1,320-row cluster dataset with nulls, zeroes, outliers and states; provider responses are bounded.", parameters: [clusterParameter] });
  const stress = {
    schemaVersion: 1, id: "local-gallery-stress-lab", title: "Query Stress Lab · Local demo",
    description: "Synthetic high-cardinality metrics and 1,320 recorded rows per cluster. Partial-result notices are expected; counts describe the returned page, not the full source.",
    folder: "Local gallery demos", timeRange: "1h", refreshInterval: 0,
    variables: [{ name: "cluster", label: "Cluster", defaultValue: "omega", options: ["omega", "delta"] }, { name: "service", label: "Service", defaultValue: "checkout", options: ["checkout", "payments"] }],
    widgets: [
      { ...base, id: "stress-monitors", title: "High-cardinality monitor states", pluginId: "status-grid", query: monitors, queryRef: { id: "local-availability-monitors", bindings: bindings(["cluster"]) }, config: { maxSeries: 200 }, layout: { x: 0, y: 0, w: 12, h: 4 } },
      { id: "stress-records", title: "Recorded observations · nulls, zeroes and outliers", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: providers.records, query: stressRecords, unit: "", queryRef: { id: "local-stress-records", bindings: bindings(["cluster"]) }, config: { columns: ["id", "observed_at", "latency_ms", "requests", "state"], pageSize: 20, density: "compact", showSearch: true, cellStyles: [{ column: "latency_ms", display: "bar", min: 0, max: 500, unit: "ms" }] }, layout: { x: 0, y: 4, w: 8, h: 8 } },
      { ...structuredClone(service.widgets.find(widget => widget.id === "traces")), id: "stress-traces", title: "Service trace samples", layout: { x: 8, y: 4, w: 4, h: 8 } },
    ],
  };
  dashboards.push(stress);
  return { dashboards, savedQueries };
}

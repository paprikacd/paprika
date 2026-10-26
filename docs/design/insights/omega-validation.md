# Live Omega dashboard acceptance

`ui/e2e/insights-omega.e2e.mjs` exercises the deployed API, Insights store,
Observe MCP surface, provider discovery and real Prometheus/Tempo connectors.
It does not start mock telemetry, create providers, modify credentials, or
replace an existing saved query/dashboard. It creates a unique demonstration
workspace with conditional writes and retains those documents for inspection.

The script expects a private JSON configuration file supplied through
`INSIGHTS_OMEGA_CONFIG`. Keep this file and the two token files outside the
checkout. Do not commit tokens or copy token values into command arguments.

```json
{
  "baseURL": "https://paprika.benebsworth.com",
  "mcpURL": "https://paprika.benebsworth.com/observe/mcp",
  "tokenFile": "/private/path/console-token",
  "mcpTokenFile": "/private/path/observe-token",
  "metricProviderRef": "cuttlefish/cuttlefish-controlplane-release-prometheus",
  "traceProviderRef": "telesis/telesis-api-release-tempo",
  "metricTemplate": "sum by (service) (rate(process_cpu_seconds_total{service={{service}}}[5m])) * 100",
  "metricName": "process_cpu_seconds_total",
  "metricLabel": "service",
  "services": ["brandbrain", "telesis"],
  "unit": "% CPU",
  "traceQuery": "{ resource.service.name = \"uptime-api\" }",
  "rangeMinutes": 60,
  "title": "Omega service signals"
}
```

The console token must have the `paprika-api` audience and permission to write
Insights documents. The Observe token must carry the `paprika-observability`
audience and `paprika:observe` scope. Both should represent the same authorized
principal and exact group set, with access to the chosen provider namespaces.
Never give the browser a gateway service credential or a provider Secret.

The documented provider/metric names were discovered on Omega, not invented
examples. Discover them again before a later run: retention and service labels
can change. Prometheus's `service` values and Tempo's resource service names
are different in this environment. The dashboard's Service variable filters
the Prometheus stat; its Tempo table uses a separate saved trace query rather
than inventing a cross-provider service join.

From the repository root:

```sh
rtk proxy env INSIGHTS_OMEGA_CONFIG=/private/path/omega-validation.json \
  node ui/e2e/insights-omega.e2e.mjs
```

Optional configuration fields:

- `range: {from,to}` pins an explicit ISO time interval instead of calculating
  the last `rangeMinutes` minutes, ending two minutes before the current minute.
- `runId`, `dashboardId`, `queryId`, `traceQueryId` choose stable document names.
  IDs must be new; the script deliberately refuses to overwrite existing ones.
- `outputDir` selects an artifact directory. The default is
  `artifacts/insights/omega/<runId>/`.

The checks cover:

1. Dashboard and MCP registry discovery without copying connection metadata.
2. Two real service histories and exact MCP/dashboard sample parity for the
   same expression, range and step.
3. Nonempty Tempo search and an overlapping trace between both interfaces.
4. Real metric label cardinality when metric/label names are provided.
5. Conditional persistence of parameterized metrics, saved traces and a
   dashboard containing references to both.
6. Service filtering, two-decimal single values and sparkline history matching
   the actual API samples in light/dark mode at desktop/mobile widths.
7. No persisted default changes during filtering; restoration in a fresh
   browser context and after reload.

Reports and screenshots contain provider references, metric values and rendered
application data, but never tokens or request headers. The report includes the
created document IDs and dashboard URL. Fixture-free execution is required to
call these results live Omega validation; a local dry run only validates the
script's mechanics.

## Omega deployment configuration

`deploy/insights-omega-values.yaml` enables the persistent Insights service on
Omega. Layer it over the release's current values; it intentionally contains no
authentication secrets and does not replace the manager/repository resource
configuration. The referenced service Secret must exist before deployment.
The 10 GiB retained Vultr block volume preserves saved queries and dashboards
across Insights pod replacement.

The branch preview workflow publishes the full `linux/amd64` Docker image as
`ghcr.io/paprikacd/paprika:insights-<commit>`. Deploy by its immutable digest to
the API, Observability gateway and Insights components. Preserve the current
manager, repository server and webhook image digests. Use Omega's current
`terraform/omega-ha.kubeconfig`, confirm its context before mutations, retain
private copies of the existing Helm values/manifest, and review a server-side
Helm dry run before upgrading. Existing MCP client registry entries are retained
by the chart's server-side lookup.

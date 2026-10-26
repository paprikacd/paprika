# Paprika Insights service

Insights is a separate process and deployment. The Paprika UI talks to
`/api/insights/` on the existing API origin; that proxy authenticates the user
with Paprika's existing Basic/OIDC/token authenticators and checks the global
`insights` RBAC resource. It then sends an independent service token to Insights.
Public provider listings omit endpoints and credentials. Administrators can
inspect endpoint URLs and credential environment-variable references; resolved
credentials are never returned to the browser.

## Run

```sh
# Set PAPRIKA_INSIGHTS_TOKEN securely in both service environments (32+ characters).
go run ./cmd/paprika-insights \
  --listen=127.0.0.1:8090 \
  --data-dir=./data/insights \
  --providers=./providers.json

# On the main Paprika API process:
export PAPRIKA_INSIGHTS_URL=http://127.0.0.1:8090
```

`--dev` disables service authentication and requires an explicit loopback listen
address. Use it only for direct local development; the Paprika proxy always
requires a configured service token. Do not put the token in a frontend
environment variable. Health endpoints are `/healthz` and `/readyz`.

Provider configuration:

```json
{
  "providers": [
    {
      "id": "prometheus",
      "name": "Production metrics",
      "type": "prometheus",
      "url": "http://prometheus.monitoring.svc.cluster.local:9090"
    },
    {
      "id": "tempo",
      "name": "Production traces",
      "type": "tempo",
      "url": "http://tempo.monitoring.svc.cluster.local:3200",
      "bearerTokenEnv": "TEMPO_TOKEN",
      "headersEnv": { "X-Scope-OrgID": "TEMPO_TENANT" }
    }
  ]
}
```

Credential environment variables must exist when specified. Both adapters accept
an administrator-configured URL prefix. Redirects are refused. Query errors do
not expose upstream response bodies or internal URLs. Prometheus-compatible
backends can use the `prometheus` adapter; trace search currently targets Tempo's
TraceQL search API.

Set `PAPRIKA_OBSERVABILITY_GATEWAY_ADDR` on the Insights process (or
`Config.ObservabilityURL`, JSON `observabilityUrl`) to the observability
gateway origin to share its Prometheus and Tempo providers with Insights. The
API proxy supplies a fresh caller token in `X-Paprika-Observe-Token`; Insights
uses that token only as the gateway bearer token, independently of its own
service authentication. Missing delegation is denied, including in development
mode. Provider discovery, queries, connection tests, metadata and saved-query
validation all resolve the current caller's authorized catalog. Removing access
therefore takes effect on the next request.

Shared provider IDs are `observe-` plus the full SHA-256 of their canonical
`namespace/name`, preserving namespace identity within the existing dashboard
and saved-query ID contract. The public listing adds `source:"observability"`
and `providerRef:"namespace/name"`. Shared configurations and tokens are never
persisted in Insights, and provider configuration routes remain local-only.
The `observe-` prefix is reserved when this integration is enabled. Manage
shared providers through the Observability board. Remote metadata caches live
only for the individual authorized request; they are never reused across users.

RBAC example (add to existing rules; do not remove the application's other rules):

```yaml
auth:
  enabled: true
  rbac:
    - subjects: ["group:observability-readers"]
      actions: ["read"]
      resources: ["insights"]
      namespaces: ["*"]
    - subjects: ["group:observability-editors"]
      actions: ["write"]
      resources: ["insights"]
      namespaces: ["*"]
    - subjects: ["group:observability-readers", "group:observability-editors"]
      actions: ["read"]
      resources: ["observabilityproviders"]
      namespaces: ["monitoring"] # namespaces containing the shared providers
```

Dashboards and locally configured providers are global to this Paprika instance. Project-scoped
rules do not grant access (use an omitted projects field or `projects: ["*"]`). Read permission
allows locally configured provider queries and dashboard reads. Shared providers
also require the caller's observability provider permissions. Write permission
also allows dashboard and saved-query mutations.
`admin` permission on `insights` is required to read or mutate provider
configuration. Read permission permits connection tests and metadata discovery.
Tenant/project isolation is not implemented; use separate instances for isolated
trust domains. With Paprika authentication
disabled, the proxy follows that existing development setting.

## HTTP contract

The service routes below are exposed with `/api` replaced by `/api/insights`
through Paprika. All service API routes require `Authorization: Bearer <token>`.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/providers` | `{providers:[{id,name,type,capabilities,managed,source?,providerRef?}]}` |
| GET | `/api/provider-configs` | Admin-only `{providers:[ProviderConfigView]}` |
| PUT | `/api/provider-configs/{id}` | Admin-only saved configuration and `ETag` |
| DELETE | `/api/provider-configs/{id}` | Admin-only 204 |
| POST | `/api/providers/{id}/test` | `{ok:true,message:"Connected",durationMs}` |
| GET | `/api/providers/{id}/metadata?kind=metrics` | `{values:[string],truncated?}` |
| POST | `/api/query` | `{series?,traces?,truncated?}` |
| GET | `/api/saved-queries?providerId={id}` | `{queries:[SavedQuery + etag]}`; provider filter optional |
| GET | `/api/saved-queries/{id}` | SavedQuery and `ETag`; matching `If-None-Match` returns 304 |
| PUT | `/api/saved-queries/{id}` | SavedQuery and `ETag` |
| DELETE | `/api/saved-queries/{id}` | 204; `If-Match` required |
| GET | `/api/dashboards` | `{dashboards:[Dashboard]}` |
| GET | `/api/dashboards/{id}` | Dashboard and `ETag` |
| PUT | `/api/dashboards/{id}` | Saved Dashboard and `ETag` |
| DELETE | `/api/dashboards/{id}` | 204 |

Query request:

```json
{
  "providerId": "prometheus",
  "kind": "metrics",
  "query": "sum(rate(http_requests_total[5m]))",
  "start": 1792700000,
  "end": 1792703600,
  "step": 30
}
```

`start`, `end`, and `step` are seconds. Metric `point.timestamp` and trace
`startTime` are Unix milliseconds. Prometheus NaN/infinite samples become null
values to preserve gaps. Tempo search metadata does not supply a complete trace
status, so it is `unknown`, never assumed healthy. Empty arrays can be omitted.

PUT accepts the version-1 dashboard document shared with the frontend. Limits:
48 widgets; 256 KiB per document; 100 dashboards and 32 MiB of stored documents.
Widget IDs are unique; layouts stay within a 12-column grid. Use `If-Match` with
the GET ETag for optimistic updates/deletes, or `If-None-Match: *` for creation.
A stale edit returns 412. Clients that omit preconditions choose last-write-wins.

Query limits: 31 days; at least 1-second step; at most 5,000 points per series,
100 series, 100,000 total points, 100 traces, 8 MiB upstream response, 20-second
timeout, and 16 simultaneous queries. Provider results exceeding count limits
set `truncated:true`; invalid requests fail before contacting a provider.
Client cancellation propagates to providers.
Native warnings and explicit partial-result markers also set `truncated:true`
without exposing raw backend warning text. Non-OK gateway states remain errors:
denied access is 403, missing configuration/capability is 503, and failed queries
are 502; none are converted into successful empty results.

## Saved-query library

Saved queries are global documents associated with one provider and query kind:

```json
{
  "schemaVersion": 1,
  "id": "service-requests",
  "name": "Requests by service",
  "providerId": "prometheus",
  "kind": "metrics",
  "query": "sum(rate(http_requests_total{service={{service}}}[5m])) > {{minimum}}",
  "parameters": [
    {"name":"service","type":"string","label":"Service"},
    {"name":"minimum","type":"number","defaultValue":0}
  ]
}
```

Documents are strict version-1 JSON, at most 32 KiB each and 256 in total, stored
atomically in `saved-queries/` below `--data-dir`. Names are 1–120 characters,
optional descriptions up to 500, and queries 1–8,192 after trimming. At most 20
parameters have unique identifier names, optional labels up to 80 characters,
and type `string` or `number`. Defaults must match that type; strings are bounded
to 1,024 characters and numbers must be finite. Every `{{name}}` placeholder must
be declared and occupy a whole unquoted literal outside comments. String values
are quoted and numeric values remain numbers. Saving validates the template and
configured provider capability but never executes the query. Provider and kind
are immutable after creation.

Replacement also checks all currently persisted widget and tooltip references.
It returns 409 if the changed parameter contract newly removes a bound parameter,
requires an unbound value, invalidates a fixed value or observation field, or changes
the type of a parameter bound to a dashboard variable or observation label. A
reference with a pre-existing unchanged problem does not block harmless query or
metadata edits. Removing an implicit default is permitted when every affected
reference supplies a binding; adding an optional parameter is permitted. Repair
the affected bindings or create a query copy before an incompatible replacement.
The guard applies even to dashboards intended for a later replacement because
individual resource writes are not an atomic transaction.

Use `If-None-Match: *` for creation and the current `ETag` with `If-Match` for
updates. Stale preconditions return 412. PUT without preconditions explicitly
chooses last-write-wins. DELETE requires `If-Match` (428 if omitted); deleting a
query referenced by a persisted dashboard returns 409. A provider used by a saved
query cannot be deleted or changed to a different type (409). Name, endpoint and
credential-reference edits remain available. Dashboard, provider and saved-query
mutations serialize their reference checks and persistence. These are single-
process guarantees under the same single-replica constraint as dashboards.

A widget can carry `queryRef:{id,bindings?}`. Each binding has a unique
`parameter` plus either `source:"variable",variable:<dashboard variable name>`
or `source:"constant",value:<string or finite number>`. At most 20 are allowed.
The existing widget `providerId` and `query` remain required custom-query drafts;
the reference is authoritative and missing references never fall back to them.
Portable dashboards may retain missing library/provider/variable references;
the browser resolves and validates them before invoking the unchanged resolved
`POST /api/query` endpoint. The library remains readable after an operator removes
a provisioned provider from startup configuration; attempting to save a query for
that absent provider is rejected until it is restored or the query is removed.

JSON/YAML exports with saved-query references use a browser-level
`PaprikaDashboardLibrary` envelope containing `schemaVersion: 1`, `dashboards`,
and `savedQueries`. It includes each referenced top-level or tooltip definition
once, without ETags, unrelated queries, provider endpoints, or credentials. An
explicit `savedQueries` array must contain the complete dependency set. Older
documents without that array resolve their references against the destination
library during import. The service continues to accept individual strict
dashboard and saved-query documents; it does not accept the envelope as a PUT
body or expose a transaction endpoint.

The browser compares incoming documents with saved snapshots and offers Keep,
Replace, or Copy independently for existing dashboards and saved queries. Keep
does not write the saved document; a kept dashboard skips its incoming dependencies.
Copy conditionally creates new IDs and rewrites imported references. Explicit
Replace uses the reviewed ETag with `If-Match`, preserving IDs and existing links.
Query replacement affects every dashboard using that ID, so the review shows its
impact and the service enforces the parameter-compatibility rules above. Provider
and kind changes require a query copy. Refreshing a stale comparison clears Replace
choices so the user must select them again.

The browser remaps providers and verifies each dashboard's dependencies before
its conditional write. A lost write acknowledgement is recovered only when GET
returns the exact planned document. The active review session retains IDs across
partial retries and skips completed decisions. This is not an atomic multi-resource
transaction: successful query changes can remain after a later dashboard failure,
and an independent dashboard can succeed while another dashboard's dependency
fails. There is no automatic rollback. Closing or reloading the review ends its
in-memory retry session; a new Copy review allocates new dashboard IDs.

## Managed providers and discovery

Providers from the startup configuration are provisioned and immutable through
the API. Administrators can add managed providers using the same configuration
shape (`id`, `name`, `type`, `url`, optional `bearerTokenEnv` and `headersEnv`).
PUT must match the ID in the path and must omit response-only `managed` and
`etag` fields. Configuration views include both fields. Use their ETag with
`If-Match` for updates/deletes or `If-None-Match: *` for creation; stale edits
return 412 and attempts to change provisioned providers return 409.

Managed credential references must use names beginning `PAPRIKA_PROVIDER_`
followed by uppercase letters, digits, or underscores. Referenced variables must
already exist in the service environment. Raw credentials are not accepted.
Managed configurations persist atomically in `providers/` below `--data-dir`;
the registry supports at most 32 provisioned and managed providers combined.
On startup, a managed ID that collides with a provisioned ID is an error.

Metadata `kind` accepts `metrics`, `labels`, or `values`; `values` requires
`label`. Prometheus also accepts an optional `metric` identifier to scope label
discovery using `match[]`. Tempo supports `labels` and `values` for trace tags.
Discovery searches the last 24 hours, returns at most 1,000 unique sorted values,
limits responses to 1 MiB, and caches successful results for 30 seconds in a
bounded per-provider cache. Editing a provider invalidates its cache. Connection
tests use Prometheus `vector(1)` or Tempo's `/api/echo` endpoint. Tests and discovery
share the query concurrency and timeout limits, and sanitize upstream failures.

## Dashboard extensions

Dashboard documents support optional `folder` paths (160 characters, nonempty
segments without `.` or `..`) and `customTimeRange: {from,to}`. Both dates must
include a timezone; the end must follow the start within 31 days. A custom range
overrides the retained preset `timeRange`.

Widgets support `heatmap` and `plugin` as well as the original chart types.
`options` can set line/area display, axis labels, legend/tooltips/grid, decimal
precision, min/max bounds, line width, fill opacity, curve, background/text
colors, and up to 12 strictly ascending thresholds. Colors use `#RRGGBB`.
Heatmaps additionally expose independent `showLabels` and `showValues` booleans
in `options`; both default to visible when omitted. Explicit `false` values are
preserved in stored and exported dashboards.
Single-value widgets and tooltip views can enable a boolean `showSparkline` in
`options` or `options.tooltipView`. Omission or `false` keeps the value-only
presentation. The renderer uses the same loaded series history without another
query; the service preserves either explicit boolean unchanged.
`options.tooltipView` can select any built-in widget type or a registered plugin,
with bounded presentation fields and an optional data source. An omitted source
or `{type:"series"}` uses the hovered series. `{type:"widget"}` reuses the complete
existing parent result without a child request. A query source contains
`{type:"query",providerId,query,bindings?:[...]}`. Each binding uses either
`{variable,label}` with a label key of 1–128 characters, or
`{variable,field:"value"|"timestamp"|"series"}`; the two forms are exclusive.
Variable names are unique across both forms (at most 20). The host resolves finite
values and observation timestamps in Unix seconds as numeric query literals,
and series names and label values as quoted strings. A saved-query source is
`{type:"saved",ref:{id,bindings?}}`; its bindings support the widget reference forms
above plus `source:"label",label:<key>` and
`source:"field",field:"value"|"timestamp"|"series"`. Parameter names stay unique
across all forms. Trace views require a query, saved query, or compatible widget
result source. Plugin ID, data kind, and JSON configuration follow the
same rules as parent widgets; nested tooltip definitions are not accepted.
Provider references remain portable when saving: the query endpoint checks the
currently configured provider and its metrics/traces capability before forwarding
anything upstream. See [tooltip sub-widgets](../../docs/design/insights/tooltip-widgets.md)
for presentation bounds and host-owned query execution.
Plugin widgets require `pluginId` and `dataKind` (`metrics` or `traces`), with an
optional JSON-object `config` bounded to 16 KiB and depth eight. Built-in widgets
reject plugin-only fields. All objects use strict field validation shared with
the frontend; arbitrary code and prototype-sensitive configuration keys are
not accepted.

## Deployment

The normal image now includes `/insights` alongside `/manager`. Helm enables a
separate Deployment and ClusterIP service:

```yaml
insights:
  enabled: true
  token:
    existingSecretName: paprika-insights-token
    existingSecretKey: token
  providers:
    - id: prometheus
      name: Prometheus
      type: prometheus
      url: http://prometheus.monitoring.svc.cluster.local:9090
  persistence:
    enabled: true
    size: 1Gi
```

Create the referenced Secret through your existing secret manager. Configure
provider credentials through `insights.extraEnv`/`extraEnvFrom`. NetworkPolicy
allows the API/operator to reach Insights and allows configured provider ports;
customize `insights.networkPolicy.egress` for provider namespaces/ports.

The file store uses fsync plus atomic rename on a persistent volume and serves
one writer. Helm uses one replica and `Recreate`; do not increase replica count
or share its data directory across processes. Back up the PVC. Disabling
persistence uses ephemeral storage and loses dashboards, saved queries, and managed providers
on pod replacement.

`/metrics` exposes OTel query counters and latency histograms through the existing
controller-runtime registry. Standard OTEL environment configuration is supported.
No provider credentials, queries, or user IDs are metric labels.

## Verification

```sh
go test -race ./internal/insights ./cmd/paprika-insights
go test ./internal/api -run TestInsights -count=1
helm lint charts/chart --set insights.enabled=true \
  --set insights.token.existingSecretName=insights-token
```

Tests cover HTTP CRUD through the authenticated proxy to the actual service,
restart persistence, compare-and-swap contention, reader authorization,
credential stripping, mock Prometheus/Tempo HTTP providers, malformed data,
query cancellation, redirect refusal, response bounds, and validation errors.

For browser-to-service coverage, start the Next development server on port 3015
and run `node e2e/insights-live.e2e.mjs` from `ui/`. The script builds and starts
the real Go service with temporary storage and deterministic HTTP providers,
then tests visual configuration, live queries, saving, service restart, error
states, provider management/discovery, custom time ranges, and concurrent editing.
Its Playwright route bridge only replaces the
missing reverse proxy in the static Next development server; Go integration
tests independently exercise the production proxy's authentication and RBAC.
The script cleans up its service, providers, and temporary files and saves its
report and screenshots in `artifacts/insights/`.

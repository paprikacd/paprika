# Observability Gateway

The observability gateway is Paprika's MCP surface for querying observability
backends — **logs, metrics, and traces** — through pluggable connectors. It runs
as its own microservice (its own Deployment in split mode, its own `--mode` in
the shared binary) and exposes:

```
https://<paprika-host>/observe/mcp
```

on the same hostname and TLS identity as the console (`/mcp` keeps serving the
fleet surface). Gateway tokens carry the **`paprika-observability`** audience and
the **`paprika:observe`** scope, so a token minted for the console or fleet MCP
surface is not replayable here and vice versa — even though all surfaces share
the deployment's HMAC token secret.

## Architecture

```
Claude/Codex → https://paprika.example.com/observe/mcp     (HTTPRoute, /observe)
                     │ h2c
                     ▼
       Deployment/<release>-observability-gateway
                     │  mcp.Server (RoutePrefix /observe, ScopeObserve only,
                     │  console resource extensions disabled, own embedded
                     │  consent page at /observe/consent)
                     ▼
       internal/observabilitygateway.Backend
                     │  per call: get ObservabilityProvider CR
                     │  (namespace/name) → resolve credentialsSecretRef
                     ▼
       connector.New(type).Query(...)  (stateless; config travels per-request)
                     │
                     ▼
       prometheus / loki / tempo / otlp  (plain HTTP, no vendor SDKs)
```

- `internal/observabilitygateway/connector` — the connector framework:
  `Connector` interface (`Descriptor` / `ValidateConfig` /
  `Query`), a dup-rejecting `Registry`, signal/state/sentinel vocabulary that
  deliberately parallels `internal/clusterprovider` and `internal/dataprovider`
  (state strings OK/NotConfigured/NotAvailable/Error/Forbidden; sentinels
  `ErrForbidden` / `ErrNotConfigured` / `ErrUnsupported` / `ErrNotAvailable`).
- Connector errors never echo endpoints, credentials, or response bodies into
  tool results — users get fixed sentences, detail goes to the gateway log
  (clusterprovider sanitize discipline).
- Unsupported query shapes return a `StateNotAvailable` result plus an error
  wrapping `ErrUnsupported`; the backend returns the result and logs the error.

## The MCP surface

Thirteen tools, all read-only, all requiring `paprika:observe`:

| Tool | Purpose |
|---|---|
| `list_observability_providers` | List `ObservabilityProvider` CRs (name, type, state) |
| `get_observability_provider` | One provider's descriptor (signals it supplies) |
| `query_logs` | LogQL query (loki/otlp connectors) |
| `query_metrics` | PromQL instant/range query (prometheus/otlp) |
| `query_traces` | TraceQL search or `trace_id` fetch (tempo/otlp) |
| `list_metric_names` | Enumerate a metrics provider's metric names (`prefix`/`limit` filters) |
| `list_label_names` | Label names — globally or on one `metric` (prometheus/loki/tempo tags) |
| `list_label_values` | One `label`'s values, optionally constrained to a `metric` |
| `get_metric_metadata` | One metric's type/help/unit (prometheus `/api/v1/metadata`) |
| `list_trace_services` | Service names a tempo provider has spans for |
| `list_provider_types` | The provider-type catalog (library view) |
| `describe_provider_type` | One type's config schema + onboarding walkthrough |
| `validate_provider` | Dry-run a prospective provider's config/credentials |

The five exploration tools answer in the backend's own JSON envelope
(`{"status":"success","data":[...]}` for prometheus/loki, `{"tagNames":[...]}`
/ `{"tagValues":[...]}` for tempo) so a caller can explore a backend and then
query what it found without learning a gateway dialect. Exploration is an
optional connector capability (`connector.Explorer`) implemented per provider,
each mapping the generic kinds onto its own native discovery mechanism:

| Provider | metric_names | label_names | label_values | metric_metadata | trace_services |
|---|---|---|---|---|---|
| prometheus | `/api/v1/label/__name__/values` (+ prefix/limit) | global `/api/v1/labels`, or per-metric via `/api/v1/series` union | global or per-metric series union | `/api/v1/metadata` | — |
| loki | — | `/loki/api/v1/labels` | `/loki/api/v1/label/x/values` | — | — |
| tempo | — | `/api/search/tags` | `/api/search/tag/x/values` | — | `service.name` tag values |
| aws-cloudwatch-metrics | `ListMetrics` (optional `namespace` arg; paginated) | dimension-name union from ListMetrics | dimension-value union for a label | — (no metadata API) | — |
| aws-cloudwatch-logs | `DescribeMetricFilters` | — | — | — | — |
| aws-xray | — | — | — | — | `GetServiceGraph` (trailing 30 min) |
| aws-cloudtrail | — | static LookupAttributes catalog | — | — | — |
| gcp-cloudmonitoring | `metricDescriptors.list` (`starts_with` prefix filter) | descriptor `labels[].key` union | — (values not enumerable) | exact descriptor passthrough | — |
| gcp-cloudlogging | `logMetrics.list` | — | — | — | — |
| vultr-monitoring | static catalog (`account_bandwidth`, `instance_bandwidth_in/outgoing_bytes`) | static `instance_id/label/region/status` | live `GET /v2/instances` union | static type/help/unit per catalog metric | — |
| gcp-cloudtrace, otlp, mock* | — → `StateNotAvailable` | — | — | — | — |

\* mock implements every kind from a fixed synthetic catalog (e2e stays
hermetic). A provider type answering `StateNotAvailable` returns a fixed
sentence naming the missing capability — data, not an error. The optional
`namespace` argument is read by the CloudWatch metrics connector only.

Tool args take `provider` as `namespace/name`. `start`/`end` are RFC3339
(default: last 30 minutes); `limit` defaults vary by connector.

OAuth 2.1 + PKCE, RFC 7591 dynamic client registration, and RFC 9728/8414
discovery all work exactly like the fleet MCP surface, under `/observe/*`:

- `GET /.well-known...` — served at `/observe/.well-known/oauth-protected-resource`
  and `/observe/.well-known/oauth-authorization-server` (the 401 challenge's
  `resource_metadata` points there; the host-root well-knowns remain the
  console surface's).
- Consent: browsers are redirected to `/observe/consent`, a minimal
  self-contained page embedded in the gateway binary. Unifying it with the
  branded console consent page is follow-up work.

## Configuring providers

`ObservabilityProvider` is a namespaced CR (group
`observability.paprika.io`):

```yaml
apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: prometheus
  namespace: paprika-e2e
spec:
  type: prometheus                     # prometheus | loki | tempo | otlp |
                                       # gcp-cloudlogging | gcp-cloudmonitoring | gcp-cloudtrace |
                                       # aws-cloudwatch-logs | aws-cloudwatch-metrics |
                                       # aws-xray | aws-cloudtrail
  config:
    endpoint: http://kube-prometheus-stack-prometheus.monitoring:9090
  # credentialsSecretRef:             # optional
  #   name: grafana-cloud-token       # namespace/key optional (default: CR ns, "credentials")
```

- `spec.config` is opaque per-connector JSON, validated at admission by the
  connector itself (webhook `rejectInlineCredentials` refuses literal
  token/password keys anywhere in the document; put credentials in a Secret).
- `spec.credentialsSecretRef` document: nil = no auth; otherwise the secret
  `data[key]` is sent as `Authorization: Bearer <value>`, or HTTP Basic when it
  contains `user:password`.
- `endpoint` (absolute http(s) URL) is the one universal config key; unknown
  keys fail validation (typo fail-fast). Optional keys:
  - `headers` — map of extra request headers (≤16 entries, ≤4 KiB combined):
    vendor tenancy like Loki/Grafana/Mimir `X-Scope-OrgID`. Operator-declared
    headers win `Authorization` collisions (documented + tested).
  - `insecureSkipTLS` — bool, for self-signed in-cluster backends only (never
    off-cluster; per-config client so verified/unverified TLS sessions never
    share connection pools).
  - `step` — prometheus-only range-query step override (Go duration, >0, ≤1h;
    otherwise derived as max(10s, span/250)).

### Connector specifics

| type | signals | query behavior |
|---|---|---|
| `prometheus` | metrics | PromQL; range (start+end) → `/api/v1/query_range` with computed step, instant otherwise |
| `loki` | logs | LogQL → `/loki/api/v1/query_range`; limit default 100, max 1000 |
| `tempo` | traces | `trace_id` → `/api/traces/<id>`; TraceQL → `/api/search` |
| `otlp` | logs, metrics, traces | Generic OTLP/HTTP retrieval proxy: `GET <endpoint>/v1/{logs,metrics,traces}` with `trace_id`/`start`/`end`/`limit` params when set |
| `gcp-cloudlogging` | logs | Query = Cloud Logging [advanced filter](https://cloud.google.com/logging/docs/view/logging-query-language); empty → probe (`entries:list`, 1 entry) |
| `gcp-cloudmonitoring` | metrics | Query = [Monitoring filter](https://cloud.google.com/monitoring/api/v3/filters); window required (defaults to trailing hour); empty → probe (`metricDescriptors`, 1 row) |
| `gcp-cloudtrace` | traces | `trace_id` → one trace; Query = optional list filter; empty → probe (1 trace) |
| `aws-cloudwatch-logs` | logs | Query = CloudWatch [filter pattern](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html) (empty = all events); config `logGroup` required; probe = 1 event |
| `aws-cloudwatch-metrics` | metrics | Query = metric name in config `namespace` (required); period derived from window (clamped 60–3600s, Average/Sum/Maximum); empty → probe (`ListMetrics`) |
| `aws-xray` | traces | `trace_id` → `BatchGetTraces`; Query = X-Ray [filter expression](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-filters.html) (empty = all); probe = summaries, trailing 10 min |
| `aws-cloudtrail` | audit | Query = comma-separated `Key=Value` lookup attributes (e.g. `EventName=RunInstances,EventCategory=Activity`), empty = all; limit ≤ 50; probe = 1 event |
| `mock` | metrics, logs, traces | Synthetic in-process backend for load tests, demos and e2e — no network egress. Config knobs (all optional, bounded): `series`, `pointsPerSeries`, `labelsPerSeries`, `logEntries`, `traces`, `spansPerTrace` (payload shape), `latencyMs` (context-aware synthetic latency), `failEvery` (deterministic stable error subset — every Nth distinct query string), `seed` (deterministic generator seed; identical query + seed = identical data) |

### Perf testing with the mock connector

`hack/obsloadgen` drives the gateway's MCP surface with N concurrent clients
(one self-signed `paprika-observability` token each — distinct subjects so
the per-subject rate limiter binds no client but its own), and
`task perf:obs-*` wraps the loop for the kind perf stack:

```sh
task perf:obs-seed COUNT=50        # seed varied mock providers (idempotent)
task perf:obs-load SECS=60 CLIENTS=32 RPS=5
task perf:obs-profile SECS=30      # combined load + pprof capture
task perf:obs-metrics              # gateway /metrics + kubectl top
```

**Grafana Cloud** uses the same three native connectors with the Grafana Cloud
endpoint and an API token as `credentials`, e.g.:

```yaml
spec:
  type: prometheus
  config:
    endpoint: https://prometheus-prod-01-us-west1.grafana.net/api/prom
  credentialsSecretRef:
    name: grafana-cloud
```

### Cloud connectors (GCP and AWS)

The seven cloud connectors share the same CR shape; what changes is the
credential document and the config keys:

- **AWS** (`aws-cloudwatch-logs`, `aws-cloudwatch-metrics`, `aws-xray`,
  `aws-cloudtrail`) — `spec.credentialsSecretRef` holds the same snake_case
  JSON the EKS cluster provider accepts:
  `{"access_key_id": "...", "secret_access_key": "...", "session_token": "..."}`.
  Omit the ref entirely to use the ambient SDK chain (IRSA / IMDS /
  environment). Config keys: `region` (required), plus the connector's
  required selector (`logGroup` for logs, `namespace` for metrics), plus
  optional `endpoint` (VPC endpoints / in-cluster emulators — the SDK
  sends to it verbatim) and `insecureSkipTLS`.
- **GCP** (`gcp-cloudlogging`, `gcp-cloudmonitoring`, `gcp-cloudtrace`) —
  the secret holds a Google credential JSON restricted to `service_account`,
  `external_account` or `impersonated_service_account` (type-checked before
  loading, same as the GKE cluster provider); omit it for ambient identity
  (GKE Workload Identity / metadata server). Config keys: optional
  `projectId` (defaults to the credential's project), optional `endpoint`
  (private proxies / fakes — replaces the `*.googleapis.com` base),
  `insecureSkipTLS`.

Empty `query` on a cloud connector is its **health probe** (one cheap read:
`entries:list` page 1, `metricDescriptors` page 1, `traces` page 1,
`FilterLogEvents` limit 1, `ListMetrics`, `GetTraceSummaries` 10 min,
`LookupEvents` 1) — the gateway's `validate_provider` tool and the console's
"Test connection" button run exactly this probe without persisting anything.

E2E coverage runs in kind: LocalStack serves CloudWatch Logs + Metrics
(X-Ray and CloudTrail are license-gated there, so those two run against a
canned nginx responder), and a JWT-issuing nginx fake serves the GCP REST
shapes with a runtime-generated service-account key — see
`test/e2e/observabilitycloud_test.go`.

## Enabling the gateway

```sh
helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e --values deploy/test-values.yaml \
  --set observabilityGateway.enabled=true --wait --timeout 5m
```

Preconditions enforced at render time (`helm template` fails otherwise):
`deploymentMode: split`, `mcp.enabled`, `auth.enabled`, a non-empty
`PAPRIKA_AUTH_TOKEN_SECRET` via `observabilityGateway.extraEnv(From)`, and
`mcp.oauth.clientId` / `mcp.oauth.redirectUris` / `mcp.publicURL`. Public
exposure reuses the api-server's Gateway/hostname:

```yaml
observabilityGateway:
  enabled: true
  ingress:
    enabled: true     # HTTPRoute: path prefix /observe → gateway Service
```

Verify:

```sh
curl -s https://paprika.benebsworth.com/observe/.well-known/oauth-protected-resource | jq .
# { "resource": "https://paprika.benebsworth.com/observe/mcp",
#   "authorization_servers": ["https://paprika.benebsworth.com"],
#   "scopes_supported": ["paprika:observe"] }
```

## Autodiscovery from in-cluster Services

Backends running in the same cluster can register themselves without anyone
hand-writing provider YAML. The provider-discovery controller
(`internal/controller/observe`) watches Services carrying the opt-in
annotation and materializes each as an `ObservabilityProvider` CR in the
Service's namespace. It runs in the observability gateway pod itself (a
dedicated controller-runtime manager alongside the MCP server, single
replica with leader election off), so discovery works even where only the
observability microservice is installed; the pipeline manager also
registers the reconciler, and dual-running converges safely:

```yaml
metadata:
  annotations:
    observability.paprika.io/discover: "true"
```

Type and endpoint are inferred from the Service: the connector type comes
from the Service name (`prometheus`, `loki`, `tempo`, `otel` substrings — so
`prometheus-operated`, `loki-gateway`, `tempo-query-frontend`, and
`otel-collector` all just work), the port from each type's well-known port
names (`http-web`/`web`/`http`, `http-metrics`, `otlp-http`, …) falling back
to the first declared port, and the endpoint is
`http://<service>.<ns>.svc:<port>`. Inference overrides:

| Annotation | Effect |
|---|---|
| `observability.paprika.io/type` | explicit connector type (`prometheus`/`loki`/`tempo`/`otlp`) when the name matches nothing |
| `observability.paprika.io/port` | explicit port number (invalid values hard-reject the Service) |
| `observability.paprika.io/path` | base path appended to the endpoint (e.g. Prometheus behind `/prometheus`) |

Ownership rules keep the CR-as-system-of-record invariant:

- Discovered CRs are labeled `observability.paprika.io/discovered: service`
  and owned by the Service — deleting the Service or removing the
  annotation garbage-collects the provider.
- The controller converges type/endpoint drift on labeled CRs but **never
  touches a CR without the label** — dropping the label from a discovered
  provider hands it to the operator permanently, and an operator-written CR
  of the same name is never deleted or modified.
- Discovered providers have no credentials (in-cluster backends are usually
  unauthenticated); edit the CR to add `credentialsSecretRef` and it still
  converges endpoint changes around your edit.

Example — everything kube-prometheus-stack + loki + tempo need:

```sh
kubectl annotate svc prometheus-operated -n monitoring observability.paprika.io/discover=true
kubectl annotate svc loki-gateway -n monitoring observability.paprika.io/discover=true
kubectl annotate svc tempo-query-frontend -n tracing observability.paprika.io/discover=true
kubectl get observabilityproviders -A
```

## Provider status

The gateway is also the writer behind the provider board's STATE column: its
status prober re-runs the catalog's per-type health probe — the cheapest read
each backend accepts, the same probe the onboarding wizard's **Test
connection** runs — against every registered provider on
`--obs-provider-probe-interval` (chart `observabilityGateway.probeInterval`,
default `5m`; `0` disables status writes) and patches the verdict onto each
CR's `status`: `state` (`OK`/`NotConfigured`/`NotAvailable`/`Error`/
`Forbidden`), a fixed-sentence `reason` that never carries credential or
endpoint detail, `observedGeneration`, and a `Ready` condition mirroring the
state. The probe resolves credentials through the same path a query does, so
status shows what a query would experience right now; `kubectl get
observabilityproviders` and the console's provider board read the same
fields.

## Managing providers in the console

The dashboard's **Observability** page (`/dashboard/observability/`, listed
under *Sources* in the sidebar) renders three boards:

- **Provider library** — every provider type the gateway can connect to
  (OSS + GCP + AWS), served from the gateway's catalog: vendor, category,
  signals, and a one-line summary per type.
- **Providers** — every `ObservabilityProvider` (name, type, signals,
  endpoint, state, discovery provenance). Discovered providers carry a
  DISCOVERED pill; states map to the console's status tones.
- **Tool usage** — per-tool call/error counters maintained by the gateway's
  usage tracker and served from its authenticated `/observe/api/usage`
  endpoint. The api-server proxies it over `GetObservabilityUsage` (minting
  a short-lived `paprika-observability` token per call); when the gateway is
  not deployed the board renders the canonical "not configured" sentence
  instead of zeros.

Selecting **Set up** on a library card opens the onboarding wizard: the
type's guided steps (with copyable CLI/IAM snippets from the catalog), its
config form, the credential document, then **Test connection**
(`ValidateObservabilityProvider` — runs the connector's health probe via
the gateway, verdict as data: a Forbidden credential shows as data, not an
error) and **Create provider** (`CreateObservabilityProvider` — creates the
`<name>-credentials` Secret plus the CR; the admission webhook validates
type/config and rejects inline credentials, and a rejected CR cleans its
secret up). Creation is authorized with the console's `write` action on the
`observabilityproviders` resource in the target namespace.

The same data is available programmatically:
`PaprikaService.ListObservabilityProviderTypes`,
`GetObservabilityProviderType`, `ValidateObservabilityProvider`,
`CreateObservabilityProvider`, `ListObservabilityProviders`, and
`GetObservabilityUsage`. On the MCP surface, agents get `list_provider_types`,
`describe_provider_type`, and `validate_provider` alongside the query tools.

## Linking providers to Applications (future)

The v1 CRD is deliberately shaped for a follow-up binding CR
(`DataProviderBinding`-style scope precedence: application > namespace >
cluster) that will attach providers to Applications so the console view layer
and deployment pages can surface logs/metrics/traces per app. The gateway
itself is agnostic to that: tools already accept any `namespace/name` provider.

## Files

- `cmd/main_observability_gateway.go` — the `--mode=observability-gateway` runner
- `internal/observabilitygateway/` — backend (CR + credential resolution), MCP tools, catalog/validate HTTP handlers, consent page, `New(providerType)` connector registry
- `internal/observabilitygateway/connector/` — connector framework + registry
- `internal/observabilitygateway/connector/{prometheus,loki,tempo,otlp}/` — the OSS connectors
- `internal/observabilitygateway/connector/{awscommon,awscloudwatchlogs,awscloudwatchmetrics,awsxray,awscloudtrail}/` — AWS connectors (SDK v2, snake_case key JSON or ambient chain)
- `internal/observabilitygateway/connector/{gcpcommon,gcpcloudlogging,gcpcloudmonitoring,gcpcloudtrace}/` — GCP connectors (x/oauth2 service-account/external_account/impersonated JSON or ambient, hand-rolled REST)
- `internal/observabilitygateway/catalog/` — the provider-type library (metadata, config-field specs, onboarding steps, probes)
- `internal/api/mcp/` — the shared MCP server (route prefix / audience / scope generalization lives here)
- `api/observability/v1alpha1/` — the `ObservabilityProvider` CRD
- `internal/webhook/observability/v1alpha1/` — admission validation
- `charts/chart/templates/observability-gateway/` — Deployment/Service/HTTPRoute/HPA/VPA/PDB

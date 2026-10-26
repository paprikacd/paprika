# Validating the observability gateway

Run verification on the exact source that will be built. Preserve immutable source,
image digest, chart values containing only Secret references, and the previous Helm
revision. A successful local fixture test does not establish live provider access.

## Request and identity boundaries

The production gateway checks explicit `observabilityproviders` read RBAC for the
provider namespace before reading its configuration or credentials. An empty RBAC
rule set denies access. A cross-namespace credential reference also requires access
to its namespace. Prefer ambient workload identity and a dedicated query-only
Kubernetes ServiceAccount; `observabilityGateway.serviceAccountName` selects an
existing identity without granting it permissions. Disable
`observabilityGateway.discovery.enabled` to avoid starting the Service discovery
writer when providers are installed explicitly.

The gateway Deployment passes approved nonsecret `auth.rbac` rules directly as
JSON in `PAPRIKA_AUTH_RBAC_RULES`; the add-on requires no auth ConfigMap. Empty
rules retain deny-all behavior. Scope application rules to an exact approved
subject, `read` on `observabilityproviders`, and provider namespace. Application
RBAC grants require separate approval; Kubernetes or cloud permissions do not
grant user access. Do not combine `auth.rbac` with a manual gateway extraEnv entry
for `PAPRIKA_AUTH_RBAC_RULES`; the chart rejects that ambiguous configuration.

The gateway can start with dynamic client registration only: leave both
`mcp.oauth.clientId` and `mcp.oauth.redirectUris` empty. With fleet MCP disabled,
the full chart and standalone add-on emit no static-client arguments; startup
creates no preconfigured persistent client. Preconfigured clients are optional and require
both fields; partial configuration is rejected. Rendering and startup do not
perform native OAuth sign-in or approve client access. Obtain separate approval
before registering a client or configuring persistent client access.
The gateway uses shared MCP configuration fields independently of `mcp.enabled`,
which enables the fleet surface. Leave fleet MCP disabled when only the gateway
is required; the existing fleet startup requirements remain unchanged.

When OAuth `resource` is supplied repeatedly, every value must identify the same
approved MCP URL. Identical repeats are accepted; mixing the observe target with
the fleet URL or another target is rejected during authorization, code exchange
and refresh before consuming the grant. Omission remains a first-party
compatibility path. OAuth-minted access tokens must satisfy the configured,
nonempty public-origin JWT issuer and the `paprika-observability` audience.

Backend calls have a 30 second overall deadline and a four-operation process limit.
Excess work is rejected immediately. Query windows default to the trailing 30 minutes,
must be ordered, and cannot exceed 31 days. The default result limit is 100 and the
maximum is 1000. These are safety budgets, not measured production capacity. The
listener also honors `--api-max-conns`, bounds protocol requests through response
serialization/writing, and drains requests during shutdown. Slow request bodies
and response writes are bounded to 15 and 45 seconds respectively.

The Observe cancellation bridge must propagate HTTP disconnects into tool contexts
for `2025-03-26`, `2025-11-25` and `2026-07-28`. Exercise each protocol version
with a blocking local fixture and bounded cancellation deadline.

GCP continuation uses `page_token`; resend the same provider, query, explicit start,
end and limit. Tokens are bounded to 4096 bytes and are never logged. GCP responses
retain their native `nextPageToken`. Unsupported connectors reject continuation.
Discovery that reaches a bounded pagination cap reports an explicit warning/error.
Provider inventory itself does not yet support a cursor.

Cloud Logging intersects the requested filter with the time window. Monitoring
intersects queries and descriptor discovery with the configured data project, since
a metrics-scope project can contain linked projects. Scope a provider to the intended
project; query filters cannot select another data project. Cloud Monitoring native
filters can read collected `prometheus.googleapis.com` metrics. Native GMP PromQL
using ambient Google identity is not implemented; the plain Prometheus connector
serves existing Prometheus-compatible HTTP endpoints.

Prospective `validate_provider` and the console validation endpoint perform offline
configuration validation. They do not accept credential payloads or perform active
health probes. Query an approved provider to establish connectivity and permissions.
Backend redirects are refused, OAuth token TLS remains verified, and transient
HTTP statuses receive bounded, cancellation-aware backoff. Provider failures set
MCP `isError` and error counters, retaining their structured state. Successful
partial results retain backend warnings. Errors and gateway logs do not include raw
backend error text; authorized log/trace payloads are not a general content-redaction
service.

## Local verification

Use the repository's supported Go toolchain and bound build parallelism on shared
hosts. Do not clear shared caches.

```sh
GOMAXPROCS=4 go build -p 2 ./...
GOMAXPROCS=4 go test -p 2 ./internal/observabilitygateway/... ./internal/api/mcp ./internal/api ./cmd ./hack/obsloadgen -count=1
GOMAXPROCS=4 go test -p 2 ./internal/engine ./internal/controller/pipelines -count=1
GOMAXPROCS=4 go vet -p 2 ./internal/... ./cmd/...
GOMAXPROCS=4 go test -race -p 2 ./internal/observabilitygateway ./internal/observabilitygateway/connector/httphelp ./internal/observabilitygateway/connector/gcpcommon ./internal/api/mcp -count=1
bash hack/test-observability-chart-rendering.sh
bash hack/test-observability-addon-rendering.sh
helm lint charts/chart/
helm template paprika charts/chart/ >/dev/null
```

The local OAuth contracts in
`internal/api/mcp/observe_oauth_native_contract_test.go` and
`cmd/main_observability_gateway_native_contract_test.go` use a nonempty public
origin and actual gateway authentication. Cover registration, browser consent,
PKCE exchange and refresh, then use the minted token for native-style
`initialize`, `notifications/initialized`, `tools/list` and a static catalog call.
Check wrong issuer/audience rejection. Fixed fixture credentials, fake Kubernetes
objects and static catalog results do not establish native-client sign-in or live
provider access; record final test outcomes separately.

The chart tests exercise the identity reference, immutable digest, offline render,
authentication requirements, DCR-only and partial-client contracts, explicit
backend egress, canonical OAuth metadata routes, and singleton deployment
requirements. The optional observe package has
Node contract tests and can be validated using Claude's supported CLI:

```sh
node --experimental-strip-types --test internal/api/mcp/ui/tests/observe-plugin.test.ts internal/api/mcp/ui/tests/plugin.test.ts
claude plugin validate --strict --json plugins/paprika-observe
claude plugin validate --strict --json .claude-plugin/marketplace.json
```

For repeatable synthetic measurements and CPU/allocation profiles, run:

```sh
GOMAXPROCS=2 BENCH_SECONDS=1 BENCH_COUNT=3 bash hack/obsloadgen/profile-local.sh /tmp/paprika-observe-baseline
```

See [measurement details](../../hack/obsloadgen/README.md). Report latency, allocation
and throughput units accurately. Concurrency-four benchmark ns/op is amortized
wall time per completed operation, not request latency. These profiles exclude real
cloud/Kubernetes traffic, MCP authentication/HTTP/compression, and container limits.

## Live acceptance

Coordinate the rollout/query window with other cluster owners. Before changing
IAM/RBAC, creating persistent client access or exposing routes, obtain approval for
the exact principal, resource scope and action. Use native browser OAuth and Secret
references; never export tokens, keys, kubeconfigs or Secret payloads.
For an approved public HTTPRoute, set the Gateway parent `sectionName` to its
approved HTTPS listener so the route does not intercept an HTTP redirect listener.

Record target context, active identity, namespace, existing Helm history, previous
images and candidate digest. Render and compare the candidate; avoid applying a
stale full chart over a newer release. Deploy through the existing release process
with a bounded timeout and rollback plan. Confirm exact pod image IDs, readiness,
restart counts and resource usage. A Helm write or accepted reconciliation is not
acceptance evidence.

Then verify discovery follows the observe authorization server rather than the
fleet surface, `tools/list` exposes the expected read-only tools, and wrong
audience/scope/namespace requests are denied. Run one bounded discovery and query
for each approved real signal/provider, with explicit project/workload/time/limit.
Report empty, unavailable, forbidden, partial, failed and not-run separately. Record
counts, timing, page continuation and warnings without exporting private telemetry
payloads. Avoid load testing the live cluster unless its window and query budget
are explicitly agreed.

The server catalog contains 13 tools; the bounded validation client's approved
allowlist enables eight. Record these as separate inventories. Do not infer an
eight-tool server catalog or assume how a native client's status API projects
enabled tools.

Current OAuth dynamic client registrations are process-local: use one replica and
`Recreate`, re-register after restart, and reauthenticate grants created before
client/audience binding. Self-signed tokens retain stable subject/email identity,
not original OIDC group membership. Do not rely on group-only grants for this flow.

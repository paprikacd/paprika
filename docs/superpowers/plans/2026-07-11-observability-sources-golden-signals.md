# Observability Sources and Golden Signals Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-bound ObservabilitySource CRD and secure Prometheus provider that powers normalized golden signals, fleet traffic sizing, deterministic rollout analysis, and investigator evidence.

**Architecture:** A typed provider registry resolves an Application's effective source, obtains authorized credentials, applies server-enforced PromQL correlation, and normalizes bounded query results. One provider manager owns versioned clients, caches, and limits; controllers, Connect handlers, analysis, FleetMetricsProjector, and investigator depend on narrow provider-neutral interfaces.

**Tech Stack:** Go 1.26.0, Kubernetes CRDs/controller-runtime, Prometheus HTTP API and PromQL parser, Connect RPC, OpenTelemetry, Next.js/React, TanStack Query, Vitest, envtest, Helm, kind, and Playwright.

**Approved spec:** `docs/superpowers/specs/2026-07-11-enterprise-operations-console-design.md`

**Prerequisites:** `docs/superpowers/plans/2026-07-11-enterprise-fleet-console.md` and `docs/superpowers/plans/2026-07-11-application-workspace-multicluster.md` are complete.

**Integration boundaries:** Plan 1 supplies `FleetIndex` and its request-rate lookup seam. Plan 2 supplies deterministic stage resolution plus `overview-tab.tsx` and `metrics-tab.tsx`. Plan 4 consumes the pure `SourceCheckService` with an optional ephemeral credential override for connection Test/rotation, and extends the fallible `audit.Auditor` contract introduced here across management actions and authorized events.

**Execution skills:** `@superpowers:test-driven-development`, `@security-best-practices`, `@frontend-development`, and `@superpowers:verification-before-completion`.

---

## Chunk 1: Source, Provider, and Golden-Signal UI

### File structure

- `api/observability/v1alpha1/` — ObservabilitySource API types and scheme registration only.
- `internal/metricprovider/` — provider-neutral binding, credentials, manager, limits, source checking, fleet projection, audit, and telemetry.
- `internal/metricprovider/prometheus/` — Prometheus-only endpoint policy, transport, AST scoping, response decoding, normalization, and factory.
- `internal/metricruntime/` — one provider/factory composition root shared by every API runtime.
- `internal/apicache/` — cache/client bootstrap and lifecycle shared by standalone API and Cloud Run.
- `internal/controller/observability/` — source health reconciliation; it is the only component that persists source status.
- `internal/analysis/` — public-check conversion, evaluation context, typed outcomes, legacy compatibility, and metric evaluation.
- `internal/api/signals_handler.go` — authorized application signal endpoint; no browser-supplied source or PromQL.
- `ui/src/components/applications/workspace/` — golden signals and typed analysis panels inside the Plan-2 workspace.

### Task 1: Add ObservabilitySource and declarative source bindings

**Files:**
- Create: `api/observability/v1alpha1/groupversion_info.go`
- Create: `api/observability/v1alpha1/observabilitysource_types.go`
- Create: `api/observability/v1alpha1/observabilitysource_types_test.go`
- Generate: `api/observability/v1alpha1/zz_generated.deepcopy.go`
- Modify: `api/core/v1alpha1/appproject_types.go`
- Modify: `api/pipelines/v1alpha1/application_types.go`
- Modify: `api/pipelines/v1alpha1/stage_types.go`
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/application_controller_unit_test.go`
- Modify: `cmd/main.go`
- Modify: `cmd/cloud-run/main.go`
- Modify: `PROJECT`

- [ ] **Step 1: Write failing schema tests**

Assert required local `projectRef`; provider enum `prometheus`; HTTP(S) endpoint; typed auth/TLS/query/scope/correlation/golden-signal structs; fixed auth Secret keys; bounds/defaults; and status conditions. Assert AppProject, Application, promotion-stage, and runtime Stage source references have their exact JSON tags.

- [ ] **Step 2: Run the focused red test**

Run: `rtk go test ./api/observability/v1alpha1 ./internal/controller/pipelines -run 'Test(ObservabilitySource|StageObservability)' -count=1`

Expected: FAIL because the package and fields do not exist.

- [ ] **Step 3: Implement the public API types**

Define `ObservabilitySourceSpec` with `ProjectRef`, provider, endpoint, `SourceAuth`, `SourceTLS`, `QueryLimits`, `SourceScope`, `CorrelationLabels`, and four typed `SignalDefinition` values. Only request rate accepts `fleetExpression`. Add `ApplicationObservability.SourceRef`, `AppProjectSpec.DefaultObservabilitySource`, `AppProjectSpec.AllowedCredentialSecrets`, and `ObservabilitySourceRef` to both promotion-stage and `StageSpec`.

- [ ] **Step 4: Register and propagate the types**

Register the scheme in `cmd/main.go` and `cmd/cloud-run/main.go`, add ObservabilitySource to the cached API warm-object set, and update `buildStageSpec` so the runtime Stage carries the selected promotion-stage override exactly.

- [ ] **Step 5: Generate and verify additive schemas**

Run: `rtk make manifests generate`

Expected: the new CRD/deepcopy and additive Application, Stage, and AppProject fields are generated without deleting existing schema.

- [ ] **Step 6: Run tests and commit**

Run: `rtk go test ./api/observability/v1alpha1 ./internal/controller/pipelines ./cmd/cloud-run -count=1`

```bash
rtk git add api/observability/v1alpha1/groupversion_info.go api/observability/v1alpha1/observabilitysource_types.go api/observability/v1alpha1/observabilitysource_types_test.go api/observability/v1alpha1/zz_generated.deepcopy.go api/core/v1alpha1/appproject_types.go api/core/v1alpha1/zz_generated.deepcopy.go api/pipelines/v1alpha1/application_types.go api/pipelines/v1alpha1/stage_types.go api/pipelines/v1alpha1/zz_generated.deepcopy.go internal/controller/pipelines/application_controller.go internal/controller/pipelines/application_controller_unit_test.go cmd/main.go cmd/cloud-run/main.go PROJECT config/crd/bases/observability.paprika.io_observabilitysources.yaml config/crd/bases/core.paprika.io_appprojects.yaml config/crd/bases/pipelines.paprika.io_applications.yaml config/crd/bases/pipelines.paprika.io_stages.yaml
rtk git commit -m "feat(observability): add source and binding APIs"
```

### Task 2: Define provider contracts and AST-safe PromQL compilation

**Files:**
- Create: `internal/metricprovider/types.go`
- Create: `internal/metricprovider/registry.go`
- Create: `internal/metricprovider/registry_test.go`
- Create: `internal/metricprovider/prometheus/factory.go`
- Create: `internal/metricprovider/prometheus/promql.go`
- Create: `internal/metricprovider/prometheus/promql_test.go`
- Modify: `go.mod`
- Modify: `go.sum`

- [ ] **Step 1: Write failing registry and compiler tests**

Cover duplicate/unknown factories; `${window}` only in range-duration positions; canonical duration rendering; injection of server-owned equality matchers into every vector selector; conflicting matcher rejection; label versus dedicated scope; and final serialize/reparse validation. Fleet compilation injects project only and requires configured application, namespace, project, stage, and cluster grouping labels.

- [ ] **Step 2: Run the focused red test**

Run: `rtk go test ./internal/metricprovider/... -run 'Test(Registry|Compile|Inject|Fleet)' -count=1`

Expected: FAIL because provider and Prometheus compiler packages do not exist.

- [ ] **Step 3: Add the PromQL parser without downgrading existing modules**

Run: `rtk go get github.com/prometheus/prometheus@v0.307.3 golang.org/x/time@v0.15.0`

Expected: `go.mod` records the Prometheus parser and retains the repository's existing `golang.org/x/time v0.15.0`; `rtk git diff -- go.mod go.sum` shows no `x/time` downgrade.

- [ ] **Step 4: Implement provider-neutral contracts**

Define `MetricProvider` with `Health`, `QueryInstant`, `QueryRange`, and `QueryFleetInstant`; a factory registry; canonical signal/unit enums; `SignalRequest`, `SignalResult`, `FleetSignalRequest`, `FleetSignalResult`; typed failure kinds; per-signal partial results; and capabilities. No Prometheus type may cross `internal/metricprovider`.

- [ ] **Step 5: Implement and verify AST compilation**

Parse, validate/canonicalize the window, walk every vector selector, inject enforced correlation matchers, reject conflicts, serialize, and parse once more. A source advertises `fleet` only when the compiled fleet expression groups by all five configured labels.

Run: `rtk go test ./internal/metricprovider/... -run 'Test(Registry|Compile|Inject|Fleet)' -count=1`

Expected: PASS.

- [ ] **Step 6: Commit the contracts**

```bash
rtk git add internal/metricprovider/types.go internal/metricprovider/registry.go internal/metricprovider/registry_test.go internal/metricprovider/prometheus/factory.go internal/metricprovider/prometheus/promql.go internal/metricprovider/prometheus/promql_test.go go.mod go.sum
rtk git commit -m "feat(observability): add metric provider contracts"
```

### Task 3: Enforce Prometheus endpoint, TLS, and credential policy

**Files:**
- Create: `internal/metricprovider/config.go`
- Create: `internal/metricprovider/config_test.go`
- Create: `internal/metricprovider/prometheus/endpoint.go`
- Create: `internal/metricprovider/prometheus/endpoint_test.go`
- Create: `internal/metricprovider/prometheus/transport.go`
- Create: `internal/metricprovider/prometheus/transport_test.go`
- Create: `internal/metricprovider/prometheus/auth.go`
- Create: `internal/metricprovider/prometheus/auth_test.go`

- [ ] **Step 1: Write failing runtime-configuration tests**

Test deny-all defaults, invalid booleans/CIDRs, trimming/deduplicating comma-separated values, and these exact variables: `PAPRIKA_OBSERVABILITY_PROMETHEUS_ALLOWED_DNS`, `PAPRIKA_OBSERVABILITY_PROMETHEUS_ALLOWED_CIDRS`, `PAPRIKA_OBSERVABILITY_PROMETHEUS_ALLOW_HTTP`, and `PAPRIKA_OBSERVABILITY_PROMETHEUS_ALLOW_INSECURE_SKIP_VERIFY`.

- [ ] **Step 2: Run the configuration test red**

Run: `rtk go test ./internal/metricprovider -run TestRuntimeConfig -count=1`

Expected: FAIL because `RuntimeConfigFromEnv` does not exist.

- [ ] **Step 3: Implement the exact shared configuration boundary**

```go
type PrometheusSecurityPolicy struct {
    AllowedDNSNames        []string
    AllowedCIDRs           []netip.Prefix
    AllowHTTP              bool
    AllowInsecureSkipVerify bool
}
type RuntimeConfig struct { Prometheus PrometheusSecurityPolicy }
func RuntimeConfigFromEnv(getenv func(string) string) (RuntimeConfig, error)
```

Return an error for malformed input and sort/deduplicate values so every process builds the same policy.

- [ ] **Step 4: Write failing endpoint-policy tests**

Cover deny-all, exact DNS/CIDR matches, HTTP forbidden by default, project-writer `insecureSkipVerify` rejection, URL userinfo/query/fragment rejection, and administrator-policy exceptions.

- [ ] **Step 5: Implement endpoint policy and rerun**

Accept only HTTP(S), require TLS unless policy permits HTTP, classify endpoints without retaining URLs in telemetry, and require both caller authority and global policy for insecure TLS.

Run: `rtk go test ./internal/metricprovider/... -run 'Test(RuntimeConfig|Endpoint|TLS)' -count=1`

Expected: PASS.

- [ ] **Step 6: Write failing transport/auth tests**

Test every DNS resolution and connection, second-dial rebinding, loopback/link-local/multicast/metadata denial unless explicitly allowlisted, disabled redirects, origin-bound headers, bearer/basic/mTLS fixed Secret keys, CA/server-name handling, cancellation, and redacted errors.

- [ ] **Step 7: Implement the validating transport**

Resolve and validate every address in `DialContext`, attach credentials only after origin validation, disable redirects, and ensure errors returned to non-admin callers contain neither endpoint strings nor headers.

- [ ] **Step 8: Run security tests**

Run: `rtk go test -race ./internal/metricprovider/prometheus -run 'Test(Endpoint|TLS|Transport|Auth)' -count=1`

Expected: PASS with no race or leaked-goroutine report.

- [ ] **Step 9: Commit the policy and transport**

```bash
rtk git add internal/metricprovider/config.go internal/metricprovider/config_test.go internal/metricprovider/prometheus/endpoint.go internal/metricprovider/prometheus/endpoint_test.go internal/metricprovider/prometheus/transport.go internal/metricprovider/prometheus/transport_test.go internal/metricprovider/prometheus/auth.go internal/metricprovider/prometheus/auth_test.go
rtk git commit -m "feat(observability): secure prometheus transport"
```

### Task 4: Bound Prometheus execution and normalize responses

**Files:**
- Create: `internal/metricprovider/limits.go`
- Create: `internal/metricprovider/limits_test.go`
- Create: `internal/metricprovider/prometheus/client.go`
- Create: `internal/metricprovider/prometheus/client_test.go`
- Create: `internal/metricprovider/prometheus/decode.go`
- Create: `internal/metricprovider/prometheus/decode_test.go`
- Create: `internal/metricprovider/prometheus/normalize.go`
- Create: `internal/metricprovider/prometheus/normalize_test.go`

- [ ] **Step 1: Write failing limiter tests**

Assert 30 requests/minute with burst 10 per principal/source, configured per-source concurrency, 32 global calls, timeout default 5 seconds/cap 30 seconds, seven-day ranges, minimum step `max(15s, range/1000)`, and `ResourceExhausted` retry metadata.

- [ ] **Step 2: Run the limiter test red**

Run: `rtk go test ./internal/metricprovider -run TestLimits -count=1`

Expected: FAIL because limiter acquisition and clamping are absent.

- [ ] **Step 3: Implement limit acquisition and clamping**

Acquire principal/source rate and concurrency permits before network access, release them on every exit, clamp range/step before request construction, and propagate cancellation.

- [ ] **Step 4: Rerun the limiter test green**

Run: `rtk go test ./internal/metricprovider -run TestLimits -count=1`

Expected: PASS.

- [ ] **Step 5: Write failing bounded-decode tests**

Cover interactive caps of 200 series, 1,000 points/series, and 10 MiB; fleet caps of 20,000 series and 20 MiB; early cancellation; and scalar/vector/matrix ordering.

- [ ] **Step 6: Implement bounded decoding**

Decode beneath an `io.LimitedReader`, stop once series/point limits are exceeded, cancel immediately, and return provider-neutral values.

- [ ] **Step 7: Write and satisfy normalization tests**

Test canonical units/freshness and NaN/Inf as a dashboard warning. Test `internal/analysis` rejects the warned/non-finite result in Task 12; the provider itself does not need caller-specific behavior.

Run: `rtk go test -race ./internal/metricprovider/... -run 'Test(Limits|Client|Decode|Normalize)' -count=1`

Expected: PASS.

- [ ] **Step 8: Commit bounded execution**

```bash
rtk git add internal/metricprovider/limits.go internal/metricprovider/limits_test.go internal/metricprovider/prometheus/client.go internal/metricprovider/prometheus/client_test.go internal/metricprovider/prometheus/decode.go internal/metricprovider/prometheus/decode_test.go internal/metricprovider/prometheus/normalize.go internal/metricprovider/prometheus/normalize_test.go
rtk git commit -m "feat(observability): bound and normalize metric queries"
```

### Task 5: Resolve source binding and credentials fail-closed

**Files:**
- Create: `internal/metricprovider/binding.go`
- Create: `internal/metricprovider/binding_test.go`
- Create: `internal/metricprovider/credentials.go`
- Create: `internal/metricprovider/credentials_test.go`
- Create: `internal/metricprovider/source_check.go`
- Create: `internal/metricprovider/source_check_test.go`

- [ ] **Step 1: Write failing binding tests**

Cover explicit metric check → runtime Stage → Application → AppProject precedence; same namespace; exact `(namespace,name)` project identity; project/source equality; dashboards without a source as NotConfigured; and required analysis without a source as Error.

- [ ] **Step 2: Implement the binding resolver**

Return `ResolvedSource` only after Application authorization and project/source validation. Consume Plan-2's selected-stage result so stage and cluster correlation remain server-derived.

- [ ] **Step 3: Write failing credential tests**

Cover fixed keys; same-namespace enforcement; source-owned/project-labeled or AppProject-allowlisted Secrets for project writers; global-admin external Secrets; revoked ownership/allowlist failing closed; typed copies only; and no raw Secret in errors. Exercise distinct auth and `tls.caSecretRef` Secrets, optional mTLS `ca.crt`, and either Secret rotating independently.

- [ ] **Step 4: Implement typed credential loading**

Copy only required bytes into `Credentials`, reject unsupported keys/shapes, and clear temporary buffers after provider creation where practical. Return a sorted `[]SecretVersion{Purpose, UID, ResourceVersion}` covering every auth and TLS-CA Secret; never collapse two references into one version.

- [ ] **Step 5: Define and test the pure source checker contract**

Use this exact boundary:

```go
type SourceCheckRequest struct {
    Source             *observabilityv1alpha1.ObservabilitySource
    CredentialOverride *Credentials // optional, in-memory, one call only
    Actor               string
    CorrelationID       string
    GlobalConnectionAdmin bool
}

type SourceCheckService interface {
    Check(context.Context, SourceCheckRequest) (SourceCheckResult, error)
}
```

The service validates fields, endpoint/auth policy, dedicated-scope/insecure-TLS authority, both expressions, health, live fleet labels, latency, and capabilities. Plan 4 sets `GlobalConnectionAdmin` from its composed authorizer; controller reconciliation sets it for already-admitted declarative resources, while provider transport still enforces the global Helm policy. An override bypasses Secret reads and provider/client/result caches, never mutates source status, is cleared by the caller after use, and is the Plan-4 Test/rotation seam.

- [ ] **Step 6: Run and commit**

Run: `rtk go test ./internal/metricprovider -run 'Test(Binding|Credentials|SourceCheck)' -count=1`

Expected: PASS, including tests proving the override causes no Secret read, cache entry, or status write and that auth/CA rotations produce different complete version sets.

```bash
rtk git add internal/metricprovider/binding.go internal/metricprovider/binding_test.go internal/metricprovider/credentials.go internal/metricprovider/credentials_test.go internal/metricprovider/source_check.go internal/metricprovider/source_check_test.go
rtk git commit -m "feat(observability): resolve project-bound sources"
```

### Task 6: Validate ObservabilitySource admission

**Files:**
- Create: `internal/webhook/observability/v1alpha1/observabilitysource_webhook.go`
- Create: `internal/webhook/observability/v1alpha1/observabilitysource_webhook_test.go`
- Create: `internal/webhook/observability/v1alpha1/webhook_suite_test.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Write failing webhook tests**

Reject invalid provider/auth/TLS combinations, missing label-scope correlation, malformed expressions, conflicting matchers, incomplete fleet grouping, out-of-range limits, and cross-namespace Secret references. Paprika caller authority is enforced by Plan 4 before the API service account writes the CR; direct Kubernetes CRUD is governed by Kubernetes RBAC and treated as declarative administrator input.

- [ ] **Step 2: Run the red test**

Run: `rtk go test ./internal/webhook/observability/... -count=1`

Expected: FAIL because the webhook is not registered.

- [ ] **Step 3: Implement and register admission**

Keep admission side-effect free. Register `SetupObservabilitySourceWebhookWithManager` in the exact webhook list in `cmd/main_controllers.go`.

- [ ] **Step 4: Run and commit**

Run: `rtk go test ./internal/webhook/observability/... ./cmd -run 'Test.*Observability' -count=1`

```bash
rtk git add internal/webhook/observability/v1alpha1/observabilitysource_webhook.go internal/webhook/observability/v1alpha1/observabilitysource_webhook_test.go internal/webhook/observability/v1alpha1/webhook_suite_test.go cmd/main_controllers.go
rtk git commit -m "feat(observability): validate source admission"
```

### Task 7: Reconcile source health without leaking credentials

**Files:**
- Create: `internal/controller/observability/observabilitysource_controller.go`
- Create: `internal/controller/observability/observabilitysource_controller_test.go`
- Create: `internal/controller/observability/suite_test.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Write failing envtest reconciliation cases**

Cover required AppProject ownership, allowed/owned Secret enforcement, Healthy/Degraded phases, observedGeneration, capabilities, response time, check timestamp, deletion, independent auth-Secret and TLS-CA-Secret rotation, and redacted messages.

- [ ] **Step 2: Run the red envtest**

Run: `rtk go test ./internal/controller/observability/... -count=1`

Expected: FAIL because the reconciler is absent.

- [ ] **Step 3: Implement the controller**

Call `SourceCheckService` without an override, persist only observedGeneration, phase, conditions, capabilities, response time, timestamp, and redacted message, and index/watch every referenced auth or TLS-CA Secret plus AppProject changes.

- [ ] **Step 4: Register, verify, and commit**

Run: `rtk go test ./internal/controller/observability/... ./cmd -run 'Test.*Observability' -count=1`

```bash
rtk git add internal/controller/observability/observabilitysource_controller.go internal/controller/observability/observabilitysource_controller_test.go internal/controller/observability/suite_test.go cmd/main_controllers.go
rtk git commit -m "feat(observability): reconcile source health"
```

### Task 8: Add versioned caches and fleet request-rate projection

**Files:**
- Create: `internal/metricprovider/manager.go`
- Create: `internal/metricprovider/manager_test.go`
- Create: `internal/metricprovider/fleet_projector.go`
- Create: `internal/metricprovider/fleet_projector_test.go`
- Create: `internal/metricprovider/fleet_source_adapter.go`
- Create: `internal/metricprovider/fleet_source_adapter_test.go`
- Create: `internal/metricruntime/runtime.go`
- Create: `internal/metricruntime/runtime_test.go`
- Create: `internal/apicache/bootstrap.go`
- Create: `internal/apicache/bootstrap_test.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_test.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/cloud-run/main.go`
- Create: `cmd/cloud-run/main_test.go`
- Modify: `internal/fleet/query.go`
- Modify: `internal/fleet/query_test.go`

- [ ] **Step 1: Write failing client/result-cache tests**

Assert client identity is `{source UID, source resourceVersion, sorted [{purpose, Secret UID, Secret resourceVersion}]}` and changes when either auth or TLS-CA Secret rotates/deletes. Assert result keys contain that full client identity plus provider, signal, correlation, start/end/step/window; also cover bounded LRU/TTL, singleflight, and cancellation.

- [ ] **Step 2: Run the cache test red**

Run: `rtk go test ./internal/metricprovider -run 'TestManager.*(Identity|Cache|Invalidation)' -count=1`

Expected: FAIL because the manager cache is absent.

- [ ] **Step 3: Implement and rerun bounded manager caches**

Use a dedicated size-bounded LRU/TTL, not `internal/cache/memory.go`; invalidate clients/results from indexed source, auth-Secret, and TLS-CA-Secret informer events. Never cache an override path.

Run: `rtk go test ./internal/metricprovider -run 'TestManager.*(Identity|Cache|Invalidation)' -count=1`

Expected: PASS, including independent CA rotation.

- [ ] **Step 4: Write and run the failing Plan-1 adapter tests**

Test that `Prototype` returns ObservabilitySource, summaries contain bounded phase/capabilities only, bindings apply Stage→Application→AppProject precedence/local-project checks, and source/project changes or deletes recompute only reverse-dependent Applications.

Run: `rtk go test ./internal/metricprovider ./internal/fleet -run 'TestFleetSourceAdapter' -count=1`

Expected: FAIL because the adapter is absent.

- [ ] **Step 5: Implement and register the optional source adapter**

Implement `fleet.OptionalSourceProjector` in `fleet_source_adapter.go`, pass it into Plan 1's pre-cache informer registration, rerun the focused test, and require PASS.

- [ ] **Step 6: Write failing request-rate projector tests**

Assert one query/source every 60 seconds with jitter; the exact key `(project namespace, project, application namespace, application, stage, cluster)`; current-stage weight without target filters; matching-target sum with filters; exact Matrix target weight; 20,000-series/20-MiB caps; and stale/missing resource-count fallback markers.

- [ ] **Step 7: Implement FleetMetricsProjector and rerun**

Refresh only healthy sources with validated `fleet` capability and expose a read-only lookup to FleetIndex. Never issue per-Application metric queries.

Run: `rtk go test ./internal/metricprovider ./internal/fleet -run 'Test(FleetProjector|RequestRateWeight)' -count=1`

Expected: PASS.

- [ ] **Step 8: Write failing shared cached-API bootstrap tests**

Define tests for `apicache.New(config, scheme, syncTimeout)` returning one unstarted controller-runtime `Cache`, cache-backed `Client`, and informer source. Assert callers can register handlers before `Start`, `Start` is single-use, `WaitForSync` is cancelable, readiness stays false until sync, shutdown joins the cache goroutine, and disabled mode carries an explicit enterprise-unavailable reason without constructing a direct-read fallback.

- [ ] **Step 9: Implement the shared bootstrap and rerun**

`internal/apicache/bootstrap.go` owns cache/client construction and lifecycle only; it does not import fleet or metric packages. Expose `InformerSource() cache.Cache`, `Client() client.Client`, `Start(ctx) error`, `WaitForSync(ctx) error`, and `Ready() (bool, string)`. Refactor Plan 1's standalone cache creation in `cmd/main.go` onto this package.

Run: `rtk go test ./internal/apicache ./cmd -run 'Test(APICacheBootstrap|APICacheLifecycle)' -count=1`

Expected: PASS and no cache goroutine survives cancellation.

- [ ] **Step 10: Write failing construction tests for all API runtimes**

Table-test operator, standalone `--mode=api`, and `cmd/cloud-run`: each calls `metricprovider.RuntimeConfigFromEnv`, registers exactly one Prometheus factory, constructs binding/credential manager, source checker, and projector, and supplies a real informer source. Cloud Run must use `apicache.New`, not its current direct client. Deny-all defaults reach the factory; malformed env fails startup before any dial.

- [ ] **Step 11: Add the shared metric runtime composition root**

`metricruntime.New(reader, informerSource, auditor, cfg)` returns `{Manager, SourceChecker, FleetProjector, FleetSourceAdapter}` and is the only place that calls `prometheus.NewFactory(cfg.Prometheus)`. Keep network calls lazy until health/query/projector work begins.

- [ ] **Step 12: Wire lifecycle and readiness in all three runtimes**

Operator uses `mgr.GetCache()`: construct the metric runtime, pass its adapter to Plan 1's fleet runtime, register both before `mgr.Start`, and add runnables/readiness checks through the manager. Standalone API and Cloud Run both use `apicache`: construct metric runtime and fleet runtime, register metric invalidators plus fleet handlers before `Bundle.Start`, run cache/fleet/manager/projector under one cancelable error group, wait for cache sync and FleetIndex initial install, then make `/readyz` and HTTP startup ready. Add Cloud Run's `--api-cache-enabled`/`PAPRIKA_API_CACHE_ENABLED` and sync-timeout parity; disabled mode serves legacy RPCs but injects the explicit unavailable readers and never performs enterprise direct reads.

- [ ] **Step 13: Run runtime, readiness, and shutdown tests**

Run: `rtk go test -race ./internal/apicache ./internal/metricprovider ./internal/metricruntime ./internal/fleet ./cmd ./cmd/cloud-run -run 'Test(Runtime|Manager|Cache|FleetProjector|RequestRateWeight|ObservabilityWiring|CloudRunReadiness)' -count=1`

Expected: PASS in all runtimes; readiness order and graceful cancellation are deterministic.

- [ ] **Step 14: Commit runtime construction**

```bash
rtk git add internal/metricprovider/manager.go internal/metricprovider/manager_test.go internal/metricprovider/fleet_projector.go internal/metricprovider/fleet_projector_test.go internal/metricprovider/fleet_source_adapter.go internal/metricprovider/fleet_source_adapter_test.go internal/metricruntime/runtime.go internal/metricruntime/runtime_test.go internal/apicache/bootstrap.go internal/apicache/bootstrap_test.go internal/fleet/query.go internal/fleet/query_test.go cmd/main.go cmd/main_test.go cmd/main_operator.go cmd/cloud-run/main.go cmd/cloud-run/main_test.go
rtk git commit -m "feat(observability): cache and project fleet signals"
```

### Task 9: Add fallible audit delivery and low-cardinality OTel telemetry

**Files:**
- Modify: `internal/audit/audit.go`
- Modify: `internal/audit/audit_test.go`
- Modify: `internal/api/audit_middleware.go`
- Modify: `internal/api/audit_middleware_test.go`
- Modify: `internal/clusteraccess/warnings.go`
- Modify: `internal/clusteraccess/warnings_test.go`
- Modify: `internal/metrics/otel.go`
- Create: `internal/metricprovider/telemetry.go`
- Create: `internal/metricprovider/telemetry_test.go`
- Create: `internal/metricprovider/audit.go`
- Create: `internal/metricprovider/audit_test.go`

- [ ] **Step 1: Make audit sink failures observable**

Change `Auditor.Record(context.Context, Event)` to return `error`; update `LogAuditor`, `NoopAuditor`, the API interceptor, Plan 2's legacy-cluster warning recorder, and tests. A sink failure increments the OTel `audit_sink_failures` counter with record-type only, logs once through the fallback process logger, and never reverses or fails an already-completed query/action. Plan 4 extends this contract to every management mutation and operational action.

- [ ] **Step 2: Write failing provider telemetry tests**

Use OTel metric/span recorders to require health/query spans and provider-health, duration, failure-kind, series-count bucket, truncation, and cache-outcome metrics. Reject source/application/project names, endpoint URLs, credentials, PromQL, and raw filters from metric/span attributes.

- [ ] **Step 3: Implement the OTel wrapper**

Use the existing `otel.Meter("paprika")` and tracer only; add no direct-Prometheus instrument. Attributes are bounded provider type, signal enum, failure kind, result-count bucket, truncation, endpoint class, and cache outcome.

- [ ] **Step 4: Write failing audit-record tests**

For source health/Test and metric queries, record actor, project, source resource, action, outcome, correlation ID, signal, safe endpoint class/scheme, exact latency/result count, cache outcome, and failure kind. `insecureSkipVerify` emits a warning record. Assert no raw endpoint, PromQL, credentials, expanded headers, or application name enters audit extras.

- [ ] **Step 5: Implement provider audit recording**

Record after authorization and completion; source-controller checks use a system actor while API/Plan-4 calls pass caller actor and correlation ID. Audit failure follows Step 1 and does not alter provider outcome.

- [ ] **Step 6: Run and commit**

Run: `rtk go test ./internal/audit ./internal/api ./internal/metricprovider -run 'Test(Audit|Telemetry)' -count=1`

```bash
rtk git add internal/audit/audit.go internal/audit/audit_test.go internal/api/audit_middleware.go internal/api/audit_middleware_test.go internal/clusteraccess/warnings.go internal/clusteraccess/warnings_test.go internal/metrics/otel.go internal/metricprovider/telemetry.go internal/metricprovider/telemetry_test.go internal/metricprovider/audit.go internal/metricprovider/audit_test.go
rtk git commit -m "feat(observability): audit and trace provider calls"
```

### Task 10: Expose authorized application golden signals

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Generate: `internal/api/paprika/v1/api.pb.go`
- Generate: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generate: `ui/src/gen/paprika/v1/api_pb.js`
- Generate: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generate: `ui/src/gen/paprika/v1/api_connect.js`
- Generate: `ui/src/gen/paprika/v1/api_connect.d.ts`
- Create: `internal/api/signals_handler.go`
- Create: `internal/api/signals_handler_test.go`
- Modify: `internal/api/server.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/cloud-run/main.go`
- Modify: `cmd/cloud-run/main_test.go`

- [ ] **Step 1: Write a failing RPC descriptor test**

Assert `QueryApplicationSignals` is unary and its request has Application identity, selected stage, signal enums, start/end/step/window only—never source identity or PromQL.

- [ ] **Step 2: Add the additive RPC contract and regenerate**

Add signal enums, points/series/warnings/errors, source status, and distinct result-state enum values, then run `rtk make generate-proto`.

Expected: generated Go/JS/DTS clients contain the new RPC and existing field numbers remain unchanged.

- [ ] **Step 3: Write failing authorization/result-state tests**

Prove authorization precedes source lookup, Secret access, template expansion, and network access. Cover server-derived stage/cluster, effective binding, independent signal failures, units/freshness, and distinct zero/NoData/NotConfigured/Stale/Unavailable states.

- [ ] **Step 4: Run the handler test red**

Run: `rtk go test ./internal/api -run TestQueryApplicationSignals -count=1`

Expected: FAIL because the handler is not implemented.

- [ ] **Step 5: Implement the authorized handler**

Add a narrow `WithMetricProviderManager` option. Resolve Application authorization and Plan-2 stage/cluster first, then query. Map provider failures per signal; fail the RPC only for invalid request, authorization, or missing Application. Pass actor/project/correlation into provider audit.

- [ ] **Step 6: Write failing three-runtime server-injection tests**

Assert operator, standalone API, and Cloud Run pass the exact runtime `Manager` to `WithMetricProviderManager`; a configured fake source succeeds in all three, while cache-disabled mode returns `Unavailable` with the configuration reason.

- [ ] **Step 7: Inject the handler dependency in all runtimes**

Update the three composition roots without constructing a second manager or parsing security configuration again.

- [ ] **Step 8: Run API and wiring tests**

Run: `rtk go test ./internal/api ./cmd ./cmd/cloud-run -run 'Test(QueryApplicationSignals|MetricProviderWiring|CloudRunMetricProviderWiring)' -count=1`

Expected: PASS.

- [ ] **Step 9: Commit the RPC**

```bash
rtk git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go internal/api/signals_handler.go internal/api/signals_handler_test.go internal/api/server.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts cmd/main.go cmd/main_operator.go cmd/cloud-run/main.go cmd/cloud-run/main_test.go
rtk git commit -m "feat(api): expose application golden signals"
```

### Task 11: Render golden signals in the Plan-2 workspace

**Files:**
- Create: `ui/src/lib/application-signals.ts`
- Create: `ui/src/lib/application-signals.test.ts`
- Create: `ui/src/components/applications/workspace/golden-signals-panel.tsx`
- Create: `ui/src/components/applications/workspace/golden-signals-panel.test.tsx`
- Modify: `ui/src/components/applications/workspace/overview-tab.tsx`
- Modify: `ui/src/components/applications/workspace/metrics-tab.tsx`

- [ ] **Step 1: Write failing state and accessibility tests**

Cover four cards/charts, source health, short Overview range, selectable Metrics range, independent partial failures, zero versus NoData/NotConfigured/Stale/Unavailable copy, timestamps, numeric units, live-region behavior, and absence of source/PromQL controls.

- [ ] **Step 2: Run the red UI tests**

Run: `rtk npm --prefix ui test -- --run src/lib/application-signals.test.ts src/components/applications/workspace/golden-signals-panel.test.tsx`

Expected: FAIL because the adapter/panel do not exist.

- [ ] **Step 3: Implement lazy stage-aware queries**

Use Plan-1 TanStack Query and Plan-2 `stage` URL state. Abort on stage/range change; keep successful signals visible when siblings fail; render source timestamps and retry controls.

- [ ] **Step 4: Run and commit**

Run: `rtk npm --prefix ui test -- --run src/lib/application-signals.test.ts src/components/applications/workspace/golden-signals-panel.test.tsx`

```bash
rtk git add ui/src/lib/application-signals.ts ui/src/lib/application-signals.test.ts ui/src/components/applications/workspace/golden-signals-panel.tsx ui/src/components/applications/workspace/golden-signals-panel.test.tsx ui/src/components/applications/workspace/overview-tab.tsx ui/src/components/applications/workspace/metrics-tab.tsx
rtk git commit -m "feat(ui): render application golden signals"
```

## Chunk 2: Analysis, Packaging, and Acceptance

### Task 12: Define typed analysis schema, outcomes, and evaluation context

**Files:**
- Modify: `api/pipelines/v1alpha1/stage_types.go`
- Modify: `api/rollouts/v1alpha1/rollout_types.go`
- Modify: `api/pipelines/v1alpha1/analysis_run_types.go`
- Create: `internal/analysis/check.go`
- Create: `internal/analysis/conversion.go`
- Create: `internal/analysis/conversion_test.go`
- Create: `internal/analysis/context.go`
- Create: `internal/analysis/context_test.go`
- Create: `internal/analysis/metric.go`
- Create: `internal/analysis/metric_test.go`
- Modify: `internal/analysis/analysis.go`
- Modify: `internal/analysis/substitute.go`
- Modify: `internal/controller/pipelines/analyzer.go`

- [ ] **Step 1: Lock the two public wire schemas with a failing reflection test**

Both `AnalysisCheck` types add `type: metric` and nested `metric` with identical JSON fields/tags: `sourceRef`, `signal`, `mode` (`range` default or `instant`), `comparator`, `threshold`, `rangeSeconds`, `stepSeconds`, `timeReducer`, `seriesReducer`, `maxSampleAgeSeconds`, and `noDataPolicy`. Defaults are range, last, max, 120 seconds, and Error; enums/bounds match the spec.

- [ ] **Step 2: Run the schema test red**

Run: `rtk go test ./internal/analysis -run TestPublicCheckSchemaEquivalence -count=1`

Expected: FAIL because metric fields and conversion do not exist.

- [ ] **Step 3: Add the two equivalent public check schemas**

Add the fields/markers to both API packages and implement conversion stubs that reject unknown enums; do not import one API package from the other.

- [ ] **Step 4: Add additive result fields and regenerate schemas**

Keep legacy `passed` for compatibility and add `outcome`, optional `value`, `unit`, `observedAt`, and `detail` to AnalysisRun results. `passed` is true only for `OutcomePass`.

Run: `rtk make manifests generate`

Expected: deepcopy and CRDs add fields without removing existing schema.

- [ ] **Step 5: Write failing evaluation-context tests**

Cover AnalysisRun, Release, and Rollout ownership; selected/default stage; canonical in-cluster identity; and missing/mismatched Application, project, Stage, or Cluster failures.

- [ ] **Step 6: Implement the exact internal boundary**

```go
type EvaluationContext struct {
    Application types.NamespacedName
    Project     types.NamespacedName
    Stage       string
    Cluster     types.NamespacedName
}

type Analyzer interface {
    RunChecks(context.Context, analysis.EvaluationContext, []pipelinesv1alpha1.AnalysisCheck) []analysis.Result
}
```

`context.go` loads the Application referenced by an AnalysisRun/Release/Rollout, represents Application, AppProject, and resolved Cluster identities as namespace/name pairs, uses Plan-2 stage resolution, and fails closed if project, selected Stage, or derived cluster is unavailable. `Cluster` is copied from `clusteraccess.ResolvedCluster.Identity`, including its canonical in-cluster identity; controllers never construct correlation from user-supplied cluster input.

- [ ] **Step 7: Run context tests green**

Run: `rtk go test ./internal/analysis -run TestEvaluationContext -count=1`

Expected: PASS.

- [ ] **Step 8: Write failing evaluator tests**

Cover instant/range, time/series reducers, multiplier/unit conversion, every comparator, 120-second freshness, NoData Error/Fail, provider Error, recovery, warned NaN/Inf rejection, and explicit context passed into binding/query resolution.

- [ ] **Step 9: Implement typed outcomes, conversion, and metric evaluation**

Define Pass/Fail/Error/NoData with value/unit/observedAt/detail. Convert both public check shapes to one internal Check. Inject binding resolver and narrow metric querier into the analyzer; keep HTTP and legacy pod checks behind adapters.

- [ ] **Step 10: Run analysis tests**

Run: `rtk go test ./internal/analysis ./api/pipelines/v1alpha1 ./api/rollouts/v1alpha1 -count=1`

Expected: PASS.

- [ ] **Step 11: Commit typed analysis**

```bash
rtk git add api/pipelines/v1alpha1/stage_types.go api/pipelines/v1alpha1/analysis_run_types.go api/pipelines/v1alpha1/zz_generated.deepcopy.go api/rollouts/v1alpha1/rollout_types.go api/rollouts/v1alpha1/zz_generated.deepcopy.go internal/analysis/check.go internal/analysis/conversion.go internal/analysis/conversion_test.go internal/analysis/context.go internal/analysis/context_test.go internal/analysis/metric.go internal/analysis/metric_test.go internal/analysis/analysis.go internal/analysis/substitute.go internal/controller/pipelines/analyzer.go config/crd/bases/pipelines.paprika.io_stages.yaml config/crd/bases/pipelines.paprika.io_analysistemplates.yaml config/crd/bases/pipelines.paprika.io_analysisruns.yaml config/crd/bases/rollouts.paprika.io_rollouts.yaml
rtk git commit -m "feat(analysis): define typed metric outcomes"
```

### Task 13: Integrate typed outcomes with pipeline AnalysisRun and Release

**Files:**
- Modify: `internal/controller/pipelines/analysisrun_controller.go`
- Modify: `internal/controller/pipelines/analysisrun_controller_test.go`
- Modify: `internal/controller/pipelines/analysis_manager.go`
- Modify: `internal/controller/pipelines/application_controller_unit_test.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/pipelines/release_controller_unit_test.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Write failing AnalysisRun mapping tests**

Load `ApplicationRef`, derive current/default Stage through the shared context resolver, and assert Pass→Successful, threshold/explicit-NoData Fail→Failed, and Error/NoData→Error while preserving all typed result fields.

- [ ] **Step 2: Write failing Release behavior tests**

Assert threshold Fail follows the configured failure action. Provider Error or NoData(Error policy) adds `AnalysisError`, leaves rollback/failure-action calls at zero, pauses promotion, and requeues for recovery. A later Pass resumes.

- [ ] **Step 3: Inject the context resolver and metric-enabled analyzer**

Construct one analyzer in `cmd/main_controllers.go` with provider-manager, binding, and stage-resolution dependencies; pass explicit `EvaluationContext` to every RunChecks call.

- [ ] **Step 4: Implement controller mappings**

No controller may infer `!Passed == threshold failure`. Application aggregation preserves AnalysisRun Error separately from Failed.

- [ ] **Step 5: Run and commit**

Run: `rtk go test ./internal/controller/pipelines ./cmd -run 'Test(AnalysisRun|Release.*Analysis|Application.*Analysis)' -count=1`

```bash
rtk git add internal/controller/pipelines/analysisrun_controller.go internal/controller/pipelines/analysisrun_controller_test.go internal/controller/pipelines/analysis_manager.go internal/controller/pipelines/application_controller_unit_test.go internal/controller/pipelines/release_controller.go internal/controller/pipelines/release_controller_unit_test.go cmd/main_controllers.go
rtk git commit -m "feat(analysis): enforce pipeline metric outcomes"
```

### Task 14: Integrate rollout outcomes and render analysis states

**Files:**
- Modify: `internal/controller/rollouts/rollout_controller.go`
- Modify: `internal/controller/rollouts/rollout_controller_test.go`
- Modify: `proto/paprika/v1/api.proto`
- Modify: `internal/api/server.go`
- Modify: `internal/api/analysis_handler_test.go`
- Modify: `internal/api/rollout_handler_test.go`
- Generate: `internal/api/paprika/v1/api.pb.go`
- Generate: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generate: `ui/src/gen/paprika/v1/api_pb.js`
- Generate: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generate: `ui/src/gen/paprika/v1/api_connect.js`
- Generate: `ui/src/gen/paprika/v1/api_connect.d.ts`
- Create: `ui/src/components/applications/workspace/analysis-results-panel.tsx`
- Create: `ui/src/components/applications/workspace/analysis-results-panel.test.tsx`
- Modify: `ui/src/components/applications/workspace/overview-tab.tsx`
- Modify: `ui/src/components/applications/workspace/metrics-tab.tsx`

- [ ] **Step 1: Write failing rollout mapping tests**

Assert threshold/no-data Fail writes `AnalysisFailed` and follows failure action, while provider Error/NoData(Error policy) writes `AnalysisError`, pauses without rollback, and can recover to Pass.

- [ ] **Step 2: Implement rollout context and mapping**

Resolve Application/project/stage/cluster from rollout ownership/labels and the runtime Stage; remove the lossy rollout→pipeline boolean conversion.

- [ ] **Step 3: Add typed proto mapping and regenerate**

Expose outcome/value/unit/observed timestamp additively for AnalysisRun and rollout-analysis results.

Run: `rtk make generate`

- [ ] **Step 4: Write failing workspace tests**

Render Pass, threshold Fail, provider Error, NoData, stale, and mixed partial results with text/icon semantics, values/units/timestamps, and non-blocking golden-signal siblings in both Overview and Metrics.

- [ ] **Step 5: Implement UI and run tests**

Run: `rtk go test ./internal/controller/rollouts ./internal/api -run 'Test(Rollout.*Analysis|.*Analysis.*Mapping)' -count=1`

Run: `rtk npm --prefix ui test -- --run src/components/applications/workspace/analysis-results-panel.test.tsx src/components/applications/workspace/golden-signals-panel.test.tsx`

- [ ] **Step 6: Commit rollout/UI integration**

```bash
rtk git add internal/controller/rollouts/rollout_controller.go internal/controller/rollouts/rollout_controller_test.go proto/paprika/v1/api.proto internal/api/server.go internal/api/analysis_handler_test.go internal/api/rollout_handler_test.go internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts ui/src/components/applications/workspace/analysis-results-panel.tsx ui/src/components/applications/workspace/analysis-results-panel.test.tsx ui/src/components/applications/workspace/overview-tab.tsx ui/src/components/applications/workspace/metrics-tab.tsx
rtk git commit -m "feat(analysis): surface rollout metric outcomes"
```

### Task 15: Gate unsafe legacy analysis with preflight and audited compatibility

**Files:**
- Create: `internal/analysis/preflight.go`
- Create: `internal/analysis/preflight_test.go`
- Create: `internal/analysis/legacy.go`
- Create: `internal/analysis/legacy_test.go`
- Modify: `internal/analysis/analysis.go`
- Modify: `internal/controller/pipelines/analyzer.go`
- Modify: `internal/controller/pipelines/analysisrun_controller.go`
- Modify: `internal/controller/pipelines/analysisrun_controller_test.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/pipelines/release_controller_unit_test.go`
- Modify: `internal/controller/rollouts/rollout_controller.go`
- Modify: `internal/controller/rollouts/rollout_controller_test.go`
- Modify: `internal/metrics/otel.go`
- Create: `cmd/main_analysis_preflight.go`
- Create: `cmd/main_analysis_preflight_test.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_test.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/main_controllers.go`
- Create: `cmd/main_controllers_analysis_test.go`
- Create: `charts/chart/templates/hooks/pre-upgrade-analysis-check.yaml`
- Create: `charts/chart/templates/hooks/pre-upgrade-analysis-check-rbac.yaml`
- Modify: `charts/chart/templates/manager/manager.yaml`
- Modify: `charts/chart/templates/manager/statefulset.yaml`
- Modify: `charts/chart/values.yaml`

- [ ] **Step 1: Write failing inventory tests**

Enumerate every legacy `podMetrics` check in AnalysisTemplate, Application promotion stages, runtime Stage, and Rollout with stable resource/check paths. No findings exits zero; strict findings exit nonzero; compatibility findings warn.

- [ ] **Step 2: Write failing compatibility-use tests**

With `analysis.allowLegacyAssumePass=false`, unavailable latency/restart/error legacy metrics return Error. When true, only checks returned by the legacy detector may assume old behavior; native `type: metric`, unknown checks, and non-detected errors never pass.

- [ ] **Step 3: Write failing controller-composition tests**

Construct operator dependencies with a fake `audit.Auditor` and both flag values. Assert `setupPipelineControllers` builds one analyzer with the exact `AllowLegacyAssumePass` value and injects the same analyzer/auditor-backed legacy-use recorder into AnalysisRun, Release, and Rollout controllers. Assert one detected assumption produces exactly one warning condition, audit call, and bounded OTel increment; an audit-sink error leaves the already-computed outcome unchanged.

- [ ] **Step 4: Implement typed compatibility reporting and injection**

Every assumed pass returns `LegacyAssumptionUsed` metadata. Add `analysis.AnalyzerOptions{AllowLegacyAssumePass bool, Auditor audit.Auditor, LegacyUseRecorder LegacyUseRecorder}` without package globals. Parse the flag once in `cmd/main.go`; `cmd/main_operator.go` stores the process-scoped Auditor and options in operator dependencies; `cmd/main_controllers.go` passes them into the shared analyzer and all three controllers. The recorder writes the controller's warning condition, audit event, and one OTel counter labeled only by resource kind/legacy metric enum.

- [ ] **Step 5: Add the preflight mode and Helm hook**

Add `analysis-preflight` to mode validation. Default the flag false, pass it only to manager/controller containers, and give the hook read-only access to AnalysisTemplates, Applications, Stages, and Rollouts.

- [ ] **Step 6: Verify Helm, wiring, and runtime behavior**

Run: `rtk go test ./internal/analysis ./internal/controller/pipelines ./internal/controller/rollouts ./cmd -run 'Test.*(Legacy|Preflight|AnalysisControllerWiring)' -count=1`

Run: `rtk helm lint charts/chart`

Run: `rtk helm template paprika charts/chart --set analysis.allowLegacyAssumePass=true`

Expected: tests pass and rendered output contains the pre-upgrade hook, read-only RBAC, and explicit compatibility environment value.

- [ ] **Step 7: Commit the migration gate**

```bash
rtk git add internal/analysis/preflight.go internal/analysis/preflight_test.go internal/analysis/legacy.go internal/analysis/legacy_test.go internal/analysis/analysis.go internal/controller/pipelines/analyzer.go internal/controller/pipelines/analysisrun_controller.go internal/controller/pipelines/analysisrun_controller_test.go internal/controller/pipelines/release_controller.go internal/controller/pipelines/release_controller_unit_test.go internal/controller/rollouts/rollout_controller.go internal/controller/rollouts/rollout_controller_test.go internal/metrics/otel.go cmd/main_analysis_preflight.go cmd/main_analysis_preflight_test.go cmd/main.go cmd/main_test.go cmd/main_operator.go cmd/main_controllers.go cmd/main_controllers_analysis_test.go charts/chart/templates/hooks/pre-upgrade-analysis-check.yaml charts/chart/templates/hooks/pre-upgrade-analysis-check-rbac.yaml charts/chart/templates/manager/manager.yaml charts/chart/templates/manager/statefulset.yaml charts/chart/values.yaml
rtk git commit -m "feat(analysis): gate unsafe legacy checks"
```

### Task 16: Feed provider-neutral metrics into investigations

**Files:**
- Modify: `internal/investigator/registry.go`
- Modify: `internal/investigator/registry_default.go`
- Modify: `internal/investigator/registry_test.go`
- Create: `internal/investigator/metric_source.go`
- Create: `internal/investigator/metric_source_test.go`
- Modify: `internal/api/investigator_handler.go`
- Modify: `internal/api/investigator_handler_test.go`
- Modify: `internal/api/server.go`
- Modify: `proto/paprika/v1/api.proto`
- Generate: `internal/api/paprika/v1/api.pb.go`
- Generate: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generate: `ui/src/gen/paprika/v1/api_pb.js`
- Generate: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generate: `ui/src/gen/paprika/v1/api_connect.js`
- Generate: `ui/src/gen/paprika/v1/api_connect.d.ts`
- Modify: `ui/src/components/dashboard/investigation-panel.tsx`
- Modify: `ui/src/components/dashboard/investigation-panel.test.tsx`
- Modify: `ui/src/components/dashboard/investigation-triage.tsx`
- Modify: `ui/src/components/dashboard/investigation-triage.test.tsx`

- [ ] **Step 1: Write failing evidence/warning tests**

Assert four normalized signals reach detectors through `Input.Evidence`, source failures become typed warnings, partial metric failure retains Kubernetes findings, selected stage/cluster comes from Plan-2 gateway context, and no Prometheus type enters investigator interfaces.

- [ ] **Step 2: Refactor registry injection**

Install collected evidence before detector fan-out and replace the package-global API registry with an injected registry built from provider-neutral queriers.

- [ ] **Step 3: Add response/UI warnings**

Extend the response with source warnings, regenerate clients, and render a non-blocking warning live region distinct from findings.

- [ ] **Step 4: Run and commit**

Run: `rtk go test ./internal/investigator ./internal/api -run 'Test(Investigat|MetricSource|Registry)' -count=1`

Run: `rtk npm --prefix ui test -- --run investigation-panel investigation-triage`

```bash
rtk git add internal/investigator/registry.go internal/investigator/registry_default.go internal/investigator/registry_test.go internal/investigator/metric_source.go internal/investigator/metric_source_test.go internal/api/investigator_handler.go internal/api/investigator_handler_test.go internal/api/server.go proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts ui/src/components/dashboard/investigation-panel.tsx ui/src/components/dashboard/investigation-panel.test.tsx ui/src/components/dashboard/investigation-triage.tsx ui/src/components/dashboard/investigation-triage.test.tsx
rtk git commit -m "feat(investigator): add golden-signal evidence"
```

### Task 17: Package CRDs, RBAC, webhooks, and network policy

**Files:**
- Generate: `config/crd/bases/observability.paprika.io_observabilitysources.yaml`
- Generate: `config/crd/bases/core.paprika.io_appprojects.yaml`
- Generate: `config/crd/bases/pipelines.paprika.io_applications.yaml`
- Generate: `config/crd/bases/pipelines.paprika.io_stages.yaml`
- Generate: `config/crd/bases/pipelines.paprika.io_analysistemplates.yaml`
- Generate: `config/crd/bases/pipelines.paprika.io_analysisruns.yaml`
- Generate: `config/crd/bases/rollouts.paprika.io_rollouts.yaml`
- Generate: `config/rbac/observability_observabilitysource_admin_role.yaml`
- Generate: `config/rbac/observability_observabilitysource_editor_role.yaml`
- Generate: `config/rbac/observability_observabilitysource_viewer_role.yaml`
- Modify: `config/rbac/role.yaml`
- Modify: `config/rbac/kustomization.yaml`
- Modify: `config/webhook/manifests.yaml`
- Modify: `config/api-server/deployment.yaml`
- Modify: `config/manager/manager.yaml`
- Modify: `config/manager/statefulset.yaml`
- Create: `charts/chart/templates/crd/observabilitysources.observability.paprika.io.yaml`
- Modify: `charts/chart/templates/crd/appprojects.core.paprika.io.yaml`
- Modify: `charts/chart/templates/crd/applications.pipelines.paprika.io.yaml`
- Modify: `charts/chart/templates/crd/stages.pipelines.paprika.io.yaml`
- Modify: `charts/chart/templates/crd/pipelines.paprika.io_analysistemplates.yaml`
- Modify: `charts/chart/templates/crd/pipelines.paprika.io_analysisruns.yaml`
- Modify: `charts/chart/templates/crd/rollouts.paprika.io_rollouts.yaml`
- Create: `charts/chart/templates/rbac/observability-observabilitysource-admin-role.yaml`
- Create: `charts/chart/templates/rbac/observability-observabilitysource-editor-role.yaml`
- Create: `charts/chart/templates/rbac/observability-observabilitysource-viewer-role.yaml`
- Modify: `charts/chart/templates/rbac/manager-role.yaml`
- Modify: `charts/chart/templates/webhook/validating-webhook-configuration.yaml`
- Modify: `charts/chart/templates/networkpolicy/api-server.yaml`
- Modify: `charts/chart/templates/networkpolicy/controller-manager.yaml`
- Modify: `charts/chart/templates/api-server/deployment.yaml`
- Modify: `charts/chart/templates/manager/manager.yaml`
- Modify: `charts/chart/templates/manager/statefulset.yaml`
- Modify: `charts/chart/values.yaml`
- Create: `config/samples/observability_v1alpha1_observabilitysource.yaml`
- Create: `hack/test-observability-chart.sh`

- [ ] **Step 1: Write failing chart-render assertions**

In `hack/test-observability-chart.sh`, render defaults and an opted-in case. Assert the exact four environment variables from Task 3 reach API and manager containers, deny-all arrays/booleans are empty/false by default, Secret/source RBAC and webhook exist, and only configured CIDR/ports enter egress. Runtime dial validation remains authoritative because NetworkPolicy cannot enforce DNS names.

- [ ] **Step 2: Run the render test red**

Run: `rtk bash hack/test-observability-chart.sh`

Expected: FAIL because values and environment wiring are absent.

- [ ] **Step 3: Generate Kubernetes schemas and RBAC**

Run: `rtk make manifests generate`

Expected: controller-gen creates the declared ObservabilitySource CRD/RBAC/webhook and updates additive schemas.

- [ ] **Step 4: Synchronize generated Helm schemas**

Copy generated CRD/RBAC/webhook content into the exact Helm files listed above without hand-changing schemas; run `rtk git diff --check`.

- [ ] **Step 5: Wire exact security values and environment**

Add `observability.prometheus.allowedDNS: []`, `allowedCIDRs: []`, `allowedEgressPorts: [443]`, `allowHTTP: false`, and `allowInsecureSkipVerify: false`. Render comma-joined DNS/CIDRs and quoted booleans into the four Task-3 environment variables in API and both manager workload variants; render NetworkPolicy DNS plus only configured CIDR/port pairs.

- [ ] **Step 6: Run chart-render assertions green**

Run: `rtk bash hack/test-observability-chart.sh`

Expected: PASS for deny-all and explicit opt-in cases.

- [ ] **Step 7: Verify generated and Helm output**

Run: `rtk go tool buf lint`

Run: `rtk helm lint charts/chart`

Run: `rtk helm template paprika charts/chart --set networkPolicy.enabled=true --set 'observability.prometheus.allowedCIDRs[0]=203.0.113.0/24' --set 'observability.prometheus.allowedDNS[0]=prometheus.monitoring.svc' --set 'observability.prometheus.allowedEgressPorts[0]=8443'`

Expected: CRD, RBAC, webhook, source/preflight configuration, and egress rules render successfully.

- [ ] **Step 8: Commit packaging**

```bash
rtk git add config/crd/bases/observability.paprika.io_observabilitysources.yaml config/crd/bases/core.paprika.io_appprojects.yaml config/crd/bases/pipelines.paprika.io_applications.yaml config/crd/bases/pipelines.paprika.io_stages.yaml config/crd/bases/pipelines.paprika.io_analysistemplates.yaml config/crd/bases/pipelines.paprika.io_analysisruns.yaml config/crd/bases/rollouts.paprika.io_rollouts.yaml config/rbac/observability_observabilitysource_admin_role.yaml config/rbac/observability_observabilitysource_editor_role.yaml config/rbac/observability_observabilitysource_viewer_role.yaml config/rbac/role.yaml config/rbac/kustomization.yaml config/webhook/manifests.yaml config/api-server/deployment.yaml config/manager/manager.yaml config/manager/statefulset.yaml config/samples/observability_v1alpha1_observabilitysource.yaml charts/chart/templates/crd/observabilitysources.observability.paprika.io.yaml charts/chart/templates/crd/appprojects.core.paprika.io.yaml charts/chart/templates/crd/applications.pipelines.paprika.io.yaml charts/chart/templates/crd/stages.pipelines.paprika.io.yaml charts/chart/templates/crd/pipelines.paprika.io_analysistemplates.yaml charts/chart/templates/crd/pipelines.paprika.io_analysisruns.yaml charts/chart/templates/crd/rollouts.paprika.io_rollouts.yaml charts/chart/templates/rbac/observability-observabilitysource-admin-role.yaml charts/chart/templates/rbac/observability-observabilitysource-editor-role.yaml charts/chart/templates/rbac/observability-observabilitysource-viewer-role.yaml charts/chart/templates/rbac/manager-role.yaml charts/chart/templates/webhook/validating-webhook-configuration.yaml charts/chart/templates/networkpolicy/api-server.yaml charts/chart/templates/networkpolicy/controller-manager.yaml charts/chart/templates/api-server/deployment.yaml charts/chart/templates/manager/manager.yaml charts/chart/templates/manager/statefulset.yaml charts/chart/values.yaml hack/test-observability-chart.sh
rtk git commit -m "chore(observability): package source security manifests"
```

### Task 18: Validate real Prometheus backend and rollout behavior

**Files:**
- Create: `config/e2e/prometheus.yaml`
- Create: `config/e2e/observability-source.yaml`
- Create: `config/e2e/observability-applications.yaml`
- Create: `config/e2e/legacy-analysis.yaml`
- Create: `test/e2e/observability_test.go`
- Create: `hack/test-observability-helm-upgrade.sh`
- Modify: `test/e2e/e2e_test.go`
- Modify: `Makefile`

- [ ] **Step 1: Add a failing real-provider E2E test**

Seed AppProject, owned/allowlisted auth and TLS-CA Secrets, source, metric-producing applications, and Prometheus. Cover Healthy source, binding isolation, partial signal failure/recovery, traffic sizing, independent auth/CA rotation invalidation, and investigator evidence.

- [ ] **Step 2: Add rollout-gate cases**

Run real analysis through Pass, threshold Fail, NoData Fail, NoData Error, provider Error pause/no rollback, recovery, and strict legacy preflight/compatibility.

- [ ] **Step 3: Write the real Helm pre-upgrade gate**

Add `test-e2e-observability-upgrade`, backed by `hack/test-observability-helm-upgrade.sh`, using a dedicated kind cluster. Install the current chart, apply `legacy-analysis.yaml`, capture controller Deployment generation/image, then require `helm upgrade --atomic --set analysis.allowLegacyAssumePass=false` to fail with every resource/check path while the captured controller values remain unchanged. Repeat with `--set analysis.allowLegacyAssumePass=true`; require hook success, Helm deployed status, controller rollout, and the compatibility value in the controller environment. Always trap cluster cleanup.

- [ ] **Step 4: Run backend suites**

Run: `rtk go test ./internal/metricprovider/... ./internal/analysis/... ./internal/investigator/... ./internal/controller/observability/... ./internal/controller/pipelines/... ./internal/controller/rollouts/... ./internal/api/... -count=1`

Run: `rtk make lint`

Expected: PASS.

- [ ] **Step 5: Run provider/analysis kind E2E**

Run: `rtk make test-e2e`

Expected: real Prometheus, source lifecycle, fleet traffic, investigation, and rollout-gate scenarios pass.

- [ ] **Step 6: Run the Helm upgrade E2E**

Run: `rtk make test-e2e-observability-upgrade`

Expected: strict preflight exits nonzero before controller rollout; acknowledged compatibility upgrade succeeds and rolls out the compatibility-configured controller.

- [ ] **Step 7: Commit real-provider and upgrade coverage**

```bash
rtk git add config/e2e/prometheus.yaml config/e2e/observability-source.yaml config/e2e/observability-applications.yaml config/e2e/legacy-analysis.yaml test/e2e/observability_test.go test/e2e/e2e_test.go hack/test-observability-helm-upgrade.sh Makefile
rtk git commit -m "test(observability): validate real prometheus flows"
```

### Task 19: Validate browser states and document migration/security

**Files:**
- Create: `ui/e2e/observability.spec.ts`
- Create: `ui/e2e/helpers/kind-observability.ts`
- Create: `ui/playwright.observability.config.ts`
- Create: `hack/test-observability-browser-e2e.sh`
- Modify: `ui/package.json`
- Modify: `Makefile`
- Modify: `.github/workflows/test-e2e.yml`
- Create: `docs/guides/observability-sources.md`
- Create: `docs/guides/analysis-metric-migration.md`
- Modify: `docs/frontend.md`

- [ ] **Step 1: Write failing external-stack Playwright configuration tests**

Add `test:e2e:observability` as `playwright test --config playwright.observability.config.ts`. The config must require `PAPRIKA_OBSERVABILITY_E2E_BASE_URL`, set `webServer: undefined`, and run the Plan-1 Chromium normal, reduced-motion, and keyboard projects against that existing server. A missing/invalid URL fails before tests; it must never start `bin/fleet-console-fixture`.

- [ ] **Step 2: Add the dedicated kind/browser lifecycle**

`hack/test-observability-browser-e2e.sh` owns a `paprika-observability-browser` kind cluster and traps port-forward, diagnostics capture, and cluster cleanup. Build/load the Paprika image for `linux/amd64`, install the chart with API/UI plus basic-auth fixture and the Prometheus DNS allowlist, apply Task-18 Prometheus/source/application fixtures, wait for API/FleetIndex/source readiness, and port-forward the API/UI service to `127.0.0.1:3100`. Export `PAPRIKA_OBSERVABILITY_E2E_BASE_URL=http://127.0.0.1:3100`, a dedicated `PAPRIKA_OBSERVABILITY_E2E_KUBECONFIG`, and namespace, then run `npm --prefix ui run test:e2e:observability -- observability.spec.ts`.

- [ ] **Step 3: Add a no-shell kind control helper**

`kind-observability.ts` uses Node `execFile` with the dedicated kubeconfig to scale the Prometheus workload, apply recovery/analysis fixtures, and wait via JSONPath for ObservabilitySource and rollout/AnalysisRun states. It accepts only fixed fixture actions—no arbitrary command input—and captures pod/controller/source diagnostics on timeout.

- [ ] **Step 4: Write the real browser flow**

Against the compiled static UI served by the live Go API in kind, test golden signals, zero/NoData/NotConfigured/Stale/Unavailable, stage switching, traffic sizing, and typed rollout Pass/Fail/Error/NoData. Use the fixed helper to stop Prometheus, assert partial/unavailable UI while inventory/resources/actions still work, restart it, wait for source Healthy, retry, and assert recovery without a page reload.

- [ ] **Step 5: Document safe configuration and migration**

Document endpoint allowlists, NetworkPolicy limitations, fixed Secret shapes, project binding, no browser PromQL, audit redaction, source Test override behavior, old/new analysis outcome table, declarative YAML migration, preflight, and one-release compatibility flag.

- [ ] **Step 6: Add the Make/CI gate and run verification**

Add this target and a workflow job that invokes it, uploads captured kind/Playwright artifacts on failure, and never substitutes mocked Connect routes:

```make
.PHONY: test-e2e-observability-browser
test-e2e-observability-browser:
	bash hack/test-observability-browser-e2e.sh
```

Run: `rtk npm --prefix ui test`

Run: `rtk npm --prefix ui run lint`

Run: `rtk npm --prefix ui run build`

Run: `rtk make test-e2e-observability-browser`

Expected: component/accessibility/static build pass, then real Prometheus outage/recovery and typed rollout browser flows pass against the kind API.

- [ ] **Step 7: Commit final Plan-3 validation**

```bash
rtk git add ui/e2e/observability.spec.ts ui/e2e/helpers/kind-observability.ts ui/playwright.observability.config.ts hack/test-observability-browser-e2e.sh ui/package.json Makefile .github/workflows/test-e2e.yml docs/guides/observability-sources.md docs/guides/analysis-metric-migration.md docs/frontend.md
rtk git commit -m "docs(observability): document and verify metric operations"
```

### Plan 3 completion criteria

- Project/source/Secret binding is deterministic and cannot cross tenants.
- Source Test/rotation can use an ephemeral credential override without status mutation or cache entry.
- Prometheus requests are AST-scoped, endpoint-allowlisted, bounded, cached, audited, and traced.
- Audit sink failures are observable but never roll back completed work; Plan 4 extends this coverage to all remaining actions.
- Golden signals distinguish zero, no data, stale, not configured, and unavailable.
- Fleet traffic sizing uses one bounded grouped query per source and exact six-part stage-target identity.
- Analysis evaluation carries explicit Application/project/stage/cluster context and exposes typed outcomes.
- Provider errors pause pipeline and rollout progression without automatic rollback; recovery resumes safely.
- Only detected legacy checks can use the temporary compatibility behavior, with a condition, audit, and bounded OTel metric every time.
- Investigator metrics are provider-neutral and partial failures preserve Kubernetes evidence.
- Real Prometheus, Helm, kind, UI, security, migration, and compatibility gates pass.

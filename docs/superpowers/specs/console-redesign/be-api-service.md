# Backend map: `internal/api` (package `apiserver`)

Repo root: `/Users/benebsworth/projects/paprika`. All paths absolute below are relative to that root
unless written in full.

---

## 1. Package layout

`internal/api` is Go package **`apiserver`** (note: directory `api`, package `apiserver`; the package
doc comment lives at the top of `internal/api/metrics_handler.go:1`).

Sub-packages:

| Path | Package | Role |
|---|---|---|
| `internal/api/auth/` | `auth` | authn (basic / OIDC / self-signed JWT / GH Actions), authz (RBAC rules + AppProject roles), connect interceptor, login/token HTTP handlers |
| `internal/api/events/` | `events` | in-memory + Redis pub/sub `Broker`, `Event`, topic/type constants, payload structs |
| `internal/api/mocks/` | `mocks` | mockgen output for the `Evaluator` interface |
| `internal/api/paprika/v1/` | `paprikav1` | **generated** `api.pb.go` (12 204 lines) |
| `internal/api/paprika/v1/v1connect/` | `v1connect` | **generated** `api.connect.go` (1 267 lines) — client, handler iface, procedure consts |
| `internal/api/uistatic/` | — | `go:embed`ed Next.js static export served by `UIHandler()` |

Generated code is produced by `go tool buf generate` driven by `/Users/benebsworth/projects/paprika/buf.gen.yaml`,
which fans out to **four** outputs:
- `protoc-gen-go` → `internal/api` (`paths=source_relative`)
- `protoc-gen-connect-go` → `internal/api`
- `ui/node_modules/.bin/protoc-gen-es` → `ui/src/gen` (`target=js+dts`)
- `ui/node_modules/.bin/protoc-gen-connect-es` → `ui/src/gen`

Make target: `make generate-proto` (`Makefile:63-74`). It **silently skips** if `protoc-gen-go`,
`protoc-gen-connect-go` or `ui/node_modules/.bin/protoc-gen-es` are missing — so a proto edit can
appear to "work" while leaving stale generated files. Install all three before regenerating.
Source of truth: `proto/paprika/v1/api.proto` (1 187 lines).

---

## 2. Handler files — full inventory

Every RPC method hangs off the single struct `PaprikaServer`. There is no per-handler struct.

### `internal/api/server.go` (1 710 lines) — core server + most legacy RPCs

Types / options:
- `type ServerOption func(*PaprikaServer)` — `server.go:47`
- `type PaprikaServer struct` — `server.go:94`. Fields:
  - `client client.Client` (controller-runtime, cache-backed in prod)
  - `k8sClient kubernetes.Interface` (typed clientset — Pod logs, Jobs, Events)
  - `dynamicClient dynamic.Interface` (arbitrary GVK live reads)
  - `restMapper meta.RESTMapper` (kind → GVR discovery)
  - `broker *events.Broker`
  - `renderer pipelines.SourceResolvingRenderer`
  - `evaluator Evaluator`
  - `governanceValidator *governance.ProjectValidator`
  - `governancePolicyEvaluator *governance.PolicyEvaluator`
  - `authorizer auth.Authorizer`
  - `fleetIndex fleet.Reader`  ← **the in-memory index; the only non-Kubernetes data source today**
  - `Auditor audit.Auditor` (exported)
  - `Clock clock.Clock` (exported)
- Constructors: `NewPaprikaServer(c, broker, opts...)` `server.go:115`;
  `NewPaprikaServerWithRedis(ctx, c, redisClient, opts...)` `server.go:130`.
- Options: `WithRenderer` :50, `WithAuthorizer` :55, `WithFleetIndex` :60, `WithClock` :65,
  `WithK8sClient` :71, `WithDynamicClient` :77, `WithRESTMapper` :83, `WithAuditor` :89.
  Three more live in `apply_bundle.go`: `WithPolicyEvaluator` :53, `WithGovernanceValidator` :58,
  `WithGovernancePolicyEvaluator` :63.
- Compile-time contract assertion: `var _ v1connect.PaprikaServiceHandler = (*PaprikaServer)(nil)` at
  `server.go:201`. **Adding an RPC to the proto immediately breaks compilation until a method is added.**

Helpers:
- `s.now()` :145 → `Clock.Now()`, falls back to `time.Now()`.
- `s.auditor()` :154 → `audit.NoopAuditor{}` when nil.
- `s.AuditInterceptor()` :164 → `NewAuditInterceptor(s.auditor(), s.broker)`.
- `s.authorizeApplication(ctx, action, app)` :168 — resolves `app.Spec.Project` (default
  `"default"` via `defaultProjectName`) then delegates to `authorizeProject`.
- `s.authorizeProjectFromLabels(ctx, obj, resource)` :176 — reads the label
  `app.paprika.io/project` (`projectLabelKey`, `apply_bundle.go:46`), returns bool. Used for
  list filtering (silently drops unauthorized items).
- `s.authorizeProject(ctx, action, resource, ns, project)` :187 — **no-op when `s.authorizer == nil`**;
  otherwise requires a principal in context, else `auth.ErrUnauthorized`.
- `recordAPIList(ctx, resource, started, count, err)` :293 — OTel histograms
  `paprika.api.list.duration` / `.items` / counter `.errors`.
- `s.Broker()` :289.
- `ptr[T]` :1675, `safeInt32` :1679, `decodeTemplate` :1689, `decodeValues` :1701.

RPC methods in `server.go` (all `(s *PaprikaServer)`):
`ListArtifacts` :206, `GetArtifact` :239, `ListPipelines` :303, `ResolveSource` :330, `Render` :358,
`ListReleases` :383, `ListStages` :447, `ListApplications` :474, `ListPolicies` :505,
`ListApplicationSets` :530, `ListNotificationConfigs` :560, `GetApplicationSet` :627,
`GetApplication` :641, `SyncApplication` :658, `ApproveGate` :693, `ListGateStatus` :733,
`RejectGate` :748, `RollbackRelease` :798, `ListRollouts` :842, `GetRollout` :869,
`PromoteRollout` :884, `AbortRollout` :910, `ListAnalysisRuns` :951, `GetAnalysisRun` :985.

CRD→proto converters (all package-level funcs, `server.go`): `convertNotificationConfig` :582,
`convertRollout` :999, `convertRolloutTrafficRouter` :1045, `convertRolloutCanarySteps` :1069,
`convertRolloutAnalysisChecks` :1084, `convertRolloutABRoutes` :1115, `rolloutMirrorPercent` :1131,
`rolloutAutoPromotionSeconds` :1138, `rolloutScaleDownDelaySeconds` :1145,
`convertArtifactToArtifactRef` :1155, `artifactPath` :1172, `artifactResolvedReference` :1182,
`artifactDigest` :1213, `artifactPhaseAndReason` :1223, `artifactDownloadURL` :1250,
`convertPipeline` :1290, `convertPipelineArtifactRef` :1334, `convertRelease` :1348,
`convertHookStatuses` :1398, `convertStage` :1433, `convertConditions` :1448,
`convertApplication` :1463, `convertGateStatuses` :1538, `convertApplicationSet` :1554,
`convertResourceSyncs` :1572, `convertResourceHealth` :1585, `convertAnalysisResults` :1599,
`convertAnalysisRun` :1617, `convertAnalysisRunResults` :1639, `convertHealthChecks` :1657.

**This converter list is where new per-application metadata (owner, on-call, tier, runbook,
commit author/message, lifecycle phases) would be surfaced — `convertApplication` at
`server.go:1463` is the single funnel for `paprikav1.Application`.**

### `internal/api/fleet_handler.go` (1 108 lines) — fleet query RPCs
Consts: `defaultFleetPageSize = 100`, `maxFleetPageSize = 500`, `maxFleetSearchRunes = 128` (`:18-22`).
RPCs: `QueryApplications` :27, `QueryFleetMap` :81, `QueryFleetMatrix` :128.
Infra: `requireFleetIndex()` :179 (→ `CodeUnavailable` "fleet index is not configured"),
`mapFleetError(err)` :186 (typed→connect code table, see §6), `fleetInvalidArgument(...)` :1106.
Proto↔fleet conversion: `fleetFilterFromProto` :219 plus ~35 enum mappers and
`fleetApplicationPageToProto` :535, `fleetApplicationResultToProto` :550, `fleetTargetToProto` :585,
`fleetFacetToProto` :595, `fleetMapToProto` :609, `fleetMapNodeToProto` :624,
`fleetMatrixToProto` :647, `fleetObjectKeyToProto` :700, `fleetCapabilityToProto` :835.
Validation helpers `validateFleetFilter` :900 … `validFleetSizeMetric` :1095.

### `internal/api/system_status_handler.go` (111 lines) — see §7 in full.

### `internal/api/fleet_capabilities.go` (211 lines) — see §5 in full.

### `internal/api/resource_handler.go` (406 lines) — `GetResource`
- `knownResourceGVRs` :26 — hardcoded map of 20 common kinds → GVR.
- `clusterScopedResources` :50 — 3 entries (namespaces, clusterroles, clusterrolebindings).
- `type resolvedResourceMapping struct{ gvr; gvk; scope }` :56.
- `GetResource` :65 — Get Application → `authorizeApplication(ActionRead)` → then four best-effort
  populate steps, **each silently no-ops if its client is nil**:
  `populateResourceStatus` :97 (from `app.Status.Resources` / `app.Status.ResourceHealth`),
  `populateLiveManifest` :122 (dynamic client), `populateDesiredManifest` :135 (renderer + unified diff),
  `populateEvents` :150 (typed clientset `corev1.Events`).
- `findSyncStatus` :103 / `findHealthStatus` :112 — linear scan over the Application status arrays,
  matching on `Kind + Name + (Namespace || "")`. **This is the only drift/health data today: a
  status string per resource. No changed-field counts, no drift timestamps, no drift reasons.**
- `resolveResourceMapping` :178 → `knownResourceGVRs`, else `restMapper`; `resolveResourceMappingByPlural` :212;
  `kindToResourceName` :236; `getDesiredManifest` :274; `getResourceEvents` :330;
  `manifestToYAML` :360; `unifiedDiff` (difflib) :376/:393.

### `internal/api/resource_tree_handler.go` (304 lines)
- `childDiscovery` :23 — parent kind → child kinds (Deployment→ReplicaSet→Pod, etc.).
- `GetResourceTree` :35 — flat node list; managed roots come from `app.Status.Resources`, children
  discovered live via owner refs when `dynamicClient != nil`.
- `GetResourceTreeDetailed` :82 — same plus per-node phase/ready-replicas/containers via
  `populateNodeDetail` :147 (typed clientset). Silent failure on error.
- `discoverChildren` :229, `listChildrenOfKind` :265.

### `internal/api/resource_logs_handler.go` (95 lines)
`GetResourceLogs` :22 — authorize → `resolveLogsPod` :72 (Pod direct; Deployment/RS/STS/DS/Job via
label selector) → `streamPodLogs`. Errors are returned **in the response body** (`resp.Error`),
not as connect errors.

### `internal/api/stream_resource_logs_handler.go` (139 lines) — the only server-streaming RPC
`StreamResourceLogs(ctx, req, stream *connect.ServerStream[paprikav1.LogChunk]) error` :25.
House pattern for streaming: define a narrow sink interface `logChunkSink` :75 (`Send` only) and a
`streamAdapter` :81 wrapping `*connect.ServerStream`, so the forwarding loop `forwardLogLines` :108
is unit-testable with an in-memory fake. **Copy this pattern for any new streaming RPC (e.g. a
webhook/source-trigger event feed).**

### `internal/api/pipeline_handler.go` (303 lines)
Consts `pipelineLabelKey = "paprika.io/pipeline"`, `stepLabelKey = "paprika.io/step"`,
`jobNameLabelKey = "job-name"` :25-29.
`getPipeline` :31 (authz via project label), `checkTerminalPipelinePhase` :42, `GetPipeline` :49,
`RetryStep` :64, `SkipStep` :100, `CancelPipeline` :137, `cancelPipelineStatus` :164,
`deletePipelineJobs` :175, `GetStepLogs` :190, `findLatestStepJob` :221, `findJobPod` :239,
`streamPodLogs` :253, `publishPipelineEvent` :278.
Mutations write `client.Status().Update()` then publish to the broker.
**No run history, test counts, cache-hit rate, CPU-minutes, or per-step resource requests exist
anywhere — Pipeline status only carries per-step phase/timestamps.**

### `internal/api/investigator_handler.go` (275 lines)
`investigatorRegistry = investigator.NewDefaultRegistry()` — package-level var :33.
`Investigate` :36 assembles an `investigator.Input` (live manifest, diff, events, logs) and delegates.
`ListInvestigatorPlugins` :83 returns sources/detectors/narrators sorted by (type, name).
Helpers `fetchInvestigatorLiveManifest` :112, `fetchInvestigatorDiff` :144, `getLiveManifestYAML` :159,
`fetchInvestigatorEvents` :170, `fetchInvestigatorLogs` :209, `toProtoInvestigateResponse` :235,
`generatedAtMS` :254, `toProtoEvidence` :265. Consts `investigatorLogsTailLines = 500`,
`investigatorEventsLimit = 50`.

### `internal/api/apply_bundle.go` (903 lines) — the heavyweight mutation
Kubebuilder RBAC markers at :32-39 (policies, applications, applications/status, stages, releases,
configmaps, namespaces). Label/annotation consts :41-50:
`managedByLabel`, `nameLabel`, `releaseLabel`, `historyLabel`, `projectLabelKey`,
`defaultProjectName = "default"`, `rollbackAnnotation = "paprika.io/rollback-requested"`,
`bundleSHAAnnotation = "paprika.io/bundle-sha"`.
`ApplyBundle` :73 flow: require namespace → `ensureNamespace` → `prepareBundle` → derive app name →
parse manifests (only when a governance component is set) → `evaluateBundle` :149 → early return
if `Blocked` → early return if `DryRun` (builds objects without writing) → `applyIfNeeded` :477.
Other notable funcs: `buildApplication` :790, `buildRelease` :824, `baseLabels` :852,
`generateReleaseName` :862, `fullBundleSHA` :868, `bundleSHA` :872,
`toReleasePolicyResults` :877, `convertPolicyResults` :891.

### `internal/api/audit_middleware.go` (141 lines)
`auditVerbs` :18 — prefix→action map: `Sync`→update, `Apply`→apply, `Approve`→approve,
`Reject`→reject, `Rollback`→update, `Promote`→promote, `Abort`→update. Anything else is
treated as read-only and **not audited**.
`NewAuditInterceptor(a audit.Auditor, broker *events.Broker) connect.UnaryInterceptorFunc` :36 —
runs the RPC, then records an `audit.Event` and publishes an `events.TypeAudit` event to
`events.TopicDashboard`. `classifyAudit` :91, `principalString` :106, `nameFromRequest` :121,
`namespaceFromRequest` :133 (all reflection-free — protobuf getter interface assertions).
**Consequence for new mutations:** naming a new RPC `HoldRollout` / `IgnoreDriftedField` /
`PatchResource` / `SyncResources` will NOT be audited unless you extend `auditVerbs` (e.g. add
`"Hold"`, `"Ignore"`, `"Patch"`). Prefer names beginning with an existing verb, or extend the map.

### `internal/api/evaluator.go` (14 lines)
```go
//go:generate mockgen -destination=mocks/evaluator.go -package=mocks . Evaluator
type Evaluator interface {
    Evaluate(ctx context.Context, bundle []byte, opts policy.EvaluateOptions) (*policy.EvaluationResult, error)
}
```

### `internal/api/sse.go` (89 lines)
`SSEHandler` :15 / `NewSSEHandler` :20 / `ServeHTTP` :27 / `PublishEvent` :87.
**Currently unreachable in production** — `/events` is wired to `http.NotFoundHandler()` in every
mode (see §3). The comment in `cmd/main.go:997-1001` says raw browser SSE is intentionally
fail-closed "until an authorized WatchEvents transport is available". There is no `WatchEvents` RPC.

### `internal/api/uihandler.go` (94 lines)
`//go:embed all:uistatic` :36-37; `UIHandler()` :42 returns an SPA handler with security headers,
`/metrics` passthrough, immutable caching for assets, `no-store` for HTML, and index.html fallback.

### `internal/api/metrics_handler.go` (53 lines)
`MetricsHandler()` :15 (promhttp), `MetricsMiddleware(next)` :24 wrapping every HTTP request with
`metrics.APIRequestDuration` / `APIRequestTotal` labelled `(method, path, status)`; `normalizePath` :48
truncates to 64 chars (no templating — high-cardinality paths are truncated, not grouped).

### `internal/api/github_actions_token_exchange.go` (303 lines)
Plain `http.Handler` (not a connect RPC). `githubActionsIssuerURL` :18,
`GitHubActionsTokenExchangeConfig` :23, `GitHubActionsClaims` :40, `GitHubActionsTokenVerifier` :51,
`ServiceAccountTokenIssuer` :56, `NewGitHubActionsTokenExchangeHandler` :62,
`NewGitHubActionsTokenVerifier` :221, `NewKubernetesServiceAccountTokenIssuer` :253.
Mounted at `/auth/github-actions/token`.

---

## 3. How the ConnectRPC service is assembled and served

There are **four** assembly sites. The canonical one is `cmd/main.go`.

### 3a. `cmd/main.go` — `runAPIMode` (`cmd/main.go:501`)

```
runAPIMode
 ├─ observability.NewTelemetry
 ├─ buildAPIClients            (cmd/main.go:602)
 ├─ prepareStandaloneFleetRuntime (cmd/main.go:565)
 ├─ newBrokerFromConfig
 ├─ buildConnectHandler        (cmd/main.go:651)
 ├─ buildAuthHandlers          (cmd/main.go:676)  → /auth/login, /auth/token, /auth/basic-login
 ├─ buildGitHubActionsTokenExchangeHandlers (cmd/main.go:698) → /auth/github-actions/token
 ├─ fleetReadyChecker          (cmd/main.go:1024)
 ├─ buildAPIMux                (cmd/main.go:988)
 ├─ otelhttp.NewHandler(apiserver.MetricsMiddleware(mux), "paprika-http")
 ├─ buildHealthMux / buildHealthProbeServer (separate probe port)
 ├─ startMetricsServer
 └─ runFleetCacheLifecycle → startAPIServer(ctx, wrappedHandler, cfg.uiAddr, ...)
```

**`buildAPIClients` (`cmd/main.go:602`)**
- `buildAPIConfig(cfg.k8sAPIServer, cfg.k8sTokenFile)` → `*rest.Config`.
- If `cfg.apiCacheEnabled`: `createAPICacheBundle` (`cmd/main.go:939`) builds a
  `crcache.New(...)` with `DefaultTransform: crcache.TransformStripManagedFields()`, **warms
  informers** for: `Application`, `ApplicationSet`, `Pipeline`, `Release`, `Stage`,
  `Repository`, `clustersv1alpha1.Cluster`, `FeatureFlag`, `FeatureFlagBinding` (see
  `cmd/main.go:948-958`), then `client.New(config, client.Options{Cache: &client.CacheOptions{Reader: apiCache}})`.
  The resulting client is **read-from-cache, write-through-to-API**.
- Else: direct (uncached) client, and `fleetReader = fleet.NewUnavailableReader(apiCacheDisabledReason)`
  — every fleet RPC returns `CodeUnavailable`.
- `createK8sClient` → typed `kubernetes.Interface`.
- `buildAuthConfig(...)` → `auth.Config`, then `auth.Interceptor(ctx, authCfg, apiClient)`.

**`prepareStandaloneFleetRuntime` (`cmd/main.go:565`)** — only when the cache bundle exists:
```go
fleetIndex   := fleet.NewIndex()
fleetStore   := fleet.NewCacheStore(clients.cacheBundle.Cache, scheme)
fleetRuntime, _ := fleet.NewRuntime(clients.cacheBundle.Cache, fleetStore, fleetIndex)
fleetRuntime.Register(ctx)          // adds informer event handlers
clients.fleetReader = fleetRuntime.Reader()
```

**`buildConnectHandler` (`cmd/main.go:651`)**
```go
resolver         := governance.NewProjectResolver(apiClient)
projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(apiClient), nil)
policyEvaluator  := governance.NewPolicyEvaluator(apiClient)
opts, _ := buildAPIServerOptions(authCfg, apiClient, k8sClient, cfg.auditLogEnabled,
                                 projectValidator, policyEvaluator, restConfig)   // cmd/main.go:392
opts = append(opts, apiserver.WithFleetIndex(fleetReader))
paprikaServer := apiserver.NewPaprikaServer(apiClient, broker, opts...)

otelInterceptor, _ := otelconnect.NewInterceptor()
const maxMsgBytes = 10 * 1024 * 1024  // 10 MiB
_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer,
    connect.WithInterceptors(otelInterceptor, authInterceptor, paprikaServer.AuditInterceptor()),
    connect.WithReadMaxBytes(maxMsgBytes),
)
```
Interceptor order is **otel → auth → audit** (audit last so the principal is in context).

`buildAPIServerOptions` (`cmd/main.go:392`) adds `WithGovernanceValidator`,
`WithGovernancePolicyEvaluator`, conditionally `WithAuthorizer(auth.BuildAuthorizer(...))` (only if
`authCfg.Enabled`), conditionally `WithAuditor(audit.NewLogAuditor())` (only if
`cfg.auditLogEnabled`), always `WithK8sClient`, and — best-effort, **errors swallowed** —
`WithDynamicClient(dynamic.NewForConfig(restConfig))` and
`WithRESTMapper(apiutil.NewDynamicRESTMapper(restConfig, nil))`.

**`buildAPIMux` (`cmd/main.go:988`)** — route table, order matters:
```
/paprika.v1.PaprikaService/   → connectHandler
/events                       → http.NotFoundHandler()   (deliberately fail-closed)
/healthz                      → healthzHandler
/readyz                       → readinessHandler(fleetReadyChecker)
…extraHandlers (auth, GH Actions)…
/                             → apiserver.UIHandler()    (catch-all, registered LAST)
```
Readiness is gated on `fleet.Reader.CheckReady()` (`fleetReadyChecker`, `cmd/main.go:1024`) — the API
process is not "ready" until the fleet index has been built.

**Startup ordering** (`runFleetCacheLifecycle`, `cmd/main.go:437`): start cache → `WaitForCacheSync`
(records `metrics.APICacheSyncDuration`) → `fleetRuntime.WaitReady` → only then start the API server.

### 3b. `cmd/main_operator.go:506-514` — combined operator+API mode, same `NewPaprikaServiceHandler`
call using `mgr.GetClient()`.

### 3c. `cmd/cloud-run/main.go:210-286` — Cloud Run mode.
`apiserver.NewPaprikaServer(k8sClient, nil, opts...)` — **broker nil, no fleet index**, so all
fleet/system-status RPCs return `CodeUnavailable` there.

### 3d. `test/fleetconsole/server.go:36-69` — fixture-driven e2e/visual harness.
`apiserver.NewPaprikaServer(..., apiserver.WithFleetIndex(fixture.index))` then
`v1connect.NewPaprikaServiceHandler(...)`; `mux.Handle(procedurePrefix, connectHandler)`. This is the
place to add fixture data for new read RPCs so the console can be driven without a cluster.

---

## 4. Request → data flow

Two completely distinct paths:

**Path A — legacy CRD-backed RPCs (34 of 41 RPCs).**
`connect handler` → interceptors (otel, auth, audit) → `PaprikaServer` method → one of:
- `s.client` (controller-runtime, informer-cache-backed) `Get`/`List`/`Update`/`Status().Update()`
- `s.k8sClient` (typed clientset) for Pod logs, Jobs, Events
- `s.dynamicClient` + `s.restMapper` for arbitrary-GVK live manifests
- `s.renderer` for desired manifests
→ a `convertXxx` function → proto message.
Per-item authorization is applied inside the loop; unauthorized items are **silently dropped**
from list responses.

**Path B — fleet RPCs (`QueryApplications`, `QueryFleetMap`, `QueryFleetMatrix`, `GetSystemStatus`).**
`handler` → validate request → `s.requireFleetIndex()` → `fleet.Reader` → an **immutable
`*fleet.Snapshot`** held in an `atomic.Pointer` (`internal/fleet/snapshot.go:39-42`). Queries are
pure in-memory map/postings-list operations; **no Kubernetes reads at all** during a query.
The snapshot is rebuilt by `fleet.Runtime` from informer events for:
`Application`, `Stage`, `Release`, `Rollout`, `clustersv1alpha1.Cluster`, `corev1alpha1.Repository`,
`corev1alpha1.AppProject`, plus an optional source prototype
(`internal/fleet/runtime.go:119-132`).

`fleet.Reader` interface (`internal/fleet/reader.go:14-21`):
```go
type Reader interface {
    ProjectKeys(context.Context, []string) ([]ProjectKey, error)
    QueryApplications(context.Context, QueryScope, ApplicationQuery, string) (ApplicationPage, error)
    QueryMap(context.Context, QueryScope, FleetMapQuery) (FleetMap, error)
    QueryMatrix(context.Context, QueryScope, FleetMatrixQuery) (FleetMatrix, error)
    LoadSnapshot() (*Snapshot, error)
    CheckReady() error
}
```

`fleet.Snapshot` (`internal/fleet/snapshot.go:13-35`) carries `Applications`, `Projects`,
`Repositories`, `Clusters`, `Sources` plus inverted indexes `ByProject / ByNamespace / ByRepository /
ByCluster / BySource / ByStage / ByHealth / BySync / ByRelease / ByRollout / BySourceType / Trigrams`.

`fleet.ApplicationSummary` (`internal/fleet/model.go:145-171`) — the entire per-app payload the fleet
views can render today:
`Identity, Project, Targets[], CurrentStage, CurrentCluster, CurrentClusterLabel, SourceType,
SourceRevision, Health, Sync, DriftCount, MissingResourceCount, ReleaseState, RolloutState,
ResourceCount, Repository, RepositoryConnection, EffectiveObservabilitySource,
ObservabilityConnection, ObservabilityBindings[], BlockedGateCount, LastTransitionUnixMS`.

`fleet.ClusterSummary` (`internal/fleet/model.go:188-192`) is **only** `{Identity, DisplayName, Connection}`.

### Existing seam for metrics — important
`internal/fleet/map.go:40-54` already defines:
```go
type TargetWeightKey struct { Project ProjectKey; Application types.NamespacedName; Stage string; Cluster ClusterKey }
type WeightReader interface { RequestRate(TargetWeightKey) (float64, bool) }
```
`Snapshot.QueryMap(scope, query, weights WeightReader)` and the matrix equivalent already consume it,
and `FleetMapNode` already has `RequestRateWeight`, `EffectiveWeight`, `UsedResourceFallback`
(`map.go:76-91`). But `Index.QueryMap` / `Index.QueryMatrix` pass **`nil`**
(`internal/fleet/reader.go:109`, and the comment at `reader.go:93-96`: *"delegates without a
WeightReader until the future metrics cache is available"*). **This is the designed insertion point
for per-app request rate; a real `WeightReader` implementation plugs in with no query-layer change.**

---

## 5. `internal/api/auth` — the authn/authz model

### Files
| File | Contents |
|---|---|
| `authenticator.go` (44) | `Authenticator` iface; `NewMultiAuthenticator` (first success wins) |
| `basic_auth.go` (88) | `BasicAuthConfig`, `NewBasicAuthenticator` |
| `oidc_auth.go` (186) | `OIDCConfig`, `NewOIDCAuthenticator` + `LoginHandler()` / `TokenHandler()` |
| `self_signed_token.go` (142) | HMAC self-signed bearer tokens (`NewSelfSignedAuthenticator`) |
| `principal.go` (70) | `Principal`, `IsInGroup`, `HasScope`, `WithPrincipal`, `PrincipalFromContext` |
| `authz.go` (236) | `Action`, `Resource`, `ProjectRef`, `Authorizer`, `RBACRule`, `RBACAuthorizer`, `AllowAllAuthorizer`, `DenyAllAuthorizer` |
| `project_authorizer.go` (112) | `ProjectAuthorizer` — reads `corev1alpha1.AppProject` roles |
| `middleware.go` (290) | `Config`, `Interceptor`, `BuildAuthorizer`, `multiAuthorizer`, `classify`, `namespaceFromRequest`, `projectFromRequest` |
| `login_handler.go`, `basic_login_handler.go`, `token_handler.go`, `request.go` | HTTP login/token endpoints |

### `middleware.go` in detail

```go
type Config struct {
    Enabled     bool
    BasicAuth   *BasicAuthConfig
    OIDC        *OIDCConfig
    TokenSecret []byte
    RBACRules   []RBACRule
}
```

`Interceptor(ctx, cfg, reader client.Reader) (connect.UnaryInterceptorFunc, error)` — `middleware.go:29`:
- If `!cfg.Enabled` → returns a pass-through interceptor. **Auth off means no principal in context,
  and `PaprikaServer.authorizer` is also nil, so `authorizeProject` is a no-op.**
- Otherwise `buildAuthnAuthz` :90 composes authenticators in order **BasicAuth → OIDC → SelfSigned**
  into a `MultiAuthenticator`; errors if zero are configured.
- Per request: wraps headers into a `*httpRequest` (`requestFromSpec` :~205) stored under
  `requestContextKey{}` → `authn.Authenticate(ctx)` → on failure `CodeUnauthenticated` and
  `metrics.AuthFailures`; on success `metrics.AuthAttempts` + `ctx = WithPrincipal(ctx, principal)`.
- **`defersProjectSetAuthorization(proc)` (`middleware.go:79-89`)** — for exactly
  `QueryApplications`, `QueryFleetMap`, `QueryFleetMatrix`, `GetSystemStatus` the interceptor
  **skips its own coarse authorize** and returns `next(ctx, req)`, because those handlers compute a
  per-project authorized set themselves. **Any new fleet-wide/multi-project read RPC must be added
  to this switch, or the coarse namespace/project check will incorrectly deny it.**
- Otherwise: `action, resource := classify(proc)`; `namespace := namespaceFromRequest(req)`;
  `project := projectFromRequest(req)`; then `authz.Authorize(...)`; denial →
  `CodePermissionDenied` + `metrics.AuthzDenials`; allow → `metrics.AuthzDecisions{decision=allow}`.

`classify(procedure)` (`middleware.go:~248`) is **substring matching on the lowercased procedure**:
```go
var resourceKeywords = map[string]Resource{
    "application": ResourceApplications, "pipeline": ResourcePipelines,
    "release": ResourceReleases, "stage": ResourceStages, "template": ResourceTemplates,
    "artifact": ResourceArtifacts, "rollout": ResourceRollouts,
}
// default resource = ResourceApplications
// action = ActionWrite unless the procedure contains "list" or "get" → ActionRead
```
Map iteration order is random, so a procedure containing two keywords classifies
non-deterministically. Also note `"cluster"`, `"cost"`, `"metric"`, `"event"`, `"drift"` are **not**
keywords, so new RPCs named for them fall back to `ResourceApplications`.
**Gotchas for new RPCs:** `HoldRollout` → (write, rollouts) ✅. `GetClusterCapacity` → contains "get"
→ (read, applications). `ListSourceEvents` → (read, applications). `IgnoreDriftedField` → contains
neither list nor get → **ActionWrite** ✅ but resource = applications. `PatchResource` → (write,
applications). Add explicit keywords or an explicit procedure→(action,resource) table if precision
is needed.

`namespaceFromRequest` / `projectFromRequest` use protobuf getter interface assertions
(`GetNamespace() string`, `GetProject() string`) — so request messages **should carry `namespace` and
`project` fields** if you want coarse authz to work.

`BuildAuthorizer(cfg, reader)` (`middleware.go:122`) composes into `multiAuthorizer`:
- `NewRBACAuthorizer(cfg.RBACRules)` if any rules
- `NewProjectAuthorizer(reader)` if reader non-nil
- **fail-closed `&DenyAllAuthorizer{}` if neither**

`multiAuthorizer.Authorize` :~142 requires **every** authorizer to allow (AND semantics).
`multiAuthorizer.AuthorizedProjects` :~152 progressively intersects each authorizer's result.

### `Authorizer` interface (`authz.go:40-43`)
```go
type Authorizer interface {
    Authorize(ctx, p *Principal, action Action, resource Resource, namespace, project string) error
    AuthorizedProjects(ctx, p *Principal, action Action, resource Resource, candidates []ProjectRef) ([]ProjectRef, error)
}
```
Actions: `read`, `write`, `admin`. Resources: `applications`, `pipelines`, `releases`, `stages`,
`templates`, `artifacts`, `rollouts` (`authz.go:22-30`). **No cluster/cost/metrics resource exists.**

`RBACAuthorizer` (`authz.go:112-236`): matches subjects (`*`, exact subject, `group:<name>`), actions
(`*`, exact, `admin` implies everything, `write` implies `read`), resources (`*` or exact),
namespaces (`*` or exact), projects (`*` or exact; **empty rule.Projects or empty request project
matches everything** — `matchesProjects` :226).

`ProjectAuthorizer` (`project_authorizer.go:25-49`): Gets the `AppProject` CRD at
`{Namespace: namespace || "default", Name: project}` and iterates `ap.Spec.Roles`, checking
`actionAllowed(role.Actions, action)` and `subjectMatches(role.Subjects, p)`.
Two permissive edge cases: **`project == "" → return nil` (allow)**, and NotFound on the literal
project `"default"` → allow.

### How **capabilities** on an application are computed — `internal/api/fleet_capabilities.go`

Capabilities are **never persisted in the snapshot** — they are derived per request from the
authorizer, then attached to each returned application.

```go
type fleetCapabilityGrant struct {
    action       auth.Action
    resource     auth.Resource
    capabilities []fleet.Capability
}

var fleetCapabilityGrants = [...]fleetCapabilityGrant{
    {ActionWrite, ResourceApplications, {CapabilityApplicationSync}},
    {ActionWrite, ResourceReleases,     {CapabilityReleaseRollback, CapabilityGateApprove}},
    {ActionWrite, ResourcePipelines,    {CapabilityPipelineRetry}},
}
```
(`fleet_capabilities.go:13-38` — rollback and gate-approve deliberately share one permission tuple.)

Flow:
1. `buildFleetQueryScope(ctx, reader, authorizer, principal, namespaces)` :43 →
   `reader.ProjectKeys(ctx, namespaces)` (candidates come **only** from the fleet index — never invented)
   → `buildFleetQueryScopeFromProjects`.
   `GetSystemStatus` instead calls `buildFleetQueryScopeFromProjects` directly with
   `snapshot.ProjectKeys(namespaces)` so it uses exactly one snapshot.
2. `buildFleetQueryScopeFromProjects` :62 — `uniqueFleetProjectKeys` (drops empty ns/name, dedupes).
   - `authorizer == nil` → `unrestrictedFleetQueryScope` :~136 grants **all** capabilities on all projects.
   - `principal == nil` → error wrapping `auth.ErrUnauthorized`.
   - Else `authorizer.AuthorizedProjects(ctx, principal, ActionRead, ResourceApplications, candidates)`
     then **`intersectFleetProjects(actual, authorized)`** :~117 — iterates the *actual* candidates,
     not the authorizer's response, so an authorizer cannot invent visibility.
3. `authorizedFleetQueryScope` :~96 builds
   `fleet.QueryScope{Projects: ProjectSet, CapabilitiesByProject: map[ProjectKey]CapabilitySet}`,
   calling `authorizeFleetCapabilities` :~152 once per project — one `Authorize` call **per grant**
   (3 per project). `errors.Is(err, auth.ErrUnauthorized)` → skip that grant; any other error aborts
   the whole request.
4. `fleet.QueryScope.SortedCapabilities(project)` (`internal/fleet/filter.go:37`) returns a stable
   sorted copy, and **returns empty for a project not in `scope.Projects`**, so capability entries
   can never leak visibility. Attached at `internal/fleet/pagination.go:90` and
   `internal/fleet/status.go:99`.
5. `fleetApplicationResultToProto` (`fleet_handler.go:550`) maps
   `result.Capabilities` → `[]paprikav1.FleetCapability` via `fleetCapabilityToProto` :835.

Capability enum (`internal/fleet/filter.go:14-25`): `CapabilityUnspecified=0`,
`CapabilityApplicationSync=1`, `CapabilityReleaseRollback=2`, `CapabilityGateApprove=3`,
`CapabilityPipelineRetry=4`.

**To add a capability** (e.g. hold-rollout, ignore-drift, patch, selective-sync) you must touch, in
order: `internal/fleet/filter.go` (new `Capability` const) → `proto/paprika/v1/api.proto`
(`FleetCapability` enum value) → `internal/api/fleet_handler.go:835` (`fleetCapabilityToProto`) →
`internal/api/fleet_capabilities.go:20-38` (new `fleetCapabilityGrant`) →
`internal/api/fleet_contract_test.go:80-84` (enum expectation) → `fleet_capabilities_test.go`.
Note `unrestrictedFleetQueryScope` and `authorizeFleetCapabilities` both size the map with
`make(fleet.CapabilitySet, 4)` — a hint, not a limit.

---

## 6. Contract tests and the house testing pattern

### `internal/api/fleet_contract_test.go` (728 lines) — the descriptor lock

**`TestFleetDescriptor`** (:16)
1. `assertLegacyFleetDescriptors(t, file)` :514 — see below.
2. Locks **13 enums** value-by-value with exact name→number maps (:20-104): `FleetHealth`,
   `FleetSyncState`, `FleetSourceType`, `FleetReleaseState`, `FleetRolloutState`, `FleetSortField`,
   `FleetSortDirection`, `FleetGroupDimension`, `FleetSizeMetric`, `FleetFacetDimension`,
   `FleetCapability`, `FleetConnectionState`, `FleetMapNodeKind`.
   The assertion is `require.Equalf(wantValues, gotValues)` — **adding one enum value fails the test.**
3. `assertFleetMessageDescriptors(t, file.Messages())` :482 — `require.Len(fleetMessageDescriptorContracts, 15)`
   then, for each of the 15 fleet messages, asserts **exact field count**
   (`require.Equalf(len(wantFields), message.Fields().Len(), ...)`) plus per-field
   number / kind / cardinality / referenced type / containing-oneof.
   The 15: `FleetObjectKey`, `FleetFilter`, `StageTargetSummary`, `ApplicationSummary`,
   `FleetFacetBucket`, `FleetHealthBucket`, `QueryApplicationsRequest`, `QueryApplicationsResponse`,
   `FleetMapNode`, `QueryFleetMapRequest`, `QueryFleetMapResponse`, `FleetMatrixHeader`,
   `FleetMatrixCell`, `QueryFleetMatrixRequest`, `QueryFleetMatrixResponse`.
4. Asserts the three `fleetQueryServiceMethods` exist with exact input/output/streaming flags.

**`assertLegacyFleetDescriptors`** (:514) — the hard constraint:
- `require.Len(legacyFleetMessageDescriptorHashes, 120, "snapshot must cover every pre-existing top-level message")`
- For each of those 120 messages: `proto.MarshalOptions{Deterministic:true}.Marshal(protodesc.ToDescriptorProto(message))`
  then `sha256`, compared against a hard-coded hex digest (`:607-728`).
  **Any field added to any of these 120 messages changes its hash and fails.**
  The list includes `Application`, `Pipeline`, `Release`, `Stage`, `Rollout`, `ResourceSync`,
  `ResourceHealth`, `GetResourceResponse`, `ResourceNode`, `ResourceTreeNode`, `GetApplicationResponse`,
  `LogChunk`, etc.
- `require.Len(legacyFleetServiceMethods, 37)` and `require.Len(fleetQueryServiceMethods, 3)`;
  `require.GreaterOrEqual(methods.Len(), 40)`.
- **Positional** checks: `methods.Get(i)` for `i` in `0..36` must equal `legacyFleetServiceMethods[i]`;
  `methods.Get(37..39)` must equal `fleetQueryServiceMethods[0..2]`.
  → **New RPCs must be appended at the end of `service PaprikaService` (after `GetSystemStatus`,
  index 40). Reordering or inserting anywhere earlier fails.**

**`TestSystemStatusContract`** (:117) — field-by-field lock on `FleetSyncBucket`,
`GetSystemStatusRequest` (also `require.True(request.Fields().ByName("namespace").HasPresence())` →
`optional string namespace = 1`), `GetSystemStatusResponse`, plus the `GetSystemStatus` method
descriptor.

**Practical implication for this redesign:** adding new data means either (a) brand-new messages +
brand-new RPCs appended at the end — cheapest, no hash churn — or (b) editing an existing message,
in which case you must recompute and update the hash in `legacyFleetMessageDescriptorHashes`
(and, for the 15 fleet messages, update `fleetMessageDescriptorContracts` field counts and entries).
Adding new *messages* does not break the `Len(...) == 120` assertion because the map is a
snapshot of pre-existing messages, not a total count of the file's messages — but adding a new
enum **value** to a locked enum does break `TestFleetDescriptor`.

### `internal/api/system_status_handler_test.go` (391 lines) — the behavioural lock

Tests (all `t.Parallel()`), and what each locks down:
- `TestGetSystemStatusValidatesRequest` :19 — nil request, `AttentionLimit > 100`, non-DNS-1123
  namespace, and **explicitly-set empty namespace** all → `CodeInvalidArgument`.
- `TestGetSystemStatusAttentionLimits` :42 — default limit 20; explicit 1 and 100 honoured;
  `AttentionTotal` and `HasMoreAttention` correct with 101 apps.
- `TestGetSystemStatusLoadsExactlyOneConsistentSnapshot` :76 — asserts `reader.loadCalls == 1` and
  that a snapshot swapped in mid-request is not observed. **One `LoadSnapshot()` per request.**
- `TestGetSystemStatusReturnsFixedOrderedBuckets` :99 — health buckets always length 7 in fixed enum
  order, sync buckets always length 4, even when empty.
- (`:~170-218`) authorization isolation — builds a two-tenant snapshot, proves the unrestricted scope
  *would* leak, then with an `auth.NewRBACAuthorizer` restricted to `tenant-a/payments` asserts the
  response contains only the visible app and **`protojson.Marshal`s the response and asserts none of
  8 secret marker strings appear anywhere in the encoded output** (`tenant-b`, `secret-app-marker`,
  `secret-project-marker`, `secret-revision-marker`, `secret-cluster-marker`, `secret-target-marker`,
  `secret-stage-marker`, `secret-cluster-label-marker`). **Copy this marker technique for any new
  multi-tenant read RPC.**
- `TestGetSystemStatusEmptyAuthorizedScopeSucceeds` :220 — empty authorized scope returns a valid
  zeroed response (not an error) and calls `AuthorizedProjects` exactly once.
- `TestGetSystemStatusErrorMappingIsGeneric` :248 — nil index → `Unavailable`;
  `fleet.ErrUnavailable` → `Unavailable`; arbitrary snapshot error → `Internal` **with the marker
  string absent from `err.Error()`**; authorizer denial → `PermissionDenied`; authorizer error →
  `Internal`; missing principal → `PermissionDenied` with the words "missing principal" **not** leaked.

Test doubles / helpers defined there (reusable):
- `systemStatusReader` :303 — a `fleet.Reader` whose `ProjectKeys`/`QueryApplications`/`QueryMap`/
  `QueryMatrix` **panic** ("GetSystemStatus must derive projects from its loaded snapshot"), counting
  `LoadSnapshot` calls and supporting an `afterLoad` mutation hook.
- `systemStatusApplication(ns, name, project, health, sync)` :339
- `buildSystemStatusSnapshot(t, generation, apps)` :347 — builds via `fleet.NewIndex()` +
  `installFleetAuthorizationSnapshot` + `fleet.NewSnapshot(generation)` + `index.Install(...)`.
- `pointerTo[T]` :375, `systemStatusHealthCounts` :377, `systemStatusSyncCounts` :385.

### House pattern for testing a handler

**Fleet-style (no cluster):**
```go
server := NewPaprikaServer(nil, nil, WithFleetIndex(reader), WithAuthorizer(authorizer))
ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})
resp, err := server.GetSystemStatus(ctx, connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))   // errors asserted by connect.Code
```
The `client` and `broker` args are `nil` — fleet handlers never touch Kubernetes.
Fakes: `recordingFleetReader` (`fleet_handler_test.go:748`) captures the query struct it was handed
so tests can assert defaulting; `fleetScopeAuthorizer` (`fleet_capabilities_test.go:294`) records
`authorizedCalls []fleetAuthorizedProjectsCall` and `authorizeCalls []fleetPermissionCall`, and
**defaults to `auth.ErrUnauthorized`** when no `authorize` func is supplied (fail-closed by default).
`installFleetAuthorizationSnapshot` (`fleet_handler_test.go:803`) + `addFleetTestPosting` :836
populate every inverted index consistently — **reuse these, do not hand-build snapshots.**

**CRD-style (`resource_handler_test.go`, `pipeline_handler_test.go`, `apply_bundle_test.go`, etc.):**
```go
scheme := runtime.NewScheme()
clientgoscheme.AddToScheme(scheme); pipelinesv1alpha1.AddToScheme(scheme)
c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, tmpl, release).
        WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).Build()
dynClient := dynamicfake.NewSimpleDynamicClient(dynScheme, liveDeployment, liveWidget)
k8s       := k8sfake.NewSimpleClientset(eventList, podList)
mapper    := meta.NewDefaultRESTMapper(...); mapper.AddSpecific(gvk, gvr, singular, meta.RESTScopeNamespace)
server := NewPaprikaServer(c, nil, WithK8sClient(k8s), WithDynamicClient(dynClient),
                           WithRESTMapper(mapper), WithRenderer(&fakeRenderer{manifests: ...}))
```
(`resource_handler_test.go:58-192`). `fakeRenderer` :34 stubs `pipelines.SourceResolvingRenderer`.
Assertions use `github.com/stretchr/testify/require`. Table-driven subtests use
`map[string]struct{...}` with `t.Parallel()` in both parent and child.

Other test files in the package: `analysis_handler_test.go`, `apply_bundle_test.go`,
`artifact_handler_test.go`, `audit_middleware_test.go`, `fleet_capabilities_test.go`,
`fleet_handler_test.go`, `github_actions_token_exchange_test.go`, `investigator_handler_test.go`,
`pipeline_handler_test.go`, `release_handler_test.go`, `resource_handler_test.go`,
`resource_logs_handler_test.go`, `resource_tree_handler_test.go`, `rollout_handler_test.go`,
`sse_test.go`, `stream_resource_logs_handler_test.go`, `uihandler_test.go`, and
`auth/{auth_test.go, authz_project_set_test.go, project_authorizer_test.go}`,
`events/broker_test.go`.

### Error-code mapping (`mapFleetError`, `fleet_handler.go:186`)
| Go error | connect code | message actually returned |
|---|---|---|
| `*fleet.ErrUnavailable` | `Unavailable` | the typed error's own safe reason |
| `*fleet.ErrInvalidCursor` | `InvalidArgument` | `"invalid fleet cursor"` |
| `*fleet.InvalidSearchError` | `InvalidArgument` | `"invalid fleet search"` |
| `*fleet.ErrInvalidMatrixAxes` | `InvalidArgument` | `"invalid fleet matrix axes"` |
| `errors.Is(auth.ErrUnauthorized)` | `PermissionDenied` | `"fleet query is not authorized"` |
| `context.Canceled` / `DeadlineExceeded` | `Canceled` / `DeadlineExceeded` | passthrough |
| anything else | `Internal` | `"fleet query failed"` (**original message discarded on purpose**) |

**House rule: fleet-path errors are sanitized. Legacy CRD-path handlers do the opposite —
they `fmt.Errorf("getting application: %w", err)` and leak the raw Kubernetes error.**

---

## 7. `GetSystemStatus` — exactly what it returns and how

File: `internal/api/system_status_handler.go` (111 lines). Const `maxSystemStatusAttentionLimit = 100`.

### Handler (`:16-50`)
```go
namespaces, err := validateSystemStatusRequest(req)   // :52
reader, err := s.requireFleetIndex()                  // fleet_handler.go:179
snapshot, err := reader.LoadSnapshot()                // exactly ONE load
if snapshot == nil { → &fleet.ErrUnavailable{Reason: "fleet snapshot is unavailable"} }
scope, err := buildFleetQueryScopeFromProjects(ctx, s.authorizer,
                  auth.PrincipalFromContext(ctx), snapshot.ProjectKeys(namespaces))
status, err := snapshot.QueryStatus(scope, fleet.StatusQuery{
                  Filter: fleet.ApplicationFilter{Namespaces: namespaces},
                  AttentionLimit: req.Msg.AttentionLimit})
return connect.NewResponse(fleetSystemStatusToProto(&status))
```
Note it uses `buildFleetQueryScopeFromProjects` (not `buildFleetQueryScope`) so project candidates
come from the **same** snapshot as the aggregation — no second read, no torn view.

### Request validation (`validateSystemStatusRequest`, `:52-68`)
- `req == nil || req.Msg == nil` → InvalidArgument "request is required"
- `AttentionLimit > 100` → InvalidArgument
- `Namespace == nil` (unset) → `namespaces = nil` (whole authorized fleet)
- `Namespace` set → must pass `validation.IsDNS1123Label`; `""` therefore fails.

### Aggregation (`Snapshot.QueryStatus`, `internal/fleet/status.go:55-104`)
Pure in-memory, no live reads.
1. `s.FilterApplications(scope, query.Filter, "")` — authorization + namespace filter.
2. `Total = len(filtered.IDs)`.
3. Health histogram over 7 buckets (`newHealthStatusBuckets` :106), sync histogram over 4
   (`newSyncStatusBuckets` :118). Out-of-range values collapse into `Unspecified`
   (`statusHealthBucket` :127, `statusSyncBucket` :134).
4. For every filtered app builds an `attentionEntry` (`:141`) with
   `healthSeverity, syncSeverity, blockedGates, changeSeverity, unhealthyConnections,
   resourceCount, lastTransitionUnixMS`.
   - `healthSeverity` (`:162`): Healthy 0, Unspecified 1, Unknown 2, Progressing 3, Degraded 4,
     Missing 5, Failed 6.
   - `syncSeverity` (`:183`): Synced 0, Unspecified 1, Unknown 2, OutOfSync 3.
   - `changeSeverity` (`:198`) = max(releaseChangeSeverity, rolloutChangeSeverity).
     Release: Complete/Superseded 1, Pending/Promoting/Canarying/Verifying 2, AwaitingApproval 3,
     RolledBack 4, Failed 5. Rollout: Healthy 1, Pending/Progressing 2, Paused 3, RolledBack 4,
     Degraded/Failed/Aborted 5.
   - `unhealthyConnectionCount` (`:248`) — de-duplicated count over repository, effective
     observability source, and each target cluster whose connection is `ConnectionStateUnhealthy`
     **and** whose object key is complete.
5. `needsAttention` (`:154`): `healthSeverity >= severity(Unknown)=2 || syncSeverity >= 2 ||
   blockedGates > 0 || changeSeverity >= 3 || unhealthyConnections > 0`.
6. Sort by `compareAttention` (`:271`) — descending on
   healthSeverity → syncSeverity → blockedGates → changeSeverity → unhealthyConnections →
   resourceCount → lastTransitionUnixMS, tie-broken ascending by namespaced identity
   (`compareObjectKeys`) so output is fully deterministic.
7. `AttentionTotal = len(attention)`; limit = `query.AttentionLimit` or `defaultAttentionLimit = 20`
   (`status.go:9`); truncate; each entry becomes
   `ApplicationQueryResult{Summary: cloneQueryApplicationSummary(...), Capabilities: scope.SortedCapabilities(project)}`.
8. `HasMoreAttention = AttentionTotal > len(Attention)`.

`fleet.Status` (`status.go:43-51`): `Generation, Total, Health map[Health]uint64,
Sync map[SyncState]uint64, AttentionTotal, Attention []ApplicationQueryResult, HasMoreAttention`.

### Proto shaping (`fleetSystemStatusToProto`, `system_status_handler.go:70-110`)
Emits fixed-length, fixed-order slices regardless of content:
- `health` — always 7 `FleetHealthBucket`s in order `UNSPECIFIED, HEALTHY, PROGRESSING, DEGRADED,
  FAILED, UNKNOWN, MISSING`.
- `sync` — always 4 `FleetSyncBucket`s in order `UNSPECIFIED, SYNCED, OUT_OF_SYNC, UNKNOWN`.
- `attention` — `[]*paprikav1.ApplicationSummary` via `fleetApplicationResultToProto`
  (`fleet_handler.go:550`), i.e. the same 22-field summary used by `QueryApplications`, including
  per-project `capabilities`.

### Wire shape (`proto/paprika/v1/api.proto:1043-1056`)
```proto
message GetSystemStatusRequest  { optional string namespace = 1; uint32 attention_limit = 2; }
message GetSystemStatusResponse {
  uint64 index_generation = 1;  uint64 total = 2;
  repeated FleetHealthBucket health = 3;  repeated FleetSyncBucket sync = 4;
  uint64 attention_total = 5;  repeated ApplicationSummary attention = 6;
  bool has_more_attention = 7;
}
```

**What `GetSystemStatus` does NOT return today:** cluster counts, node counts, capacity, cost,
request/latency/error rates, rollout durations, pipeline stats, or any time series. It is purely a
health/sync histogram plus a ranked attention list.

---

## 8. Events / SSE

`internal/api/events/broker.go` (303 lines):
- `Broker` :30, `NewBroker(log)` :41 (in-memory), `NewRedisBroker` :56 /
  `NewRedisBrokerWithContext` :62 (Redis pub/sub fan-out across replicas),
  `NewBrokerFromEnv` :86, `Subscribe` :125, `Unsubscribe` :151, `Publish` :167,
  `publishLocal` :182, `receiveLoop` :203, `Close` :222, `Topics` :255.
- Constants :265-280: `TopicDashboard = "dashboard"`; types `TypeApplication`, `TypeRelease`,
  `TypeRollout`, `TypeAudit`, `TypeGate`, `TypePipeline`, and (in `eventtypes.go:32`)
  `TypePipelineArtifact = "pipeline-artifact"`.
- `NewEvent(eventType, payload, clk)` :283; `type Event { Type string; Payload json.RawMessage; Timestamp time.Time }` :299.
- Payload structs (`eventtypes.go`): `EventPayload` :5 (resourceType, name, namespace, phase,
  previousPhase, reason, message, timestamp, startedAt, completedAt) and `AuditPayload` :19.

**There is currently no authenticated push transport to the browser.** `/events` is
`http.NotFoundHandler()` in `cmd/main.go:1001`, `cmd/cloud-run/main.go:282`, and
`test/fleetconsole/server.go:50`. A source-trigger/webhook event feed therefore needs either a new
unary "list recent events" RPC, or a new server-streaming RPC (follow the `StreamResourceLogs`
`logChunkSink` pattern), not a revival of raw SSE.

---

## 9. Metrics already wired

OTel (`internal/metrics/otel.go`): `paprika.auth.attempts` :41, `paprika.auth.failures` :44,
`paprika.authz.denials` :47, `paprika.authz.decisions` :50, `paprika.api.list.duration` :56,
`paprika.api.list.errors` :59, `paprika.api.list.items` :62, `paprika.api.cache.sync.duration` :65.
Fleet (`internal/metrics/fleet.go`): `FleetQueryKind` :22 with values `project_keys`, `applications`,
`map`, `matrix` :25-28; `RecordFleetQuery` :249. **Any new fleet query kind should be added to
`FleetQueryKind` and `normalizeFleetQueryKind` :303 or it is recorded as unknown.**
Prometheus (legacy, direct client): `metrics.APIRequestDuration` / `APIRequestTotal` used by
`MetricsMiddleware`. `AGENTS.md` says: **use the OTel SDK for new metrics, not the Prometheus client.**

---

## 10. What is absent, plainly — and the nearest existing thing

| Design need | Status in `internal/api` / proto | Nearest existing thing |
|---|---|---|
| Cluster infrastructure (node count, region, k8s version, pod counts, connection state, cluster list) | **Absent.** No `Cluster` message, no `ListClusters`/`GetCluster` RPC. | `api/clusters/v1alpha1/cluster_types.go` CRD exists and is informed into the fleet index (`internal/fleet/runtime.go:124`). `ClusterStatus` has `Phase`, `Version` (k8s version), `Conditions`, `LastHealthCheckTime`, `AgentInfo{Version,Connected,Address}` — but **no node count, region, or pod counts**. `fleet.ClusterSummary` (`internal/fleet/model.go:188`) keeps only `{Identity, DisplayName, Connection}`, and `paprikav1.FleetObjectKey` + `FleetConnectionState` are the only cluster data reaching the wire. |
| CPU/memory used / requested / allocatable per cluster | **Absent** everywhere. | Nothing. Would require live node/pod reads or a metrics source. |
| Per-app request rate / latency / error rate | **Partially scaffolded.** `FLEET_SIZE_METRIC_REQUEST_RATE` enum exists (`api.proto:931`) and `FleetMapNode.RequestRateWeight/EffectiveWeight/UsedResourceFallback` are already on the wire. | `fleet.WeightReader` / `TargetWeightKey` (`internal/fleet/map.go:40-54`); `Index.QueryMap`/`QueryMatrix` pass `nil` (`internal/fleet/reader.go:109`, comment at :93). **Implement `WeightReader` and thread it through `Index` — the query layer already handles it.** Latency and error rate have no equivalent. |
| Cost per application / per cluster, monthly | **Absent.** No message, field, RPC, or CRD field. | Nothing. |
| Source-trigger / webhook event feed | **Absent from the RPC surface.** | Webhook receiver exists at `/webhook` (`internal/webhookreceiver`, wired at `cmd/main.go:774`) and the `events.Broker` can already fan out via Redis — but `/events` SSE is fail-closed and there is no history store and no RPC. |
| Rollout history (completed rollouts, durations, outcomes, medians) | **Absent.** | `ListRollouts` (`server.go:842`) / `GetRollout` :869 return only *current* Rollout objects; `convertRollout` :999 exposes strategy/steps/analysis but no duration or completion history. |
| Pipeline run history, test counts, cache-hit rate, CPU-minutes, per-step resource requests | **Absent.** | `ListPipelines` :303 / `GetPipeline` (`pipeline_handler.go:49`) return current Pipeline objects; `convertPipeline` :1290 and `StepStatus` carry phase + timestamps only. |
| Commit metadata (author, message, run number) | **Absent.** | `ApplicationSummary.SourceRevision` (a bare revision string) and `Release`'s revision fields. |
| Ownership metadata (owner, on-call, tier, runbook / drilldown URLs) | **Absent.** | Only generic Kubernetes labels/annotations on the Application, which `convertApplication` (`server.go:1463`) does not currently project. |
| Per-resource drift detail (changed-field counts, drift timestamps, drift reasons) | **Absent.** | `ApplicationSummary.DriftCount` / `MissingResourceCount` (whole-app counters only) and `GetResource`'s unified `diff` string (`resource_handler.go:376`). Per-resource state is a single `Status` string in `ResourceSync`. |
| 6-phase lifecycle vector (source, build, test, render, deploy, verify) | **Absent.** | `Application.Status.Phase` (single string) and `Pipeline.Status.StepStatuses`. |
| Mutations: hold rollout, ignore drifted field, apply JSON patch, selective per-resource sync | **All absent.** | `PromoteRollout` :884 / `AbortRollout` :910 (annotation/status writes), `SyncApplication` :658 (sets `paprika.io/sync` + `paprika.io/manual-sync` annotations — whole-app only), `ApplyBundle` (whole-bundle apply). |

---

## 11. Checklist for adding a new RPC (derived from the constraints above)

1. Append the RPC **at the end** of `service PaprikaService` in `proto/paprika/v1/api.proto`
   (after `GetSystemStatus`) — positional assertions in `fleet_contract_test.go:532-538` forbid
   insertion earlier.
2. Prefer **new messages** over editing any of the 120 hash-locked ones; adding a field to a locked
   message means recomputing its SHA-256 in `legacyFleetMessageDescriptorHashes`
   (`fleet_contract_test.go:607-728`), and for the 15 fleet messages also updating
   `fleetMessageDescriptorContracts` (field count is asserted exactly).
3. Adding a value to any of the 13 locked enums requires updating `wantEnums`
   (`fleet_contract_test.go:20-104`).
4. Give the request message a `namespace` (and `project`, where meaningful) field so
   `namespaceFromRequest` / `projectFromRequest` (`auth/middleware.go`) can feed coarse authz.
5. Regenerate: install `protoc-gen-go`, `protoc-gen-connect-go`, and `(cd ui && npm ci)`, then
   `make generate-proto` — it silently skips otherwise.
6. Implement the method on `*PaprikaServer` in a new `internal/api/<topic>_handler.go`
   (one file per topic is the house convention). The `var _ v1connect.PaprikaServiceHandler`
   assertion at `server.go:201` will otherwise fail the build.
7. Authorization: CRD-path → `s.authorizeApplication` / `s.authorizeProjectFromLabels` /
   `s.authorizeProject`. Fleet-path (multi-project) → `buildFleetQueryScope(...)` **and** add the
   procedure to `defersProjectSetAuthorization` (`auth/middleware.go:79-89`).
8. Check `classify` (`auth/middleware.go`) gives the RPC a sensible `(action, resource)`; extend
   `resourceKeywords` if not.
9. If the RPC is mutating, make sure `classifyAudit` (`audit_middleware.go:91`) recognises the verb
   prefix, or add it to `auditVerbs` :18 — otherwise the mutation is silently un-audited.
10. Errors: sanitize on the fleet path (`mapFleetError`), and never let raw backend text escape —
    `TestGetSystemStatusErrorMappingIsGeneric` is the template.
11. Tests: unit test the handler with `NewPaprikaServer(nil, nil, With…)` + `connect.NewRequest`,
    assert with `connect.CodeOf(err)`, and add a multi-tenant `protojson.Marshal` leak assertion for
    any tenant-scoped read.
12. Add fixture data to `test/fleetconsole/server.go` so the console can be driven without a cluster.
13. Verification per `AGENTS.md`: `go build ./...`, `go vet ./internal/... ./cmd/...`, plus
    `go test ./internal/api/... ./internal/fleet/... -count=1`.

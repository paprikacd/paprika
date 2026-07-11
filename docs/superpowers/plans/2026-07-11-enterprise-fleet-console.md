# Enterprise Fleet Console Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client-joined dashboard with an authorized, indexed fleet-query API and a unified treemap-first operations shell that remains responsive at 10,000 Applications.

**Architecture:** A process-local `FleetIndex` projects informer events into immutable query snapshots and exposes filtered summaries, facets, treemap nodes, and Matrix cells through additive Connect RPCs. The static Next.js UI uses one URL-query codec and TanStack Query to render Treemap, Matrix, and virtualized Table/Queue presentations over the same server-side query.

**Tech Stack:** Go 1.26.0, controller-runtime cache/informers, Connect RPC/protobuf, OpenTelemetry, Next.js 16, React 19, TypeScript, TanStack Query/Virtual, d3-hierarchy, Vitest/Testing Library, Playwright.

**Approved spec:** `docs/superpowers/specs/2026-07-11-enterprise-operations-console-design.md`

**Execution skills:** `@superpowers:test-driven-development`, `@frontend-development`, `@vercel-react-best-practices`, and `@superpowers:verification-before-completion`.

---

## Chunk 1: Indexed Fleet API and Console

### File structure

- `internal/fleet/model.go` — provider-neutral fleet records and query/result types only.
- `internal/fleet/snapshot.go` — immutable snapshot, generation, exact indexes, and atomic loading.
- `internal/fleet/health.go` — serving availability versus readiness/degraded health.
- `internal/fleet/search.go` — NFKC normalization, trigram postings, and relevance ordering.
- `internal/fleet/projection.go` — Application, Stage, Release, and Rollout projection.
- `internal/fleet/connection_projection.go` — Repository and Cluster summaries/reverse dependencies.
- `internal/fleet/optional_source.go` — optional future source projector contract with no Plan-3 API import.
- `internal/fleet/rebuild.go` — initial/full rebuild and queued-delta replay.
- `internal/fleet/filter.go` — authorized set filtering only.
- `internal/fleet/facets.go` — self-excluding facet calculation only.
- `internal/fleet/cursor.go` and `pagination.go` — query hashing, opaque cursors, and deterministic pages.
- `internal/fleet/map.go` and `matrix.go` — treemap and actual-target Matrix aggregation.
- `internal/fleet/runtime.go` and `store.go` — informer registration, cache-store reads, workers, and shutdown.
- `internal/api/fleet_handler.go` and `fleet_capabilities.go` — validation, authorization scope, conversion, and capabilities.
- `internal/metrics/fleet.go` — OTel instruments; no direct Prometheus client.
- `ui/src/lib/fleet-query.ts` — the only URL codec and fleet query-key builder.
- `ui/src/lib/fleet-client.ts` and `fleet-pages.ts` — Connect mapping, cursor reset, and identity de-duplication.
- `ui/src/lib/fleet-refresh.ts` — bounded polling/focus refresh; no raw SSE.
- `ui/src/components/layout/` — persistent shell, scope bar, and responsive navigation.
- `ui/src/components/fleet/` — focused filters, layout/navigation helpers, treemap, Matrix, table, queue, and states.
- `test/fleetconsole/` — real `PaprikaServer`, deterministic seed store, and compiled static-UI server.
- `ui/e2e/` and `hack/test-fleet-scale.sh` — browser smoke and controlled 10k scale gates.

### Task 1: Add additive fleet query contracts

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Create: `internal/api/fleet_contract_test.go`
- Create: `internal/api/fleet_handler.go`
- Create: `internal/api/fleet_handler_test.go`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.{js,d.ts}`
- Generated: `ui/src/gen/paprika/v1/api_connect.{js,d.ts}`

- [ ] **Step 1: Write the compile-failing descriptor tests**

In `fleet_contract_test.go`, assert every new message/enum/RPC below exists with the shown field numbers. Snapshot the existing service method names and existing message descriptors before editing and assert they are still present afterward. In `fleet_handler_test.go`, table-test page size `0→100`, `501` rejection, 128-rune search acceptance, 129-rune rejection, unknown enum rejection, same Matrix axes rejection, and optional empty cursor acceptance.

- [ ] **Step 2: Verify the symbols are absent**

Run: `rtk go test ./internal/api -run 'TestFleet(Descriptor|Validation)' -count=1`

Expected: compile failure for undefined fleet messages/RPC methods.

- [ ] **Step 3: Append the frozen wire contract**

Append the following definitions immediately before `service PaprikaService`. New messages own their field-number spaces, so these allocations cannot collide with existing messages. Do not renumber, remove, reserve, or reinterpret any existing field. Append the three RPCs after the existing `ListInvestigatorPlugins` RPC.

```proto
enum FleetHealth {
  FLEET_HEALTH_UNSPECIFIED = 0; FLEET_HEALTH_HEALTHY = 1;
  FLEET_HEALTH_PROGRESSING = 2; FLEET_HEALTH_DEGRADED = 3;
  FLEET_HEALTH_FAILED = 4; FLEET_HEALTH_UNKNOWN = 5; FLEET_HEALTH_MISSING = 6;
}
enum FleetSyncState {
  FLEET_SYNC_STATE_UNSPECIFIED = 0; FLEET_SYNC_STATE_SYNCED = 1;
  FLEET_SYNC_STATE_OUT_OF_SYNC = 2; FLEET_SYNC_STATE_UNKNOWN = 3;
}
enum FleetSourceType {
  FLEET_SOURCE_TYPE_UNSPECIFIED = 0; FLEET_SOURCE_TYPE_GIT = 1;
  FLEET_SOURCE_TYPE_HELM = 2; FLEET_SOURCE_TYPE_KUSTOMIZE = 3;
  FLEET_SOURCE_TYPE_S3 = 4; FLEET_SOURCE_TYPE_OCI = 5; FLEET_SOURCE_TYPE_INLINE = 6;
}
enum FleetReleaseState {
  FLEET_RELEASE_STATE_UNSPECIFIED = 0; FLEET_RELEASE_STATE_PENDING = 1;
  FLEET_RELEASE_STATE_PROMOTING = 2; FLEET_RELEASE_STATE_CANARYING = 3;
  FLEET_RELEASE_STATE_VERIFYING = 4; FLEET_RELEASE_STATE_COMPLETE = 5;
  FLEET_RELEASE_STATE_FAILED = 6; FLEET_RELEASE_STATE_ROLLED_BACK = 7;
  FLEET_RELEASE_STATE_SUPERSEDED = 8; FLEET_RELEASE_STATE_AWAITING_APPROVAL = 9;
}
enum FleetRolloutState {
  FLEET_ROLLOUT_STATE_UNSPECIFIED = 0; FLEET_ROLLOUT_STATE_PENDING = 1;
  FLEET_ROLLOUT_STATE_PROGRESSING = 2; FLEET_ROLLOUT_STATE_PAUSED = 3;
  FLEET_ROLLOUT_STATE_HEALTHY = 4; FLEET_ROLLOUT_STATE_DEGRADED = 5;
  FLEET_ROLLOUT_STATE_FAILED = 6; FLEET_ROLLOUT_STATE_ROLLED_BACK = 7;
  FLEET_ROLLOUT_STATE_ABORTED = 8;
}
enum FleetSortField {
  FLEET_SORT_FIELD_UNSPECIFIED = 0; FLEET_SORT_FIELD_NAME = 1;
  FLEET_SORT_FIELD_PROJECT = 2; FLEET_SORT_FIELD_CLUSTER = 3;
  FLEET_SORT_FIELD_STAGE = 4; FLEET_SORT_FIELD_HEALTH = 5;
  FLEET_SORT_FIELD_SYNC = 6; FLEET_SORT_FIELD_RELEASE = 7;
  FLEET_SORT_FIELD_ROLLOUT = 8; FLEET_SORT_FIELD_RESOURCE_COUNT = 9;
  FLEET_SORT_FIELD_LAST_TRANSITION = 10; FLEET_SORT_FIELD_IMPACT = 11;
  FLEET_SORT_FIELD_RELEVANCE = 12;
}
enum FleetSortDirection {
  FLEET_SORT_DIRECTION_UNSPECIFIED = 0; FLEET_SORT_DIRECTION_ASC = 1;
  FLEET_SORT_DIRECTION_DESC = 2;
}
enum FleetGroupDimension {
  FLEET_GROUP_DIMENSION_UNSPECIFIED = 0; FLEET_GROUP_DIMENSION_PROJECT = 1;
  FLEET_GROUP_DIMENSION_CLUSTER = 2; FLEET_GROUP_DIMENSION_STAGE = 3;
  FLEET_GROUP_DIMENSION_HEALTH = 4;
}
enum FleetSizeMetric {
  FLEET_SIZE_METRIC_UNSPECIFIED = 0; FLEET_SIZE_METRIC_RESOURCE_COUNT = 1;
  FLEET_SIZE_METRIC_REQUEST_RATE = 2;
}
enum FleetFacetDimension {
  FLEET_FACET_DIMENSION_UNSPECIFIED = 0; FLEET_FACET_DIMENSION_PROJECT = 1;
  FLEET_FACET_DIMENSION_NAMESPACE = 2; FLEET_FACET_DIMENSION_CLUSTER = 3;
  FLEET_FACET_DIMENSION_STAGE = 4; FLEET_FACET_DIMENSION_HEALTH = 5;
  FLEET_FACET_DIMENSION_SYNC = 6; FLEET_FACET_DIMENSION_RELEASE = 7;
  FLEET_FACET_DIMENSION_ROLLOUT = 8; FLEET_FACET_DIMENSION_SOURCE_TYPE = 9;
}
enum FleetCapability {
  FLEET_CAPABILITY_UNSPECIFIED = 0; FLEET_CAPABILITY_APPLICATION_SYNC = 1;
  FLEET_CAPABILITY_RELEASE_ROLLBACK = 2; FLEET_CAPABILITY_GATE_APPROVE = 3;
  FLEET_CAPABILITY_PIPELINE_RETRY = 4;
}
enum FleetConnectionState {
  FLEET_CONNECTION_STATE_UNSPECIFIED = 0; FLEET_CONNECTION_STATE_HEALTHY = 1;
  FLEET_CONNECTION_STATE_UNHEALTHY = 2; FLEET_CONNECTION_STATE_DISABLED = 3;
  FLEET_CONNECTION_STATE_NOT_CONFIGURED = 4;
}
enum FleetMapNodeKind {
  FLEET_MAP_NODE_KIND_UNSPECIFIED = 0; FLEET_MAP_NODE_KIND_GROUP = 1;
  FLEET_MAP_NODE_KIND_APPLICATION = 2;
}

message FleetObjectKey { string namespace = 1; string name = 2; }
message FleetFilter {
  repeated FleetObjectKey projects = 1;
  repeated string namespaces = 2;
  repeated FleetObjectKey clusters = 3;
  repeated string stages = 4;
  repeated FleetHealth health = 5;
  repeated FleetSyncState sync = 6;
  repeated FleetReleaseState release_states = 7;
  repeated FleetRolloutState rollout_states = 8;
  repeated FleetSourceType source_types = 9;
}
message StageTargetSummary {
  string stable_id = 1; string stage = 2; int32 ring = 3;
  FleetObjectKey cluster = 4; string cluster_label = 5;
  FleetHealth health = 6; FleetConnectionState cluster_connection = 7;
  bool unmanaged_inline_cluster = 8;
}
message ApplicationSummary {
  FleetObjectKey identity = 1; FleetObjectKey project = 2;
  repeated StageTargetSummary targets = 3; string current_stage = 4;
  FleetObjectKey current_cluster = 5; string current_cluster_label = 6;
  FleetSourceType source_type = 7; string source_revision = 8;
  FleetHealth health = 9; FleetSyncState sync = 10;
  uint32 drift_count = 11; uint32 missing_resource_count = 12;
  FleetReleaseState release_state = 13; FleetRolloutState rollout_state = 14;
  uint32 resource_count = 15; FleetObjectKey repository = 16;
  FleetConnectionState repository_connection = 17;
  FleetObjectKey effective_observability_source = 18;
  FleetConnectionState observability_connection = 19;
  uint32 blocked_gate_count = 20; int64 last_transition_unix_ms = 21;
  repeated FleetCapability capabilities = 22;
}
message FleetFacetBucket {
  FleetFacetDimension dimension = 1;
  oneof key { FleetObjectKey object = 2; string value = 3; }
  string label = 4; uint64 count = 5;
}
message FleetHealthBucket { FleetHealth health = 1; uint64 count = 2; }

message QueryApplicationsRequest {
  FleetFilter filter = 1; string search = 2; FleetSortField sort = 3;
  FleetSortDirection direction = 4; uint32 page_size = 5; string cursor = 6;
}
message QueryApplicationsResponse {
  repeated ApplicationSummary applications = 1; uint64 total = 2;
  string next_cursor = 3; uint64 index_generation = 4;
  repeated FleetFacetBucket facets = 5;
}
message FleetMapNode {
  string stable_id = 1; FleetMapNodeKind kind = 2; string label = 3;
  FleetObjectKey application = 4;
  oneof group_key { FleetObjectKey group_object = 5; string group_value = 6; }
  uint64 application_count = 7; uint64 target_count = 8;
  repeated FleetHealthBucket health = 9; uint64 resource_weight = 10;
  double request_rate_weight = 11; double effective_weight = 12;
  bool used_resource_fallback = 13; repeated FleetMapNode children = 14;
}
message QueryFleetMapRequest {
  FleetFilter filter = 1; string search = 2; FleetGroupDimension group = 3;
  FleetSizeMetric size_metric = 4;
}
message QueryFleetMapResponse {
  repeated FleetMapNode roots = 1; uint64 total = 2; uint64 index_generation = 3;
}
message FleetMatrixHeader {
  string stable_id = 1; string label = 2;
  oneof key { FleetObjectKey object = 3; string value = 4; }
}
message FleetMatrixCell {
  string row_id = 1; string column_id = 2;
  uint64 application_count = 3; uint64 target_count = 4;
  repeated FleetHealthBucket health = 5; uint64 resource_weight = 6;
  double request_rate_weight = 7; bool used_resource_fallback = 8;
}
message QueryFleetMatrixRequest {
  FleetFilter filter = 1; string search = 2;
  FleetGroupDimension row_group = 3; FleetGroupDimension column_group = 4;
  FleetSizeMetric size_metric = 5;
}
message QueryFleetMatrixResponse {
  repeated FleetMatrixHeader rows = 1; repeated FleetMatrixHeader columns = 2;
  repeated FleetMatrixCell cells = 3; uint64 total = 4; uint64 index_generation = 5;
}
```

`FleetObjectKey` is mandatory for project/Cluster CR identities throughout filters, summaries, facets, URLs, and query hashes. Empty `cluster` plus a non-empty label represents in-cluster or legacy inline targets; it never aliases a namespaced Cluster.

- [ ] **Step 4: Add RPCs and regenerate only protobuf outputs**

```proto
rpc QueryApplications(QueryApplicationsRequest) returns (QueryApplicationsResponse);
rpc QueryFleetMap(QueryFleetMapRequest) returns (QueryFleetMapResponse);
rpc QueryFleetMatrix(QueryFleetMatrixRequest) returns (QueryFleetMatrixResponse);
```

Run: `cd ui && rtk npm ci`

Run: `rtk make generate-proto`

Run: `rtk git diff --check`

Expected: Go and JS/DTS clients regenerate; no non-protobuf generated files change; diff check is clean.

- [ ] **Step 5: Write failing handler validation tests**

Add the validation table described in Step 1. Cursor content is not decoded yet: empty and non-empty cursors pass structural request validation and valid requests return `Unimplemented`. Cursor schema/query validation belongs to Task 4.

- [ ] **Step 6: Add validation-only handler methods**

Default page size to 100, cap it at 500, count search by Unicode runes, require valid group/size/sort enums, reject equal Matrix axes, and return `Unimplemented` after validation. Do not query Kubernetes.

- [ ] **Step 7: Run and commit the contract**

Run: `rtk go test ./internal/api -run 'TestFleet(Descriptor|Validation)' -count=1`

Expected: PASS.

```bash
rtk git add proto/paprika/v1/api.proto internal/api/fleet_contract_test.go internal/api/fleet_handler.go internal/api/fleet_handler_test.go internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts
rtk git commit -m "feat(api): add fleet query contracts"
```

### Task 2: Build immutable snapshots and deterministic name search

**Files:**
- Create: `internal/fleet/model.go`
- Create: `internal/fleet/snapshot.go`
- Create: `internal/fleet/health.go`
- Create: `internal/fleet/search.go`
- Create: `internal/fleet/search_test.go`
- Create: `internal/fleet/snapshot_test.go`
- Create: `internal/fleet/fixtures_test.go`

- [ ] **Step 1: Write failing normalization/ranking tests**

Cover Unicode NFKC, lowercase/trim, equivalent `-`/`_`/`.`/repeated-space separators, 128-rune rejection, exact→prefix→substring→trigram ordering, the 0.3 cutoff, and namespace/name ties for duplicate names.

- [ ] **Step 2: Verify search types are missing**

Run: `rtk go test ./internal/fleet -run 'Test(Normalize|Search)' -count=1`

Expected: FAIL because `internal/fleet` is absent.

- [ ] **Step 3: Implement models and search only**

Keep Kubernetes objects out of query models. `ProjectKey` and `ClusterKey` are aliases of `types.NamespacedName`. A `StageTargetSummary` always represents one real Stage→cluster pair. Search first intersects its caller-supplied candidate ID set, then ranks exact, prefix, substring, and trigram similarity; ties end with application namespace/name.

- [ ] **Step 4: Write failing snapshot consistency tests**

Race a reader against 1,000 swaps and assert each observed generation matches the records in that same snapshot. Assert no installed snapshot map/slice is mutated and initial health is unavailable.

- [ ] **Step 5: Implement atomic snapshot and separate health**

```go
type Snapshot struct {
    Generation   uint64
    Applications map[types.NamespacedName]ApplicationSummary
    Projects     map[ProjectKey]ProjectSummary
    ByProject    map[ProjectKey]IDSet
    ByNamespace  map[string]IDSet
    ByCluster    map[ClusterKey]IDSet
    ByStage      map[string]IDSet
    ByHealth     map[Health]IDSet
    BySync       map[SyncState]IDSet
    ByRelease    map[ReleaseState]IDSet
    ByRollout    map[RolloutState]IDSet
    BySourceType map[SourceType]IDSet
    Trigrams     map[string]IDSet
}
type HealthState struct { Ready, Degraded bool; Reason string }
type Index struct {
    snapshot atomic.Pointer[Snapshot]
    health   atomic.Pointer[HealthState]
}
```

`LoadSnapshot` returns the installed snapshot whenever one exists, including while health is degraded. `CheckReady` reads only `HealthState`. Before the first install, queries return typed `ErrUnavailable`. A failed rebuild retains the prior snapshot, sets `Ready=false, Degraded=true`, and therefore continues serving while `/readyz` fails.

- [ ] **Step 6: Run race tests and commit**

Run: `rtk go test -race ./internal/fleet -run 'Test(Normalize|Search|Snapshot|Health)' -count=1`

Expected: PASS with no race.

```bash
rtk git add internal/fleet/model.go internal/fleet/snapshot.go internal/fleet/health.go internal/fleet/search.go internal/fleet/search_test.go internal/fleet/snapshot_test.go internal/fleet/fixtures_test.go
rtk git commit -m "feat(fleet): add immutable snapshots and search"
```

### Task 3: Project Applications, Stages, Releases, and Rollouts

**Files:**
- Create: `internal/fleet/projection.go`
- Create: `internal/fleet/projection_test.go`
- Create: `internal/fleet/rebuild.go`
- Create: `internal/fleet/rebuild_test.go`
- Create: `internal/fleet/store.go`

- [ ] **Step 1: Write failing projection tests**

Use two same-named Applications in different namespaces and multiple Stages. Assert project identity, source type/revision, resource/drift/missing counts, current stage/cluster, gate count, last transition, Release/Rollout association, actual target pairs, and stage health mapped from the matching Application stage phase or Unknown. Add AppProject upsert/delete cases that retain the Application's declared `ProjectKey` while installing/removing its `ProjectSummary` and enumerate exactly the Applications in that project's `ByProject` reverse set.

- [ ] **Step 2: Verify projection functions are missing**

Run: `rtk go test ./internal/fleet -run 'Test(ProjectApplication|ProjectStage|ProjectRelease|ProjectRollout)' -count=1`

Expected: FAIL for undefined projectors.

- [ ] **Step 3: Implement one pure projector per resource**

Resolve Application project as `(application namespace, spec.project/default)`. Add explicit `UpsertProject`/`DeleteProject` projection operations and keep project→Applications in `ByProject`. Resolve runtime Stages only when owner UID, `app.paprika.io/name`, and `Stage.spec.name` agree. Release/Rollout ownership uses controller owner references plus existing labels; ambiguous objects do not alter a summary and increment an internal projection-error result.

- [ ] **Step 4: Write failing rebuild/delta tests**

Test initial store build, update/delete deltas, generation increment per installed snapshot, deltas arriving during rebuild, failed rebuild retaining the serving snapshot, and a later successful rebuild clearing degraded health.

- [ ] **Step 5: Implement store-driven rebuild and delta replay**

`ProjectionStore` exposes typed list and point-lookup methods for the seven Plan-1 CRDs; the informer-store adapter and test harness both implement it. Rebuild off-lock, record event deltas in an ordered mutex-protected ledger while rebuilding, replay them into the replacement, assign `old.Generation+1` inside the replacement, then perform one atomic swap. Never mutate the installed snapshot.

- [ ] **Step 6: Run and commit**

Run: `rtk go test -race ./internal/fleet -run 'Test(Project|Rebuild|Delta)' -count=1`

Expected: PASS.

```bash
rtk git add internal/fleet/projection.go internal/fleet/projection_test.go internal/fleet/rebuild.go internal/fleet/rebuild_test.go internal/fleet/store.go
rtk git commit -m "feat(fleet): project application delivery state"
```

### Task 4: Add real connection projections and the optional Plan-3 seam

**Files:**
- Create: `internal/fleet/connection_projection.go`
- Create: `internal/fleet/connection_projection_test.go`
- Create: `internal/fleet/optional_source.go`
- Create: `internal/fleet/optional_source_test.go`
- Modify: `internal/fleet/snapshot.go`
- Modify: `internal/fleet/projection.go`

- [ ] **Step 1: Write failing Repository/Cluster tests**

Assert `Application.spec.source.repoRef` resolves in the Application namespace, Stage named Cluster refs default to the Stage namespace, Repository/Cluster status changes recompute dependent summaries, deletes become Unhealthy rather than falling back, and inline/in-cluster targets never alias a Cluster CR.

- [ ] **Step 2: Implement connection summaries and reverse dependencies**

Store compact `RepositorySummary`/`ClusterSummary` maps plus repository→Applications and cluster→Applications sets. Normalize Repository Successful to Healthy and Failed to Unhealthy; normalize Cluster Healthy/Unhealthy/Disabled exactly. Upsert/delete operations recompute only reverse dependants.

- [ ] **Step 3: Write the future-source contract test without a future import**

Use a `corev1.ConfigMap` as the fake optional object and assert registration, summary conversion, Application binding, reverse invalidation, and delete behavior. Then upsert the owning AppProject with a changed fake binding and assert every Application in `ByProject[project]` is rebound; delete the AppProject and assert those Applications are reprojected with a nil project, clear the effective source, and remain visible. An unrelated project's Applications must not be touched. The test must compile with no `api/observability` package.

- [ ] **Step 4: Implement the optional projector contract**

```go
type OptionalSourceProjector interface {
    Prototype() client.Object
    Summarize(client.Object) (SourceSummary, error)
    // project is nil after AppProject deletion.
    Bindings(app *pipelinesv1alpha1.Application, project *corev1alpha1.AppProject, stages []pipelinesv1alpha1.Stage) []types.NamespacedName
}
```

Plan 1 passes nil, so observability fields remain NotConfigured. Plan 3 supplies the concrete ObservabilitySource projector after its CRD and binding fields exist; `runtime.go` appends its prototype to informer registration and source changes recompute the returned bindings. `UpsertProject` and `DeleteProject` use `ByProject` plus `ProjectionStore` point lookups to reproject only dependent Applications and rerun `Bindings` with the new project or nil. Do not add a nonexistent CRD import or test AppProject default-source fields in this plan.

- [ ] **Step 5: Run and commit**

Run: `rtk go test ./internal/fleet -run 'Test(Connection|OptionalSource)' -count=1`

Expected: PASS.

```bash
rtk git add internal/fleet/connection_projection.go internal/fleet/connection_projection_test.go internal/fleet/optional_source.go internal/fleet/optional_source_test.go internal/fleet/snapshot.go internal/fleet/projection.go
rtk git commit -m "feat(fleet): project connection health"
```

### Task 5: Implement authorized filters, facets, and replica-safe pages

**Files:**
- Create: `internal/fleet/filter.go`
- Create: `internal/fleet/filter_test.go`
- Create: `internal/fleet/facets.go`
- Create: `internal/fleet/facets_test.go`
- Create: `internal/fleet/cursor.go`
- Create: `internal/fleet/cursor_test.go`
- Create: `internal/fleet/pagination.go`
- Create: `internal/fleet/pagination_test.go`

- [ ] **Step 1: Write failing filter/facet tests**

Cover OR within a dimension, AND across dimensions, stage/cluster matching any actual target, authorization intersection before search, and each facet applying search plus every filter except its own. Include same project names in different namespaces and prove unauthorized names/counts never appear.

- [ ] **Step 2: Implement set operations and facets**

Accept a `QueryScope{Projects, CapabilitiesByProject}`. Intersect scope projects first, then search candidates, then unions/intersections. Project and cluster buckets carry `FleetObjectKey`; scalar dimensions carry canonical enum/string values.

- [ ] **Step 3: Write failing cursor/page tests**

Build two independent indexes from the same objects. Assert a cursor issued by one resumes on the other; changed filters/search/sort/direction/page size, unknown version, malformed/oversized (>4 KiB) data return typed `ErrInvalidCursor`; generation is absent; namespace/name is the final tie-breaker.

- [ ] **Step 4: Implement cursor schema v1 and pagination**

Encode canonical JSON with `v=1`, SHA-256 query hash, the complete last deterministic sort tuple, namespace, and name using raw URL-safe base64. The query hash includes normalized filters/search/sort/direction/page size and namespaced identities, but not authorization scope or process generation. Search always uses relevance as the primary tuple. Impact sorting is lexicographic: unhealthy severity, blocked gates, active change, resource count, last transition, then namespace/name.

- [ ] **Step 5: Run and commit**

Run: `rtk go test ./internal/fleet -run 'Test(Filter|Facet|Cursor|Page)' -count=1`

Expected: PASS.

```bash
rtk git add internal/fleet/filter.go internal/fleet/filter_test.go internal/fleet/facets.go internal/fleet/facets_test.go internal/fleet/cursor.go internal/fleet/cursor_test.go internal/fleet/pagination.go internal/fleet/pagination_test.go
rtk git commit -m "feat(fleet): filter and paginate authorized summaries"
```

### Task 6: Implement treemap and actual-target Matrix aggregation

**Files:**
- Create: `internal/fleet/map.go`
- Create: `internal/fleet/map_test.go`
- Create: `internal/fleet/matrix.go`
- Create: `internal/fleet/matrix_test.go`
- Create: `internal/fleet/reader.go`

- [ ] **Step 1: Write failing map tests**

Assert default group Project, default size ResourceCount, stable IDs `g:<dimension>:<canonical-key>` and `a:<namespace>/<name>`, deterministic children, health buckets, and RequestRate falling back per leaf to resource count with the fallback marker until Plan 3 supplies a weight reader.

- [ ] **Step 2: Implement map aggregation and run its tests**

Run: `rtk go test ./internal/fleet -run 'TestFleetMap' -count=1`

Expected after implementation: PASS.

- [ ] **Step 3: Write failing Matrix tests**

Assert Project×Health contributes once per Application; Stage×Cluster contributes once per real target; Stage/Cluster paired with Health uses matching stage health; headers are deterministic; cells contain unique application and target counts; equal axes reject.

- [ ] **Step 4: Implement Matrix aggregation and the narrow Reader**

`Reader` exposes `ProjectKeys`, `QueryApplications`, `QueryMap`, `QueryMatrix`, `LoadSnapshot`, and `CheckReady`. It performs no Kubernetes reads. A future optional `WeightReader` supplies exact target request weights.

- [ ] **Step 5: Run and commit**

Run: `rtk go test ./internal/fleet -run 'Test(FleetMap|FleetMatrix)' -count=1`

Expected: PASS.

```bash
rtk git add internal/fleet/map.go internal/fleet/map_test.go internal/fleet/matrix.go internal/fleet/matrix_test.go internal/fleet/reader.go
rtk git commit -m "feat(fleet): aggregate map and matrix views"
```

### Task 7: Register informers before cache start and expose honest readiness

**Files:**
- Create: `internal/fleet/runtime.go`
- Create: `internal/fleet/runtime_test.go`
- Create: `internal/fleet/store_cache.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/main_controllers.go`
- Modify: `cmd/main_test.go`

- [ ] **Step 1: Write fake-source lifecycle tests**

Assert `Register(ctx)` attaches all handlers before `Start`, required types are Application/Stage/Release/Rollout/Cluster/Repository/AppProject, an optional projector adds exactly one prototype, initial readiness waits for every informer sync plus initial install, cancellation drains workers, and cache-disabled mode records the configuration reason.

- [ ] **Step 2: Implement explicit registration and worker lifecycle**

`NewRuntime` only constructs. `Register(ctx)` obtains informers and attaches add/update/delete handlers synchronously; calling it after `Start` or twice is an error. AppProject add/update events dispatch `UpsertProject`, deletes dispatch `DeleteProject`, and both paths trigger only that project's optional-source rebinding. `Start(ctx)` waits for registered informer sync, rebuilds from informer stores, replays warm-up deltas, installs the snapshot, then processes coalesced keys until cancellation. It implements `manager.Runnable` and `NeedLeaderElection() false`.

- [ ] **Step 3: Refactor standalone cache construction**

Return `apiCacheBundle{Cache, Client}` without starting the cache. In `runAPIMode`: construct Index/runtime, call `Register`, launch runtime and cache under one cancelable error group, wait for cache sync and index initial install, then start HTTP. With `--api-cache-enabled=false`, preserve the direct client for legacy RPCs and inject an unavailable fleet reader containing the flag reason.

- [ ] **Step 4: Register operator handlers before `mgr.Start`**

Construct runtime immediately after the manager, call `runtime.Register(opCtx)` before controllers/UI and before `mgr.Start`, then `mgr.Add(runtime)`. Carry the Reader in the mode dependency structs for Task 8 wiring. Add `fleet-index` to manager `AddReadyzCheck` and the UI/API `/readyz` mux; `/healthz` remains process liveness. A degraded rebuild fails readiness while handlers continue using the old snapshot.

- [ ] **Step 5: Run lifecycle/mode tests**

Run: `rtk go test -race ./internal/fleet ./cmd -run 'TestFleet(IndexRuntime|CacheLifecycle|Readiness|CacheDisabled)' -count=1`

Expected: PASS; cancellation leaves no worker or cache goroutine.

- [ ] **Step 6: Commit runtime wiring**

```bash
rtk git add internal/fleet/runtime.go internal/fleet/runtime_test.go internal/fleet/store_cache.go cmd/main.go cmd/main_operator.go cmd/main_controllers.go cmd/main_test.go
rtk git commit -m "feat(fleet): wire informer lifecycle and readiness"
```

### Task 8: Authorize project sets, derive capabilities, and serve queries

**Files:**
- Modify: `internal/api/auth/authz.go`
- Create: `internal/api/auth/authz_project_set_test.go`
- Modify: `internal/api/auth/middleware.go`
- Modify: `internal/api/auth/auth_test.go`
- Modify: `internal/api/auth/project_authorizer.go`
- Modify: `internal/api/auth/project_authorizer_test.go`
- Modify: `internal/api/server.go`
- Modify: `internal/api/fleet_handler.go`
- Modify: `internal/api/fleet_handler_test.go`
- Create: `internal/api/fleet_capabilities.go`
- Create: `internal/api/fleet_capabilities_test.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`

- [ ] **Step 1: Write failing project-set authorization tests**

Add `ProjectRef{Namespace, Name}` to auth and `AuthorizedProjects(ctx, principal, action, resource, candidates)` to `Authorizer`. Test AllowAll returns candidates, DenyAll returns none, RBAC filters wildcard/namespace/project rules, ProjectAuthorizer preserves the existing missing-`default` compatibility behavior, and `multiAuthorizer` intersects global RBAC with AppProject roles. Include identical project names in two namespaces, auth revocation, and an empty candidate list.

- [ ] **Step 2: Implement candidate filtering in every authorizer**

The fleet Reader supplies actual candidate keys, so no authorizer invents or lists projects. Each concrete authorizer filters candidates by calling its existing policy logic; `multiAuthorizer` passes each result into the next authorizer. When server auth is disabled (`s.authorizer == nil`), fleet handlers accept all candidates. Omitted project filters never call legacy `Authorize` with an empty project.

- [ ] **Step 3: Write failing capability tests**

For each authorized project, map `application.sync → (write, applications)`, `release.rollback` and `gate.approve → (write, releases)`, and `pipeline.retry → (write, pipelines)`. Test mixed global/project grants and ensure capabilities from one namespaced project never flow to another.

- [ ] **Step 4: Implement `QueryScope` construction once per request**

Call `Reader.ProjectKeys(namespace filters)`, then `AuthorizedProjects` once for read scope. Evaluate the four capability mappings once per authorized project/action pair and pass `CapabilitiesByProject` into fleet queries; handlers never re-read Kubernetes or trust UI capability claims.

- [ ] **Step 5: Complete handler/error tests**

Assert unauthorized Applications cannot affect items, total, facets, map, or Matrix; invalid cursors map to `InvalidArgument`; no installed snapshot/cache-disabled maps to `Unavailable` with a configuration reason; valid empty results remain OK; all three responses carry the snapshot generation.

- [ ] **Step 6: Wire the narrow Reader and implement conversions**

Add `WithFleetIndex(fleet.Reader)` to `PaprikaServer` and pass the Reader from both mode dependency structs. Convert every proto enum/key explicitly and reject unknown values. Defaults are Applications: Name/ASC (Relevance when searching), Map: Project/ResourceCount, Matrix size: ResourceCount.

- [ ] **Step 7: Run and commit**

Run: `rtk go test ./internal/api/auth ./internal/api ./cmd -run 'Test(AuthorizedProjects|FleetCapabilities|QueryApplications|QueryFleet|FleetCacheDisabled)' -count=1`

Expected: PASS.

```bash
rtk git add internal/api/auth/authz.go internal/api/auth/authz_project_set_test.go internal/api/auth/middleware.go internal/api/auth/auth_test.go internal/api/auth/project_authorizer.go internal/api/auth/project_authorizer_test.go internal/api/server.go internal/api/fleet_handler.go internal/api/fleet_handler_test.go internal/api/fleet_capabilities.go internal/api/fleet_capabilities_test.go cmd/main.go cmd/main_operator.go
rtk git commit -m "feat(api): serve authorized fleet queries"
```

### Task 9: Add complete low-cardinality fleet telemetry and spans

**Files:**
- Create: `internal/metrics/fleet.go`
- Create: `internal/metrics/fleet_test.go`
- Create: `internal/fleet/telemetry.go`
- Create: `internal/fleet/telemetry_test.go`
- Modify: `internal/fleet/rebuild.go`
- Modify: `internal/fleet/projection.go`
- Modify: `internal/fleet/reader.go`

- [ ] **Step 1: Write failing metric/span tests**

Use an OTel manual metric reader and `tracetest.InMemoryExporter`. Require `fleet.index.build`, `fleet.index.update`, and `fleet.query` spans plus OTel instruments for build/update/query duration, item count, generation, result count, and rebuild failures. Assert a failed rebuild emits degraded outcome while retaining the old generation.

- [ ] **Step 2: Assert the attribute allowlist**

Recorded attributes may contain only `operation`/`query_kind`, `outcome`, `active_dimension_count` (0–9), and `cache_outcome`. Tests must fail if attributes contain search text, raw filters/cursors, project/application names, endpoint URLs, credentials, or PromQL.

- [ ] **Step 3: Implement OTel-only instrumentation**

Create instruments from `otel.Meter("paprika")`. Use observable gauges with units `{application}` and `{generation}`, histograms in seconds/items, and no direct Prometheus registration. Spans include generation and counts as numeric attributes but no identities.

- [ ] **Step 4: Run and commit**

Run: `rtk go test ./internal/metrics ./internal/fleet -run 'TestFleet(Telemetry|Metric|Span)' -count=1`

Expected: PASS with the sensitive-attribute rejection table.

```bash
rtk git add internal/metrics/fleet.go internal/metrics/fleet_test.go internal/fleet/telemetry.go internal/fleet/telemetry_test.go internal/fleet/rebuild.go internal/fleet/projection.go internal/fleet/reader.go
rtk git commit -m "feat(fleet): instrument index and queries"
```

### Task 10: Add the URL/data layer and a non-broken unified shell

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/package-lock.json`
- Modify: `ui/src/app/layout.tsx`
- Create: `ui/src/app/dashboard/layout.tsx`
- Create: `ui/src/components/layout/app-shell.tsx`
- Create: `ui/src/components/layout/sidebar.tsx`
- Create: `ui/src/components/layout/scope-bar.tsx`
- Create: `ui/src/components/layout/app-shell.test.tsx`
- Modify: `ui/src/components/layout/nav.tsx`
- Create: `ui/src/lib/query-provider.tsx`
- Create: `ui/src/lib/fleet-query.ts`
- Create: `ui/src/lib/fleet-query.test.ts`
- Create: `ui/src/lib/fleet-client.ts`

- [ ] **Step 1: Write failing URL codec tests**

Round-trip canonical repeated project/cluster keys as escaped `namespace/name` pairs and all `project, cluster, stage, namespace, health, sync, release, rollout, source, q, sort, direction, view, group, rows, columns, size, zoom, selected, range` fields. Sort repetitions, omit defaults, reject malformed namespaced keys/enums, preserve unrelated scope across navigation, and return dropped-value notices after reconciling with authorized facets.

- [ ] **Step 2: Write failing shell tests**

Assert working links: Overview `/dashboard`, Applications `/dashboard/applications`, Pipelines `/dashboard#pipelines`, Releases `/dashboard#releases`, and Rollouts `/dashboard/rollouts`. Activity and Admin render non-link buttons with `disabled`, `aria-disabled=true`, and “Available in a later plan”; no 404 link is emitted. Test mobile focus trap/Escape/focus return and `#applications` redirect to the dedicated route.

- [ ] **Step 3: Install focused dependencies**

Run: `cd ui && rtk npm install @tanstack/react-query @tanstack/react-virtual d3-hierarchy`

Run: `cd ui && rtk npm install -D @types/d3-hierarchy`

Expected: only `package.json` and `package-lock.json` dependency sections change.

- [ ] **Step 4: Implement codec, client, provider, and shell**

`fleet-client.ts` is the sole proto↔URL/internal request mapper. Root layout keeps a minimal brand/auth header for public/auth routes; dashboard layout owns the sidebar/scope bar and wraps every existing deep link. Pipelines and Releases anchor sections remain on Overview until dedicated inventories exist.

- [ ] **Step 5: Run and commit**

Run: `cd ui && rtk npm test -- --run src/lib/fleet-query.test.ts src/components/layout/app-shell.test.tsx`

Run: `cd ui && rtk npm run lint && rtk npm run build`

Expected: PASS; static export includes existing deep links and `/dashboard/applications`.

```bash
rtk git add ui/package.json ui/package-lock.json ui/src/app/layout.tsx ui/src/app/dashboard/layout.tsx ui/src/components/layout/app-shell.tsx ui/src/components/layout/sidebar.tsx ui/src/components/layout/scope-bar.tsx ui/src/components/layout/app-shell.test.tsx ui/src/components/layout/nav.tsx ui/src/lib/query-provider.tsx ui/src/lib/fleet-query.ts ui/src/lib/fleet-query.test.ts ui/src/lib/fleet-client.ts
rtk git commit -m "feat(ui): add unified operations shell"
```

### Task 11: Build filters, virtualized inventory, robust cursor paging, and focus restoration

**Files:**
- Create: `ui/src/lib/fleet-pages.ts`
- Create: `ui/src/lib/fleet-pages.test.ts`
- Create: `ui/src/lib/fleet-focus.ts`
- Create: `ui/src/lib/fleet-focus.test.ts`
- Create: `ui/src/lib/use-fleet-data.ts`
- Create: `ui/src/components/fleet/fleet-filters.tsx`
- Create: `ui/src/components/fleet/fleet-states.tsx`
- Create: `ui/src/components/fleet/application-table.tsx`
- Create: `ui/src/components/fleet/attention-queue.tsx`
- Create: `ui/src/components/fleet/fleet-view.tsx`
- Create: `ui/src/components/fleet/fleet-view.test.tsx`
- Create: `ui/src/app/dashboard/applications/page.tsx`

- [ ] **Step 1: Write failing filter/request tests**

Assert every basic filter maps to its protobuf enum/key, search debounces 250 ms, active presentation alone drives its primary RPC, prior data remains visibly stale during switches, and Loading/Empty/Unauthorized/Unavailable/Stale/Partial are distinct live-region states.

- [ ] **Step 2: Implement filters and the view state machine**

Use the URL codec as the only state. Default view is Treemap; Applications Table defaults Name/ASC; Attention Queue requests Impact/DESC. Removed or unauthorized facet values are deleted from the URL with one visible notice.

- [ ] **Step 3: Write failing infinite-page tests**

Merge pages by `namespace/name` while preserving first-seen order. On Connect `InvalidArgument` for a non-empty cursor, clear only fleet page data, request page one once, and preserve URL filters/search/sort. Other errors must not silently restart.

- [ ] **Step 4: Implement de-duplication, reset, and virtualized Table/Queue**

Use TanStack Virtual, deterministic row keys, 100-row pages, and an explicit “Load more” sentinel/button usable without IntersectionObserver. Queue is the same QueryApplications contract with Impact sort, never a client join over partial pages. Render capability-gated actions but keep server enforcement authoritative.

- [ ] **Step 5: Write failing focus-restoration tests**

In `fleet-focus.test.ts`, register mock presentation adapters and track a focused Application identity. Assert filtering/refetch/presentation switch requests the same identity when still present; otherwise it requests the results heading and an “item removed” announcement. Selection and zoom remain URL state.

- [ ] **Step 6: Run the focus test to verify red**

Run: `cd ui && rtk npm test -- --run src/lib/fleet-focus.test.ts`

Expected: FAIL because the focus coordinator is missing.

- [ ] **Step 7: Implement the focus coordinator**

Implement a presentation-neutral coordinator in `fleet-focus.ts` and connect `FleetView`/Table through adapter callbacks. Task 12's Canvas adapter uses the same contract; do not put DOM querying in the coordinator.

- [ ] **Step 8: Run green and commit**

Run: `cd ui && rtk npm test -- --run src/lib/fleet-pages.test.ts src/lib/fleet-focus.test.ts src/components/fleet/fleet-view.test.tsx`

Expected: PASS.

```bash
rtk git add ui/src/lib/fleet-pages.ts ui/src/lib/fleet-pages.test.ts ui/src/lib/fleet-focus.ts ui/src/lib/fleet-focus.test.ts ui/src/lib/use-fleet-data.ts ui/src/components/fleet/fleet-filters.tsx ui/src/components/fleet/fleet-states.tsx ui/src/components/fleet/application-table.tsx ui/src/components/fleet/attention-queue.tsx ui/src/components/fleet/fleet-view.tsx ui/src/components/fleet/fleet-view.test.tsx ui/src/app/dashboard/applications/page.tsx
rtk git commit -m "feat(ui): add resilient fleet inventory"
```

### Task 12: Add Canvas/Matrix views, Overview, and safe bounded refresh

**Files:**
- Create: `ui/src/components/fleet/treemap-layout.ts`
- Create: `ui/src/components/fleet/treemap-layout.test.ts`
- Create: `ui/src/components/fleet/treemap-navigation.ts`
- Create: `ui/src/components/fleet/treemap-navigation.test.ts`
- Create: `ui/src/components/fleet/fleet-treemap.tsx`
- Create: `ui/src/components/fleet/fleet-treemap.test.tsx`
- Create: `ui/src/components/fleet/fleet-matrix.tsx`
- Create: `ui/src/components/fleet/fleet-matrix.test.tsx`
- Create: `ui/src/components/fleet/fleet-overview.tsx`
- Create: `ui/src/components/fleet/fleet-overview.test.tsx`
- Modify: `ui/src/app/dashboard/page.tsx`
- Delete: `ui/src/app/dashboard/__tests__/dashboard-sse.test.tsx`
- Create: `ui/src/app/dashboard/__tests__/dashboard-refresh.test.tsx`
- Modify: `ui/src/lib/connection-context.tsx`
- Create: `ui/src/lib/connection-context.test.tsx`
- Create: `ui/src/lib/fleet-refresh.ts`
- Create: `ui/src/lib/fleet-refresh.test.ts`
- Delete: `ui/src/lib/pipeline-sse.ts`
- Create: `ui/src/lib/pipeline-refresh.ts`
- Modify: `ui/src/app/dashboard/pipelines/detail/page.tsx`
- Delete: `ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx`
- Create: `ui/src/app/dashboard/__tests__/pipeline-refresh.test.tsx`
- Modify: `ui/src/app/dashboard/application/page.tsx`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/cloud-run/main.go`
- Modify: `cmd/main_test.go`

- [ ] **Step 1: Write pure layout/navigation tests**

Test 10,000 deterministic rectangles, stable IDs, bounds hit-testing, semantic zoom without filter mutation, nearest-cell arrow navigation, Home/End, selected-cell retention, resize/DPR scaling, and reduced-motion behavior.

- [ ] **Step 2: Implement Canvas treemap**

Keep only Canvas plus one focus controller in the interactive DOM. Draw text/icon status as well as color, expose tooltip and selected detail/live region, and always expose the synchronized Table toggle as the complete semantic equivalent.

- [ ] **Step 3: Write failing Matrix/Overview tests**

Test that Matrix renders sparse cells with textual health and both application/target counts. Test that Overview shows aggregate health, active release/rollout changes, blocked gates, Repository/Cluster failures, and highest-impact attention; NotConfigured observability is not a failure. Preserve existing `#pipelines` and `#releases` sections and all existing drill-down behavior.

- [ ] **Step 4: Run Matrix/Overview tests to verify red**

Run: `cd ui && rtk npm test -- --run src/components/fleet/fleet-matrix.test.tsx src/components/fleet/fleet-overview.test.tsx`

Expected: FAIL because Matrix and Overview components are missing.

- [ ] **Step 5: Implement Matrix and Overview**

Implement only the behavior asserted in Step 3, then connect both to `FleetView` and the shared URL/query state.

- [ ] **Step 6: Run Matrix/Overview tests to verify green**

Run: `cd ui && rtk npm test -- --run src/components/fleet/fleet-matrix.test.tsx src/components/fleet/fleet-overview.test.tsx`

Expected: PASS.

- [ ] **Step 7: Write failing bounded-refresh/security tests**

Fleet/Overview refresh every 60 seconds while visible; focused Application/Pipeline pages refresh every 15 seconds; focus regain triggers one immediate refresh; failures back off to at most 120 seconds; hidden tabs stop intervals. Assert no browser code constructs `EventSource`. Assert `/events` returns 404 in standalone, operator, and cloud-run muxes.

- [ ] **Step 8: Replace raw SSE with polling and fail the endpoint closed**

Remove all `NewSSEHandler` route registrations and register `http.NotFoundHandler()` at `/events` until Plan 4 provides authorized `WatchEvents`. Keep brokers for controller/audit internals. `ConnectionProvider` tracks browser online state and request outcomes only. Replace dashboard, Application, and Pipeline subscriptions with the bounded refresh helpers.

- [ ] **Step 9: Run security/UI verification**

Run: `rtk rg -n 'new EventSource' ui/src`

Expected: no matches.

Run: `rtk rg -n 'NewSSEHandler' cmd/main.go cmd/main_operator.go cmd/cloud-run/main.go`

Expected: no matches.

Run: `cd ui && rtk npm test && rtk npm run lint && rtk npm run build`

Run: `rtk go test ./cmd -run 'Test.*EventsRouteDisabled' -count=1`

Expected: all PASS; static export succeeds.

- [ ] **Step 10: Commit views and safe refresh**

```bash
rtk git add -A -- ui/src/components/fleet ui/src/app/dashboard/page.tsx ui/src/app/dashboard/__tests__/dashboard-sse.test.tsx ui/src/app/dashboard/__tests__/dashboard-refresh.test.tsx ui/src/lib/connection-context.tsx ui/src/lib/connection-context.test.tsx ui/src/lib/fleet-refresh.ts ui/src/lib/fleet-refresh.test.ts ui/src/lib/pipeline-sse.ts ui/src/lib/pipeline-refresh.ts ui/src/app/dashboard/pipelines/detail/page.tsx ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx ui/src/app/dashboard/__tests__/pipeline-refresh.test.tsx ui/src/app/dashboard/application/page.tsx cmd/main.go cmd/main_operator.go cmd/cloud-run/main.go cmd/main_test.go
rtk git commit -m "feat(ui): add fleet visuals and safe refresh"
```

### Task 13: Add a real same-origin Go API and compiled-UI browser harness

**Files:**
- Create: `test/fleetconsole/main.go`
- Create: `test/fleetconsole/server.go`
- Create: `test/fleetconsole/seed.go`
- Create: `test/fleetconsole/static.go`
- Create: `test/fleetconsole/server_test.go`
- Create: `ui/playwright.config.ts`
- Create: `ui/e2e/fleet-console.spec.ts`
- Modify: `ui/package.json`

- [ ] **Step 1: Write failing harness integration tests**

Start the server on an ephemeral listener, fetch exported `/dashboard/applications` HTML, and call QueryApplications through a generated Connect client. Assert the response comes from the real `PaprikaServer` with `WithFleetIndex` and not an HTTP route mock.

- [ ] **Step 2: Implement deterministic seed/store and same-origin server**

`seed.go` builds real Application/Stage/Release/Rollout/AppProject/Repository/Cluster objects in healthy, degraded, drifting, deploying, and gated states and feeds the same `ProjectionStore` rebuild path as production. Flags are `--listen`, `--assets`, and `--applications`. Auth is explicitly disabled for this Plan-1 smoke. `static.go` serves `ui/out` with exported-route `.html` resolution and SPA fallback; the same mux mounts the generated Connect handler.

- [ ] **Step 3: Verify the Go harness**

Run: `rtk go test ./test/fleetconsole -count=1`

Expected: PASS for static route, Connect query, filtering, and graceful shutdown.

- [ ] **Step 4: Configure Playwright against the compiled server**

Set base URL `http://127.0.0.1:3100`, `reuseExistingServer=false`, 1920×1080 viewport, and Chromium normal, reduced-motion, and keyboard-only projects. `webServer` runs `../bin/fleet-console-fixture --listen 127.0.0.1:3100 --assets ui/out --applications 250` from the repository root. Add `test:e2e` as `playwright test`; do not intercept Connect calls.

- [ ] **Step 5: Implement and run browser smoke**

Cover shell links/disabled placeholders, namespaced filters and fuzzy search, Treemap→Matrix→Table URL preservation, keyboard selection, cursor loading, Application deep link, legacy hash redirect, and absence of `/events` requests.

Run: `cd ui && rtk npm run build`

Run: `rtk go build -o bin/fleet-console-fixture ./test/fleetconsole`

Run: `cd ui && rtk npx playwright install chromium`

Run: `cd ui && rtk npm run test:e2e -- fleet-console.spec.ts`

Expected: all three projects PASS against compiled assets and the real Go Connect server.

- [ ] **Step 6: Commit the harness**

```bash
rtk git add test/fleetconsole/main.go test/fleetconsole/server.go test/fleetconsole/seed.go test/fleetconsole/static.go test/fleetconsole/server_test.go ui/playwright.config.ts ui/e2e/fleet-console.spec.ts ui/package.json
rtk git commit -m "test(e2e): exercise the real fleet console"
```

### Task 14: Enforce controlled 10k scale, compatibility, CI, and documentation

**Files:**
- Create: `internal/fleet/scale_test.go`
- Create: `ui/e2e/fleet-scale.spec.ts`
- Create: `hack/test-fleet-scale.sh`
- Modify: `.github/workflows/test.yml`
- Modify: `docs/frontend.md`

- [ ] **Step 1: Write the deterministic API scale/memory gate**

Seed 10,000 Applications/100 Clusters, warm ten queries, measure 100 cached filter/search/facet/map/Matrix queries, calculate p95, and fail at 300 ms. Record `runtime.MemStats.HeapAlloc` after two GCs as `FLEET_HEAP_BYTES` and assert a second identical rebuild grows retained heap by less than 5%. Print `FLEET_API_P95_MS`, heap, allocation count, Go version, GOOS/GOARCH, and `GOMAXPROCS`.

- [ ] **Step 2: Write the browser scale gate**

With 10,000 seeded leaves, measure 20 cold navigation→`data-fleet-ready` samples and 30 post-load presentation switches. Calculate p95 in the test, fail initial fleet query+Canvas render at 2,000 ms and switching at 250 ms, and write `artifacts/fleet-scale/ui-scale.json`. Assert Canvas does not create per-Application DOM nodes.

- [ ] **Step 3: Implement the exact controlled runner**

`hack/test-fleet-scale.sh` fails unless Docker reports linux/amd64 and at least 8 GiB. It creates `artifacts/fleet-scale/environment.txt` with UTC time, `uname -a`, Docker/kernel, image digests, Go/Node/Playwright/Chromium versions, and cgroup limits. It runs the API gate in pinned `golang:1.26.0-bookworm` and the UI gate in pinned `mcr.microsoft.com/playwright:v1.61.1-noble`, each with `--platform linux/amd64 --cpus 4 --memory 8g`; the Go test process is launched with `GOMAXPROCS=4` and fails preflight unless `runtime.GOMAXPROCS(0) == 4`. The Go container builds `bin/fleet-console-fixture`; the Playwright container runs `npm ci`, the static build, the 10k fixture, and `fleet-scale.spec.ts`. It records container peak memory and preserves all outputs under `artifacts/fleet-scale`.

- [ ] **Step 4: Run the controlled gate**

Run: `rtk bash hack/test-fleet-scale.sh`

Expected: output contains `FLEET_API_P95_MS<300`, `FLEET_UI_INITIAL_P95_MS<2000`, `FLEET_UI_SWITCH_P95_MS<250`, memory/version records, and exit 0.

- [ ] **Step 5: Add exact CI jobs and docs**

Extend the existing `.github/workflows/test.yml` with `fleet-ui-smoke` (Node install, compiled UI/Go fixture, Playwright smoke) and `fleet-scale` (the controlled script, artifact upload even on failure). Keep the existing Go race job. Document query/filter/facet/cursor semantics, cache-disabled/degraded readiness, routes, disabled placeholders, polling interval, keyboard/Table equivalent, and how to reproduce scale artifacts.

- [ ] **Step 6: Run the complete compatibility gate**

Run: `rtk make generate-proto`

Run: `rtk make manifests`

Run: `rtk go test ./... -count=1`

Run: `rtk go test ./cmd/paprika/... -count=1 && rtk go build ./cmd/...`

Run: `rtk make test-race`

Run: `cd ui && rtk npm test && rtk npm run lint && rtk npm run build && rtk npm run test:e2e -- fleet-console.spec.ts`

Run: `rtk make lint`

Run: `rtk git diff --check`

Expected: every command passes, legacy RPC/CLI and existing UI deep-link tests remain green, generated output is stable, and diff check is clean.

- [ ] **Step 7: Commit completion**

```bash
rtk git add internal/fleet/scale_test.go ui/e2e/fleet-scale.spec.ts hack/test-fleet-scale.sh .github/workflows/test.yml docs/frontend.md
rtk git commit -m "test: enforce enterprise fleet scale gates"
```

### Plan 1 completion criteria

- `/dashboard` and `/dashboard/applications` use server-side authorized fleet queries; existing deep links and CLI/RPCs remain compatible.
- Treemap, Matrix, Table, and Queue preserve one namespaced URL state; cursor reset/de-duplication and focus restoration are tested.
- Authorization precedes every search, facet, aggregate, and capability result.
- Standalone/operator modes register handlers before cache start, distinguish serving from degraded readiness, and shut down cleanly.
- Raw `/events` is fail-closed and browser refresh is bounded until authorized `WatchEvents` lands.
- Real compiled-UI/Go-API smoke plus controlled linux/amd64 API/UI/memory scale gates pass before Plan 2.

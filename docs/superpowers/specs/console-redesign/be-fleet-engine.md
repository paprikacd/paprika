# Backend Map: `internal/fleet` (the fleet index engine)

Scope: `/Users/benebsworth/projects/paprika/internal/fleet` (19 non-test files, ~7.9k LOC of
production code + ~7.7k LOC of tests). Also answers "does `internal/cache` back it?" — **no**
(see §11).

Everything below is what EXISTS today. Absences are called out explicitly.

---

## 1. One-paragraph mental model

`fleet` is an in-process, replica-local, **read-only projection** of seven Kubernetes CRDs into a
single immutable value-object graph (`Snapshot`). Kubernetes objects never escape the package.
A `Runtime` attaches controller-runtime informer handlers, funnels key-only deltas through a
workqueue into a `Rebuilder`, which re-reads objects **by key** from a cache-only `ProjectionStore`,
projects them into `ApplicationSummary` values, and publishes a new `*Snapshot` via a single
`atomic.Pointer`. Readers (`Index`, satisfying `Reader`) load that pointer once per request and
answer queries by pure in-memory set algebra over pre-built inverted indexes. There are **no
mutations, no live reads, no metrics, no cost, and no ownership data anywhere in this package.**

---

## 2. File inventory (production files only)

| File | Lines | Role |
|---|---|---|
| `model.go` | 201 | Provider-neutral value types + all enums (`Health`, `SyncState`, `SourceType`, `ReleaseState`, `RolloutState`, `ConnectionState`), `IDSet`. |
| `snapshot.go` | 934 | `Snapshot`, `Index`, `ownedSnapshot`, deep-clone, validation, and the copy-on-write `snapshotEditor`. |
| `runtime.go` | 514 | `Runtime`: informer registration, workqueue, worker loop, readiness barrier, `unavailableReader`. |
| `rebuild.go` | 1396 | `Rebuilder`: full rebuild, delta application, dependency (owner) graph, `loadProjectionInput`. |
| `projection.go` | 561 | `projectApplication` — the single place an `ApplicationSummary` is produced. |
| `connection_projection.go` | 121 | `projectRepositorySummary`, `projectClusterSummary`, `projectStageConnection`. |
| `optional_source.go` | 162 | `OptionalSourceProjector` seam (observability sources); **currently wired with nil**. |
| `reader.go` | 246 | `Reader` interface + `Index` query methods + per-query telemetry/metrics wrapper. |
| `filter.go` | 206 | `QueryScope`, `Capability`, `ApplicationFilter`, `FilterApplications`, posting-list set ops. |
| `cursor.go` | 501 | `ApplicationQuery`, `SortField`, `PageKey`, **`ImpactKey`**, `RelevanceKey`, cursor encode/decode + `QueryHash`. |
| `pagination.go` | 346 | `QueryApplications`, `ApplicationPage`, all comparators incl. `compareImpact`. |
| `facets.go` | 330 | `Facets` — nine self-excluding facet dimensions. |
| `map.go` | 574 | `QueryMap` (treemap), `WeightReader` seam, `SizeMetric`, group keys, weight arithmetic. |
| `matrix.go` | 391 | `QueryMatrix` (sparse 2-axis matrix). |
| `search.go` | 301 | Name-only search: exact/prefix/substring/trigram-Jaccard tiers. |
| `status.go` | 286 | `QueryStatus` (system-status/attention list). Not on `Reader`. |
| `store.go` | 83 | Key type aliases, `IDSet`, `ResourceKind`, `ResourceDelta`. |
| `store_cache.go` | 275 | `CacheStore` — controller-runtime cache adapter implementing `ProjectionStore`. |
| `health.go` | 55 | `ErrUnavailable`, `HealthState`, `SetHealth`, `CheckReady`. |
| `telemetry.go` | 200 | OTel spans (`fleet.index.build`, `fleet.index.update`, `fleet.query.*`), bounded numeric-only attributes. |

---

## 3. Ingestion: how applications get into the index

### 3.1 Sources of truth — the frozen seven-CRD contract

`ProjectionStore` (`reader.go:19-38`) is exactly seven kinds, each with `List*` and `Get*`:

```
Application, Stage, Release, Rollout, AppProject, Repository, Cluster
```

plus an optional eighth, `ResourceOptionalSource`, only when an `OptionalSourceProjector` is
registered (`store.go:41-53`, `optional_source.go:16-33`).

`CacheStore` (`store_cache.go:16-30`) implements it over a `client.Reader` (the controller-runtime
shared cache). **Every `List*`/`Get*` DeepCopies** — nothing from the informer cache is aliased.

### 3.2 Informer registration (`runtime.go:98-146`)

`Runtime.Register(ctx)` is synchronous and must be called **before** the manager cache starts.
It registers `cache.ResourceEventHandlerDetailedFuncs` per descriptor:

```go
{ResourceApplication, "application", &pipelinesv1alpha1.Application{}},
{ResourceStage,       "stage",       &pipelinesv1alpha1.Stage{}},
{ResourceRelease,     "release",     &pipelinesv1alpha1.Release{}},
{ResourceRollout,     "rollout",     &rolloutsv1alpha1.Rollout{}},
{ResourceCluster,     "cluster",     &clustersv1alpha1.Cluster{}},
{ResourceRepository,  "repository",  &corev1alpha1.Repository{}},
{ResourceAppProject,  "app project", &corev1alpha1.AppProject{}},
// + optional source prototype when a projector is registered
```

Registration failure removes every prior handler (`removeRegistrationsLocked`, `runtime.go:157`).

Event handling (`runtime.go:168-196`):
- `AddFunc` ignores `initial` adds (the initial list is covered by the startup full rebuild).
- `UpdateFunc` short-circuits on identical `resourceVersion` (`sameRuntimeResourceVersion`).
- For `Stage` and `Release` only, `runtimeAffectedApplications` extracts the owning Application
  key from the controller ownerRef so an association move enqueues **both** sides.
- Deltas are **key-only**: `ResourceDelta{Kind, Key, AffectedApplications}` (`store.go:57-61`).
  The comment at `store.go:55` is explicit: affected-app keys are "only a set of keys to re-read;
  it is never accepted as evidence of ownership."

### 3.3 Startup sequence (`runtime.go:299-334` `Runtime.Start`)

1. `beginStart` — asserts `Register` ran, `Start` runs once.
2. `waitForRuntimeSync` — blocks on every registration's `HasSyncedChecker().Done()`.
3. `rebuilder.Rebuild(ctx)` — the **full** projection; installs generation 1.
4. `enqueueBarrier()` → start `runWorker` goroutine → `waitForRuntimeBarrier`. The barrier is a
   sentinel `runtimeQueueKey{barrierID: n}`; when the worker drains past it, warm-up is done.
5. `signalReady(nil)`; `WaitReady(ctx)` unblocks the API server.
6. Blocks on ctx / worker error. `stop()` removes handlers, `queue.ShutDownWithDrain()`.

`NeedLeaderElection() == false` (`runtime.go:93`) — **every API replica builds its own index.**

### 3.4 Wiring

- Operator mode: `cmd/main_operator.go:229-241` — `fleet.NewIndex()` → `fleet.NewCacheStore(mgr.GetCache(), scheme)` → `fleet.NewRuntime(...)` → `Register(ctx)` → `mgr.Add(fleetRuntime)` → returns `fleetRuntime.Reader()`.
- Standalone API: `cmd/main.go:579-589` (`prepareStandaloneFleetRuntime`), lifecycle at `cmd/main.go:432-472`.
- Cache-disabled deployments get `fleet.NewUnavailableReader(reason)` (`cmd/main.go:621`,
  impl `runtime.go:452-514`) — every method returns `*ErrUnavailable`. It deliberately never
  presents an empty fleet as valid data.

---

## 4. Concurrency model — this is the load-bearing design constraint

**Single writer, many lock-free readers, atomic pointer swap.**

- `Index` (`snapshot.go:39-42`) holds exactly two fields:
  ```go
  type Index struct {
      snapshot atomic.Pointer[Snapshot]
      health   atomic.Pointer[HealthState]
  }
  ```
- Readers call `Index.LoadSnapshot()` (`snapshot.go:114`) which loads the pointer **once**. The
  returned `*Snapshot` is immutable by contract; all `Snapshot` query methods are pure.
- The only writer is `Rebuilder`, serialized by `Rebuilder.mu` (`rebuild.go:33`). Only one
  goroutine (`Runtime.runWorker`, `runtime.go:394-425`) calls `ApplyDeltas`.
- The worker **batches**: it takes one item then drains `queue.Len()` in a loop, so a burst of
  informer events collapses into **one** editor / one seal / **one** publication
  (`runtime.go:396-406`, `ApplyDeltas` doc at `rebuild.go:370-373`).
- Publication paths:
  - `Index.Install(builder)` (`snapshot.go:88`) — defensive: deep-clones, validates, rebuilds the
    search index, stores, then `SetHealth{Ready:true}`. Used by tests/external callers.
  - `Index.installOwned(ownedSnapshot)` (`snapshot.go:104`) — no clone; requires the opaque
    `ownedSnapshot{snapshot, sealed}` proof (`snapshot.go:46-49`). **Leaves health untouched** so a
    delta cannot silently clear a degraded flag.
- Health (`health.go:27-55`) is a *separate* atomic pointer. Degraded health never discards the
  serving snapshot — `QueryApplications` explicitly serves a stale-but-good generation
  (`reader.go:65-67` doc comment). `fleetSnapshotCacheOutcome` (`reader.go:203`) reports
  `stale` vs `hit` from that flag.

### 4.1 Copy-on-write editing (`snapshotEditor`, `snapshot.go:335-403`)

`newSnapshotEditor(base)` does `next := *base` (shallow struct copy). Then per-map "cloned" booleans
(`applicationsCloned`, `byProjectCloned`, `byClusterCloned`, …) mean **a top-level map is
shallow-copied only on first write**, and per-key `touched*` sets mean **an individual `IDSet`
posting list is cloned at most once per batch** (`mutateIDSetIndex`, `snapshot.go:830-864`).
This is what keeps the heap-growth scale gate green — see §10.

`upsertApplication` (`snapshot.go:405`) does `reflect.DeepEqual(old, replacement)` and returns
`false` (no change) if identical. **Note for implementers: adding any float/map/slice field to
`ApplicationSummary` goes through this `reflect.DeepEqual`, and through `cloneApplications`
(`snapshot.go:274`) which currently deep-copies only `Targets` and `ObservabilityBindings`. A new
slice/map field MUST be added to `cloneApplications`, `cloneQueryApplicationSummary`
(`pagination.go:106`), `upsertApplication`, and `addApplicationMutable` (`snapshot.go:899`) or it
will be aliased across generations.**

### 4.2 Rebuild vs. delta race (`rebuild.go:272-357`)

`Rebuild` builds the replacement **off-lock**, while `ApplyDeltas` appends to `r.ledger` instead of
publishing whenever `r.rebuilding` is true or no base snapshot exists (`rebuild.go:412-417`). The
rebuild then loops: replay ledger tail → seal → re-take lock → if the ledger grew, loop again;
otherwise assign generation, `installOwned`, `SetHealth{Ready:true}`, swap `r.deps`, truncate the
ledger, clear `rebuilding`.

---

## 5. `indexGeneration` — what it means and where it is bumped

**There is no identifier literally named `indexGeneration` in Go.** In Go it is
`Snapshot.Generation uint64` (`snapshot.go:14`). `index_generation` is the **proto/UI** name.

Meaning: a monotonically increasing counter of *published snapshots on this replica*. It is
**replica-local and not comparable across replicas.** It is not a Kubernetes resourceVersion.

Bump sites (the only two):

| Where | Code | Rule |
|---|---|---|
| Full rebuild | `rebuild.go:337-341` | `generation = 1` if no current snapshot, else `current.Generation + 1`. |
| Delta batch | `rebuild.go:424` | `next.snapshot.Generation = base.Generation + 1` — **only when `result.Changed` is true** (`rebuild.go:420-423` returns early on no-op, so a no-op batch does NOT bump). |

Other touch points:
- `NewSnapshot(generation uint64)` (`snapshot.go:53`) — builder seed; `buildProjectionSnapshot`
  seeds with `0` (`rebuild.go:591`) and the real value is stamped at publication.
- `snapshotEditor.seal(generation)` (`snapshot.go:544`) sets `e.next.Generation = generation`;
  `applyDeltasToSnapshot` seals with `base.Generation` (`rebuild.go:766`) and the caller then
  overwrites with `base.Generation + 1`.
- Read out into every response: `ApplicationPage.Generation` (`pagination.go:25`, set at
  `pagination.go:84`), `FleetMap.Generation` (`map.go:97`/`163`), `FleetMatrix.Generation`
  (`matrix.go:52`, `matrix.go:148`/`320`), `Status.Generation` (`status.go:44`/`66`).
- Proto: `QueryApplicationsResponse.index_generation = 4`, `QueryFleetMapResponse = 3`,
  `QueryFleetMatrixResponse = 5`, `GetSystemStatusResponse = 1`
  (`proto/paprika/v1/api.proto:1049, 1071, 1104, 1141`).
- Telemetry: emitted as the numeric `generation` span attribute (`telemetry.go:53`, `:125`) and via
  `paprikametrics.RecordFleetIndexState(itemCount, generation)`.

**UI contract already depends on it:** `ui/src/lib/use-fleet-data.ts:396-438` treats a changed
`indexGeneration` as the cache-invalidation signal across pages, and refuses to stitch pages whose
generations differ. Any new list-shaped RPC that the console pages should therefore carry an
`index_generation` too, and derive it from `Snapshot.Generation`.

---

## 6. `QueryApplications` — request/response, facets, pagination, impact

### 6.1 Shapes

Request (`cursor.go:56-63`):
```go
type ApplicationQuery struct {
    Filter    ApplicationFilter
    Search    string
    Sort      SortField
    Direction SortDirection
    PageSize  uint32
}
```
`ApplicationFilter` (`filter.go:53-63`): `Projects []ProjectKey`, `Namespaces []string`,
`Clusters []ClusterKey`, `Stages []string`, `Health []Health`, `Sync []SyncState`,
`ReleaseStates`, `RolloutStates`, `SourceTypes`. Semantics: values in one field OR'd; non-empty
fields AND'd (`filter.go:51-52`).

`QueryScope` (`filter.go:27-30`) is computed per-request by the API auth layer
(`internal/api/fleet_capabilities.go:46 buildFleetQueryScope`): `Projects ProjectSet` gives
visibility (empty = fail closed), `CapabilitiesByProject` gives actions. **Capabilities are never
stored in the snapshot** — see the comment at `model.go:141-143`.

Response (`pagination.go:11-27`):
```go
type ApplicationQueryResult struct { Summary ApplicationSummary; Capabilities []Capability }
type ApplicationPage struct {
    Applications []ApplicationQueryResult
    Total        uint64   // full authorized+filtered count, NOT post-cursor
    NextCursor   string
    Generation   uint64
    Facets       []FacetBucket
}
```

### 6.2 Pipeline (`pagination.go:34-92`)

1. `query.Normalized()` — sorts/dedupes filters, validates enum ranges, NFKC-normalizes search,
   defaults sort→Name and direction→Asc, defaults page size 100 / caps 500
   (`cursor.go:18-24`, `:129-158`).
2. `FilterApplications(scope, filter, search)` (`filter.go:87`):
   - `authorizedSearch` — `unionPostings(s.ByProject, scope.Projects)` **first**, then
     `s.Search(query, authorized)`. Search can never widen the authorized set.
   - Then nine `intersectPostings` calls against `ByProject`, `ByNamespace`, `ByCluster`,
     `ByStage`, `ByHealth`, `BySync`, `ByRelease`, `ByRollout`, `BySourceType`.
3. `Facets(scope, filter, search)` — recomputed on **every** call (see §6.3).
4. Build `[]applicationPageEntry{summary, boundary}` for the whole result set, `sort.Slice` with
   `comparePageBoundaries`.
5. `seekApplicationPage` — `sort.Search` for the first entry strictly greater than the decoded
   cursor boundary. **Full sort of the whole filtered set on every page request**; the cursor is a
   seek, not an offset.
6. Slice `[start, start+PageSize)`, clone each summary, attach `scope.SortedCapabilities(project)`.
7. `NextCursor = EncodePageCursor(normalized, entries[end-1].boundary)` when more remain.

### 6.3 Facets (`facets.go`)

Nine dimensions (`facets.go:9-20`): Project, Namespace, Cluster, Stage, Health, Sync, Release,
Rollout, SourceType. Each is **self-excluding**: `facetCandidates(base, filter, own)`
(`facets.go:76`) applies every active filter dimension *except* its own, so a facet list keeps
showing the other options within its dimension.

- Cluster and Stage facets iterate `Targets` with a per-application `seen` set — an application
  counts **once per distinct cluster/stage**, so cluster facet counts can exceed `Total`.
- `FacetBucket` (`facets.go:24-30`): `Dimension`, `Object` (namespaced identities) XOR `Value`
  (canonical scalar), `Label`, `Count`. Proto uses a `oneof key` (`api.proto:1021-1029`).
- Canonical scalar strings live in `canonicalHealth/Sync/Release/Rollout/SourceType`
  (`facets.go:212-330`) — e.g. `"out_of_sync"`, `"awaiting_approval"`, `"rolled_back"`.
- Cost: 9 × O(|candidates|) map passes per query, plus `authorizedSearch` once. This is the single
  hottest part of the query path and it is **not memoized** anywhere.

### 6.4 Cursors (`cursor.go:315-501`)

- Envelope: `{v, queryHash, tuple PageKey, namespace, name}`, JSON → base64 RawURL, ≤ 4 KiB.
- `queryHash` = SHA-256 over `canonicalApplicationQuery` (schema v1) — **the entire user query
  including filter, search, sort, direction, and page size**. `DecodePageCursor` constant-time
  compares; any query change → `InvalidCursorQueryMismatch`.
- Strict decode: `DisallowUnknownFields`, no trailing JSON, and re-marshal must be **byte-identical**
  (`InvalidCursorNonCanonical`). Enumerated safe reasons at `cursor.go:493-501`… `cursor.go:378-386`.
- **Implication:** adding a field to `ApplicationFilter` or a new `SortField` requires updating
  `canonicalApplicationFilter` / `canonicalApplicationQuery` (`cursor.go:203-222`) and `PageKey`
  (`cursor.go:466-479`), which silently invalidates all in-flight cursors (that is safe — clients
  get `InvalidCursorQueryMismatch` and restart at page 1). Bump `querySchemaVersion` /
  `cursorSchemaVersion` (`cursor.go:26-27`) if you want an explicit rejection instead.

### 6.5 `ImpactKey` — the blast-radius ranking

Defined at **`cursor.go:471-477`**:

```go
// ImpactKey is the complete lexicographic impact tuple.
type ImpactKey struct {
    UnhealthySeverity    uint8  `json:"unhealthySeverity"`
    BlockedGates         uint32 `json:"blockedGates"`
    ActiveChange         bool   `json:"activeChange"`
    ResourceCount        uint32 `json:"resourceCount"`
    LastTransitionUnixMS int64  `json:"lastTransitionUnixMs"`
}
```

Populated in `applicationPageKey` (`pagination.go:113-141`); compared by `compareImpact`
(`pagination.go:281-294`) strictly in field order. Supporting functions in `pagination.go`:

- `unhealthySeverity(health)` (`:159-178`) — Healthy 0 < Unspecified 1 < Unknown 2 < Progressing 3
  < Degraded 4 < Missing 5 < **Failed 6**.
- `hasActiveChange(summary)` (`:180`) = `activeRelease(ReleaseState) || activeRollout(RolloutState)`;
  active releases = Pending/Promoting/Canarying/Verifying/AwaitingApproval (`:184-201`); active
  rollouts = Pending/Progressing/Paused (`:203-219`).
- Selected via `SortFieldImpact = 11` in `compareSelectedPageKey` (`pagination.go:251`). Because
  `SortDirectionDesc` negates the comparison (`pagination.go:229-232`), **"worst first" is
  `Sort=Impact, Direction=Desc`.**

A *second, different* impact ranking exists for the system-status "attention" list:
`attentionEntry` + `compareAttention` (`status.go:23-32`, `:258-273`), ordered by
`healthSeverity → syncSeverity → blockedGates → changeSeverity → unhealthyConnections →
resourceCount → lastTransitionUnixMS`, all descending, with identity tiebreak. `needsAttention`
(`status.go:145`) gates inclusion. `unhealthyConnectionCount` (`status.go:231`) dedupes
repository/observability/cluster unhealthy references.

**Neither ranking has any notion of traffic, cost, tier, or user impact today** — the closest
proxies are `ResourceCount` and `BlockedGateCount`.

---

## 7. `QueryFleetMap` (treemap) and `QueryFleetMatrix`

### 7.1 Map (`map.go:104-158`)

Request `FleetMapQuery{Filter, Search, Group GroupDimension, SizeMetric}`.
`GroupDimension` ∈ {Project(1), Cluster(2), Stage(3), Health(4)}, default Project (`map.go:160`).
`SizeMetric` ∈ {ResourceCount(1), RequestRate(2)}, default ResourceCount (`map.go:169`).

Output is **two levels**: group roots, each with application leaves.

```go
type FleetMapNode struct {
    StableID, Label string
    Kind FleetMapNodeKind          // Group | Application
    Application, GroupObject types.NamespacedName
    GroupValue string
    ApplicationCount, TargetCount uint64
    Health []HealthBucket
    ResourceWeight uint64
    RequestRateWeight, EffectiveWeight float64
    UsedResourceFallback bool
    Children []FleetMapNode
}
```

Stable IDs: `"a:" + ns/name` for leaves (`map.go:264`), `"g:" + dimension + ":" + canonical`
for groups (`map.go:325`); `canonical` is `url.PathEscape`d (`map.go:571-573`).

An application appears **exactly once**, keyed by its *current* target
(`currentStageTarget`, `map.go:462`, matches `CurrentStage` **and** `CurrentCluster`). Sentinel
groups: `"unassigned"`, `"in-cluster"`, `"unmanaged-inline"` (`map.go:187-207`).

### 7.2 Matrix (`matrix.go:66-125`)

`FleetMatrixQuery{Filter, Search, RowGroup, ColumnGroup, SizeMetric}`. Axes must both be concrete
and **distinct** (`validateMatrixAxes`, `matrix.go:128`; typed `ErrInvalidMatrixAxes` so the API can
map to `InvalidArgument` without string matching). Result is sparse: `Rows`, `Columns`, `Cells`.

Two aggregation modes:
- **target mode** (`aggregateMatrixTargets`, `matrix.go:140`) when either axis is Stage or Cluster:
  each selected real target is projected exactly once and supplies both axis keys, so no Cartesian
  blow-up. `ApplicationCount` is deduped per cell via `seenApplicationCells`.
- **application mode** (`aggregateMatrixApplication`, `matrix.go:175`) otherwise.

`FleetMatrix.Total` retains **application-level** filter semantics even when an app has no target
matching an active stage/cluster filter (`matrix.go:44-47`).

### 7.3 The `WeightReader` seam — the pre-built hook for per-app metrics

```go
// map.go:34-43
type TargetWeightKey struct {
    Project     ProjectKey
    Application types.NamespacedName
    Stage       string
    Cluster     ClusterKey
}
type WeightReader interface {
    RequestRate(TargetWeightKey) (float64, bool)   // must perform no Kubernetes/provider reads
}
```

**This is the single most important existing extension point for the metrics gap (design gap #2).**

- `Snapshot.QueryMap` / `QueryMatrix` already take a `WeightReader` parameter.
- `Index.QueryMap` / `Index.QueryMatrix` **pass `nil` today** (`reader.go:104`, `reader.go:124`),
  with the doc comment: *"delegates without a WeightReader until the future metrics cache is
  injected through a fleet-owned decorator or Index dependency."*
- There is **no implementation of `WeightReader` anywhere in the repo** outside
  `fakeWeightReader` in `map_test.go:504`.
- Fallback semantics are already fully specified and tested: any missing/NaN/Inf/negative/overflowing
  weight sets `UsedResourceFallback` and the node falls back to `ResourceWeight` atomically per leaf
  (`applicationMapLeaf`, `map.go:257-303`; `checkedAddWeight`, `map.go:432`). Matrix uses
  `requestComplete` per cell (`matrix.go:239-266`).
- Proto already carries `request_rate_weight` and `used_resource_fallback` on both
  `FleetMapNode` and `FleetMatrixCell` (`api.proto:1084-1092`, `:1119-1126`).

**Recommendation: implement `WeightReader` (and sibling readers for CPU/mem/latency/error rate/cost)
as a fleet-owned decorator injected into `Index`, exactly as the comment anticipates. Do not put
metrics into `Snapshot`.** See §9.

---

## 8. Per-application fields the index holds today (VERBATIM)

`internal/fleet/model.go:145-172`:

```go
// ApplicationSummary contains only provider-neutral data required to answer
// fleet queries. Capabilities are intentionally absent: authorization derives
// them for each request instead of persisting them in a shared snapshot.
type ApplicationSummary struct {
	Identity                     types.NamespacedName
	Project                      ProjectKey
	Targets                      []StageTargetSummary
	CurrentStage                 string
	CurrentCluster               ClusterKey
	CurrentClusterLabel          string
	SourceType                   SourceType
	SourceRevision               string
	Health                       Health
	Sync                         SyncState
	DriftCount                   uint32
	MissingResourceCount         uint32
	ReleaseState                 ReleaseState
	RolloutState                 RolloutState
	ResourceCount                uint32
	Repository                   types.NamespacedName
	RepositoryConnection         ConnectionState
	EffectiveObservabilitySource types.NamespacedName
	ObservabilityConnection      ConnectionState
	// ObservabilityBindings retains every normalized source dependency returned
	// by the optional projector. The first entry is the effective source; all
	// entries participate in reverse invalidation. It is immutable after install.
	ObservabilityBindings []types.NamespacedName
	BlockedGateCount      uint32
	LastTransitionUnixMS  int64
}
```

`internal/fleet/model.go:131-140`:

```go
// StageTargetSummary is immutable after its containing snapshot is installed.
type StageTargetSummary struct {
	StableID               string
	Stage                  string
	Ring                   int32
	Cluster                ClusterKey
	ClusterLabel           string
	Health                 Health
	ClusterConnection      ConnectionState
	UnmanagedInlineCluster bool
}
```

`internal/fleet/model.go:175-201`:

```go
type ProjectSummary struct {
	Identity ProjectKey
}

// RepositorySummary is deliberately compact: provider URLs, credential
// references, messages, and raw Kubernetes objects never enter the index.
type RepositorySummary struct {
	Identity   RepositoryKey
	Connection ConnectionState
}

// ClusterSummary retains only the identity and display/connection data needed
// by fleet views. Connection configuration and Secret references are excluded.
type ClusterSummary struct {
	Identity    ClusterKey
	DisplayName string
	Connection  ConnectionState
}

type SourceSummary struct {
	Identity   SourceKey
	Project    ProjectKey
	Connection ConnectionState
}
```

`Snapshot` itself (`snapshot.go:13-34`) — the inverted indexes available for O(1) filtering:

```go
type Snapshot struct {
	Generation   uint64
	Applications map[types.NamespacedName]ApplicationSummary
	Projects     map[ProjectKey]ProjectSummary
	Repositories map[RepositoryKey]RepositorySummary
	Clusters     map[ClusterKey]ClusterSummary
	Sources      map[SourceKey]SourceSummary
	ByProject    map[ProjectKey]IDSet
	ByNamespace  map[string]IDSet
	ByRepository map[RepositoryKey]IDSet
	ByCluster    map[ClusterKey]IDSet
	BySource     map[SourceKey]IDSet
	ByStage      map[string]IDSet
	ByHealth     map[Health]IDSet
	BySync       map[SyncState]IDSet
	ByRelease    map[ReleaseState]IDSet
	ByRollout    map[RolloutState]IDSet
	BySourceType map[SourceType]IDSet
	Trigrams     map[string]IDSet

	searchDocuments map[types.NamespacedName]searchDocument
	sourceBindings  map[types.NamespacedName][]SourceKey
}
```

### 8.1 What is **absent** (explicitly)

Against the design gap list:

| Needed | Status in `internal/fleet` | Nearest existing thing |
|---|---|---|
| Cluster nodes / region / k8s version / pod counts / cluster list RPC | **Absent.** `ClusterSummary` has only `Identity`, `DisplayName`, `Connection`. | `Snapshot.Clusters` map exists and is already delta-maintained. `clustersv1alpha1.ClusterStatus` has `Version`, `Phase`, `LastHealthCheckTime`, `AgentInfo{Version,Connected,Address}`; `ClusterSpec` has `Labels map[string]string`, `Mode`, `Server`. **No node count, no region, no pod counts anywhere in the CRD** — those need a new source (agent report / metrics). |
| CPU/mem used-requested-allocatable, request rate, latency, error rate | **Absent.** | `WeightReader.RequestRate` seam (§7.3), `SizeMetricRequestRate`, `RequestRateWeight`/`UsedResourceFallback` plumbed end-to-end to proto and UI. |
| Cost per app / per cluster | **Absent.** No token `cost` appears in the package. | Nothing. `ResourceCount` is the only size proxy. |
| Source-trigger / webhook event feed | **Absent** from fleet. | `internal/webhook`, `internal/source` exist as separate packages (not projected here). |
| Rollout history / durations / medians | **Absent.** Only the *current* `RolloutState` enum. | `RolloutState`, `ReleaseState`, `LastTransitionUnixMS`. |
| Pipeline run history, tests, cache hit rate, CPU-minutes | **Absent.** `Pipeline` is not one of the seven projected CRDs. | `Application.Status.PipelineRef` exists on the CRD but is **not** projected into `ApplicationSummary`. |
| Commit author / message / run number | **Absent.** | `SourceRevision string` only (raw revision). `Application.Status.SourceHash`, `.Revision` exist on the CRD, unprojected. |
| Owner / on-call / tier / runbook / drilldown URL | **Absent.** No such field or concept. | Nothing. Would come from `Application` labels/annotations or `AppProject`. |
| Per-resource drift detail (changed-field counts, timestamps, reasons) | **Absent.** Only aggregate `DriftCount uint32` and `MissingResourceCount uint32`. | `Application.Status.Resources []ResourceSync` is read in-projection (`countMissingResources`, `projection.go:230`) but only counted, never retained. |
| 6-phase lifecycle vector (source/build/test/render/deploy/verify) | **Absent.** | `Application.Status.Phase` (Pending/Building/Promoting/Canarying/Verifying/Healthy/Degraded/Failed/RolledBack) is collapsed into a single `Health` by `mapApplicationHealth` (`projection.go:168`) and **the phase itself is discarded**. `Status.Stages`, `.Gates`, `.HealthChecks`, `.AnalysisResults`, `.HookStatuses` are all available on the CRD and unprojected. |
| Mutations (hold rollout, ignore field, JSON patch, selective sync) | **Absent by design.** `fleet` is read-only; `Reader` has no write methods. | Existing mutations live in `internal/api/*_handler.go` (e.g. `SyncApplication`, `ApproveGate`). |

---

## 9. Where new per-application derived data should be computed and cached

Three viable layers. Recommendation per data class:

### 9.1 Layer A — inside `projectApplication` (`projection.go:48-116`), stored on `ApplicationSummary`

**Use for: lifecycle phase vector, commit metadata, ownership metadata, per-resource drift detail.**

Why: these are all *pure functions of the CRDs already loaded into `projectionInput`*
(`projection.go:35-46`: application, project, stages, releases, rollouts, repositories, clusters,
sources). No new informer, no new I/O, and delta invalidation is already correct — any change to
the Application/Stage/Release/Rollout re-runs `projectApplication` for exactly the affected keys.

Concretely:
- **Lifecycle vector**: derive from `app.Status.Phase`, `app.Status.Stages`, `app.Status.Gates`,
  `app.Status.HealthChecks`, `app.Status.AnalysisResults`, `app.Status.HookStatuses`, plus
  `release.Status.Phase` / `rollout.Status.Phase`. Add a `LifecyclePhases [6]PhaseState` fixed-size
  array (array, not slice — keeps `reflect.DeepEqual` and cloning trivial, no `cloneApplications`
  change needed) plus `PhaseUnixMS [6]int64`.
- **Commit metadata**: `Application.Status.SourceHash` / `.Revision` are already on the object;
  author/message/run-number are **not** — they need to come from a source/webhook-owned annotation
  or a new optional projector. Put whatever is on the object into scalar string fields; keep them
  short and bounded.
- **Ownership**: read from `app.ObjectMeta.Labels`/`Annotations` and/or the `AppProject`. Note
  `input.project` is currently only populated when an optional projector is registered
  (`rebuild.go:1268-1276` and `buildProjectionSnapshot`'s `projectByKey[declaredProject(app)]` at
  `rebuild.go:1207`-ish); **if ownership is derived from `AppProject`, `loadProjectionInput` must
  fetch the project unconditionally, and the `ResourceAppProject` delta branch
  (`rebuild.go:840-857`) must stop gating its reprojection on `r.optionalSourceProjector != nil`.**
- **Drift detail**: `app.Status.Resources []ResourceSync` — retain a *bounded* per-resource slice
  (cap it; `clampUint32`/`lengthUint32` at `projection.go:208-228` show the existing clamping
  idiom). Remember to extend `cloneApplications` (`snapshot.go:274`) and
  `cloneQueryApplicationSummary` (`pagination.go:106`) for any new slice.

Cost of Layer A: bigger snapshot heap. The scale gate (§10) asserts a bounded retained-heap growth
across two identical installs at 10 000 applications, so keep new fields fixed-size where possible.

If you also want to **filter or facet** on new fields (e.g. "tier = 1", "phase = build"), add a
matching `By<X> map[X]IDSet` posting index to `Snapshot` (`snapshot.go:13-31`), to `NewSnapshot`
(`:53`), `cloneSnapshot` (`:248`), `indexKeysForApplication` (`snapshot.go:750`),
`updateApplicationIndexes` (`:783`), `addApplicationMutable` (`:899`), plus a `<x>Cloned` flag and
`<x>Sets` touched-map on `snapshotEditor` (`:335-403`) — that is the full checklist.

### 9.2 Layer B — a fleet-owned decorator implementing `WeightReader`-style interfaces, injected into `Index`

**Use for: capacity/metrics (CPU, memory, request rate, latency, error rate) and cost.**

Why: this data is (a) not derived from the seven CRDs, (b) high-churn (seconds), (c) must not force
a snapshot generation bump on every scrape — bumping generation invalidates the whole UI page cache
(`ui/src/lib/use-fleet-data.ts:396-438`). Keeping it out of `Snapshot` preserves the
"one atomic pointer, immutable by contract" invariant and the heap gate.

The design already anticipates this verbatim at `reader.go:96-98` and `reader.go:118-120`
("*until the future metrics cache is injected through a fleet-owned decorator or Index dependency*").

Shape to follow:
```go
// keyed exactly like the existing seam
type TargetWeightKey struct { Project, Application types.NamespacedName; Stage string; Cluster ClusterKey }

type WeightReader interface { RequestRate(TargetWeightKey) (float64, bool) }
// add siblings with identical (value, ok) semantics:
//   CPUUsage/CPURequested/CPUAllocatable, MemoryUsage/..., LatencyP50/P95, ErrorRate
//   MonthlyCostCents(TargetWeightKey) / MonthlyCostCentsForCluster(ClusterKey)
```
Rules already enforced by the existing code and worth copying: **no Kubernetes or provider reads
inside the reader** (`map.go:40-41`), and every consumer must handle `!ok` / NaN / Inf / negative /
overflow by falling back and setting an explicit `used_*_fallback` bit (`map.go:277-300`,
`matrix.go:239-266`). Never silently render 0.

Placement: a `metricsCache` struct in `internal/fleet` (or a small `internal/fleet/weights`
subpackage) with its own `atomic.Pointer[map[...]]`, refreshed on its own ticker, wired into
`Index` as a field and passed down at `reader.go:104` / `reader.go:124`. Give it its own TTL and
its own "stale" flag so a metrics outage degrades to resource-count weighting instead of failing
the query.

### 9.3 Layer C — outside `fleet` entirely

**Use for: rollout history, pipeline run history, webhook/source event feed, mutations.**

These are time-series / append-only / write paths. They do not belong in a snapshot whose whole
contract is "immutable, replica-local, rebuildable from the cache in one pass". Serve them from new
handlers in `internal/api` reading the relevant CRDs or a dedicated store. `internal/fleet` should
at most expose the *current* pointer (e.g. `RolloutState`) and let the detail RPC do the history.

### 9.4 Cluster infrastructure (gap #1) — special note

`Snapshot.Clusters` already exists, is already delta-maintained (`rebuild.go:876-897`), and already
has a projector function `projectClusterSummary` (`connection_projection.go:29`). Extending
`ClusterSummary` with `KubernetesVersion` (from `cluster.Status.Version`), `Mode`, `Region`
(from `cluster.Spec.Labels`), `AgentVersion`/`AgentConnectedUnixMS` (from `Status.AgentInfo`), and
`LastHealthCheckUnixMS` is **cheap and correct today** — those fields are on the CRD.
`NodeCount` and `PodCount` are **not** on the CRD and must come from Layer B (a metrics/agent
cache), not from the projection.

A `ListClusters`/`QueryClusters` RPC can be added to `Reader` and served purely from
`Snapshot.Clusters` + `Snapshot.ByCluster` (which already gives per-cluster application counts for
free). Note `Reader` (`reader.go:11-18`) is a small interface with one production implementation
(`*Index`) and one stub (`unavailableReader`, `runtime.go:452-514`) — **both must be updated when
adding a method**; there is no generated mock for `fleet.Reader` (`internal/api/mocks/` contains
only `evaluator.go`).

---

## 10. Performance envelope and the guardrails you must not break

`scale_test.go:14-23`:
```go
fleetScaleApplicationCount = 10_000
fleetScaleProjectCount     = 100
fleetScaleClusterCount     = 100
fleetScaleWarmQueryCount   = 10
fleetScaleQueryCount       = 100
fleetScaleP95Limit         = 300 * time.Millisecond
fleetScaleControlledEnvironment = "PAPRIKA_FLEET_SCALE_CONTROLLED"
```
`TestFleetAPIScaleGate` (`scale_test.go:30`) asserts (a) query p95 ≤ 300 ms at 10 k apps and
(b) a bounded **retained heap growth after a second identical install** — i.e. the copy-on-write
editor must not deep-copy the world. Skipped under `-race`. `TestFleetScaleP95ThresholdIsStrict`
(`:443`) and `TestFleetScaleHeapGrowthThresholdIsStrict` (`:462`) guard the thresholds themselves.

Costs to keep in mind when adding data:
- `QueryApplications` sorts the **entire** filtered set per page (`pagination.go:57-59`).
- `Facets` is 9 full passes per query and is called by `QueryApplications`, `QueryMap`, **and**
  `QueryMatrix` (`pagination.go:50`, `map.go:127`, `matrix.go:96`).
- `upsertApplication` runs `reflect.DeepEqual` on the whole summary (`snapshot.go:414`).

Telemetry to extend alongside any new query kind: `fleetQueryKind` (`telemetry.go:34-38`) and
`paprikametrics.FleetQueryKind` (`internal/metrics/fleet.go:21-28`, allow-list at
`normalizeFleetQueryKind`, `:303`). Span attributes are **numeric-only by design**
(`telemetry.go:49-58`) — never add identities, filters, cursors, or URLs.

---

## 11. Does `internal/cache` back the fleet index? **No.**

`internal/cache` (`interfaces.go`, `factory.go`, `memory.go`, `redis.go`, `invalidator.go`,
`hash.go` — 609 LOC total) is a **byte-blob KV cache with TTL** (Get/Set/Delete/Ping/Close/
DeleteByPrefix) used for **rendered manifests and source resolution**:

- Key namespaces: `ManifestCachePrefix = "manifest"`, `SourceCachePrefix = "source"`
  (`internal/cache/interfaces.go:60-66`), helpers `ManifestKey(sourceType, sourceURL, revision, params)`
  and `SourceKey(sourceType, sourceURL, revision)`.
- Consumers: `internal/engine/cached_renderer.go`, `internal/reposerver/server.go`, and the
  `cmd/` wiring. **Zero imports from `internal/fleet`** (verified by grep).

The "fleet cache" language inside `internal/fleet` (`CacheStore`, `fleetCacheHit/Miss/Stale`) refers
to the **controller-runtime informer cache** and to snapshot freshness, not to `internal/cache`.

If you add a Redis-backed metrics/cost cache for Layer B, `internal/cache.Cache` is a reasonable
*transport*, but it must sit behind a `WeightReader`-style in-memory front so the fleet query path
stays synchronous and I/O-free (the `WeightReader` contract at `map.go:40-41` forbids remote reads).

---

## 12. Concrete change checklist for adding a field to `ApplicationSummary`

1. `internal/fleet/model.go:145` — add the field.
2. `internal/fleet/projection.go:48 projectApplication` — populate it.
3. If slice/map: `snapshot.go:274 cloneApplications`, `snapshot.go:405 upsertApplication`,
   `snapshot.go:899 addApplicationMutable`, `pagination.go:106 cloneQueryApplicationSummary`.
4. If filterable/facetable: `filter.go:53 ApplicationFilter`, `filter.go:87 FilterApplications`,
   `cursor.go:203 canonicalApplicationFilter`, `cursor.go:97 validateApplicationFilter`,
   `facets.go:9 FacetDimension` + `facets.go:76 facetCandidates` + a bucket builder,
   new `Snapshot.By<X>` index (full checklist in §9.1),
   `reader.go:229 activeFleetFilterDimensions`.
5. If sortable: `cursor.go:31 SortField` (+ `normalizeSortField` upper bound at `cursor.go:129`),
   `cursor.go:466 PageKey`, `pagination.go:113 applicationPageKey`,
   `pagination.go:236 compareSelectedPageKey`, `cursor.go:461 validatePageBoundary` helpers.
6. Proto: `proto/paprika/v1/api.proto:998 message ApplicationSummary` (next free field number is
   **23**; 1–22 are taken).
7. API mapping: `internal/api/fleet_handler.go:550 fleetApplicationResultToProto`.
8. **`internal/api/fleet_contract_test.go`** — `fleetMessageDescriptorContracts["ApplicationSummary"]`
   (~line 248) asserts an **exact field count and per-field number/type**
   (`require.Equalf(t, len(wantFields), message.Fields().Len(), "message %s field count changed")`,
   `:488`). This test WILL fail until updated. There are also legacy-descriptor assertions at
   `:18 assertLegacyFleetDescriptors`.
9. Regenerate TS: `ui/src/gen/paprika/v1/api_pb.d.ts` and update `ui/src/lib/fleet-client.ts`.

For a new **RPC**: add to `Reader` (`reader.go:11`), implement on `*Index`, implement the
fail-closed version on `unavailableReader` (`runtime.go:452-514`), add a `fleetQueryKind`
(`telemetry.go:34`) and `paprikametrics.FleetQueryKind` (`internal/metrics/fleet.go:25`), add the
handler in `internal/api/`, and remember `index_generation` in the response message.

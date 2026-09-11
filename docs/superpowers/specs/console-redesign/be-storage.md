# Paprika Persistence Audit — where anything is stored today

Scope: `internal/cache`, `internal/audit`, `internal/governance`, `internal/fleet`,
`internal/api/events`, CRD types under `api/`, Helm chart under `charts/chart`.

---

## 0. Executive answer

**There is no database. Paprika is a pure CRD-only control plane.**

- No `database/sql` import anywhere in the repo. Verified:
  `rg -l '"database/sql"|bbolt|badger|sqlite|jackc/pgx|lib/pq' --glob '*.go'` → **zero hits**.
- No bolt / badger / sqlite / postgres / mysql / clickhouse / leveldb mention in any
  non-test Go file. Verified:
  `rg -ni '\b(sqlite|bbolt|boltdb|badger|postgres|pgx|mysql|clickhouse|leveldb)\b' --glob '*.go' -g '!*_test.go'` → **zero hits**.
- `go.mod` **does** contain `github.com/lib/pq`, `github.com/jmoiron/sqlx`,
  `github.com/rubenv/sql-migrate`, `github.com/Masterminds/squirrel`, `github.com/go-gorp/gorp/v3`
  — **all marked `// indirect`**. They are transitive deps of `helm.sh/helm/v3` (Helm's
  SQL release-storage backend). Paprika itself never imports them. Do not mistake these
  for an existing SQL story.
- The only direct data-store dependency is `github.com/redis/go-redis/v9 v9.20.1`
  (go.mod, direct require block) plus `github.com/alicebob/miniredis/v2` for tests.
  **Redis is used strictly as a cache and a pub/sub bus, never as a store of record** (proof below).

Durable state lives in **etcd, via the Kubernetes API server, as Custom Resources**.
There are 18 CRDs (`config/crd/bases/`):

```
clusters.paprika.io_clusters
core.paprika.io_appprojects, core.paprika.io_repositories
featureflags.paprika.io_featureflags, _featureflagbindings
pipelines.paprika.io_analysisruns, _analysistemplates, _applications, _applicationsets,
                     _artifacts, _conftestpolicies, _notificationconfigs, _pipelines,
                     _releases, _stages, _templates
policy.paprika.io_policies
rollouts.paprika.io_rollouts
```

Go types: `api/{clusters,core,featureflags,pipelines,policy,rollouts}/v1alpha1/*_types.go`.

---

## 1. `internal/cache` — ephemeral KV cache only

Files: `interfaces.go`, `factory.go`, `redis.go`, `memory.go`, `hash.go`, `invalidator.go`.

### Interfaces (`internal/cache/interfaces.go`)
Role interfaces, lines 10–37: `Getter` (L10), `Setter` (L15), `Deleter` (L20),
`Pinger` (L25), `Closer` (L30), `PrefixDeleter` (L35). Unexported union `cacheImpl` (L42),
exported wrapper `struct Cache { cacheImpl }` (L55).

**Every `Set` takes a `ttl time.Duration` (L16). There is no TTL-free write path.**
This API cannot express durable storage.

### Namespaces (`interfaces.go` L62–85)
Only two prefixes exist:
- `ManifestCachePrefix = "manifest"` (L64) — rendered manifest YAML.
- `SourceCachePrefix = "source"` (L66) — source resolution results.

Keys are SHA-256 truncated to 32 hex chars (`hash.go:10 hashKey`).
`ManifestKey(sourceType, sourceURL, revision, params)` (L70),
`SourceKey(sourceType, sourceURL, revision)` (L75).

### Backends (`factory.go`)
`New(ctx, Config)` L70–85 switches on `cfg.Backend`:
- `"redis"` → `NewRedisCache(addr, password, db)` (`redis.go:18`).
- `"memory"` → `NewMemoryCache()` (`memory.go:26`), a `map[string]memoryItem` guarded by
  `sync.RWMutex`, TTL checked against `clock.Clock`. **Process-local, lost on restart.**
- anything else → error.

`Config` (L20–29) fields: `Backend`, `RedisAddr`, `RedisPassword`, `RedisDB`.
Env vars (documented L32–35): `PAPRIKA_CACHE_BACKEND` (default `memory`),
`PAPRIKA_REDIS_ADDR` (default `localhost:6379`), `PAPRIKA_REDIS_PASSWORD`, `PAPRIKA_REDIS_DB`.
`NewFromEnv` / `NewFromEnvLegacy` / `NewLegacy` are all marked `Deprecated:` — new code
should read env in `cmd/main` and pass an explicit `Config`.

### Invalidation (`invalidator.go`)
`Invalidator.Invalidate(ctx, sourceType, sourceURL, revision)` L21–44. Empty revision
wipes both the source and manifest prefixes; non-empty revision wipes only that revision's
manifest entries. Backed by `DeleteByPrefix`, which on Redis is a `SCAN`+`DEL` loop
(`redis.go:72–83`) — O(keyspace), not a server-side operation.

### Verdict
`internal/cache` is a content-addressed render cache. It is **not** a store abstraction
and must not be repurposed for history. Reusing it for rollout/pipeline history would
silently lose data on eviction.

---

## 2. Redis is explicitly configured to be non-durable

Chart: `charts/chart/templates/extras/redis-config.yaml` renders

```
redis.conf: |
  maxmemory 256mb
  maxmemory-policy allkeys-lru
  save ""
```

- `save ""` → **RDB snapshotting disabled**. No AOF is configured either.
- `allkeys-lru` → **any key may be evicted under memory pressure**, including keys you
  might be tempted to treat as records.
- `charts/chart/templates/extras/redis-deployment.yaml` L110–117: volumes are
  `configMap` (config), `emptyDir` (tmp), **`emptyDir` (data, mounted at `/data`, L102–103)**.
  `replicas: 1` (L21). It is a `Deployment`, not a `StatefulSet`.
- `charts/chart/values.yaml` L952–960: `redis.enabled: false` by **default**;
  `addr: "redis:6379"`, `password: ""`, `db: 0`.

**Conclusion: Redis is off by default, single-replica, non-persistent, eviction-enabled.**
Anything written there is best-effort and can vanish at any moment. It is unusable as a
system of record for console history.

### Other Redis consumers (all ephemeral by design)
- `internal/api/events/broker.go` — pub/sub fan-out across API replicas.
  `NewRedisBrokerWithContext` (L62), `Subscribe` (L125), `Unsubscribe` (L151).
  **Pure fan-out: no `XADD`/stream, no history, no replay.** A subscriber that connects
  after an event was published never sees it. `Subscribe` returns a `chan *Event` with
  buffer 16 (L126).
- `internal/coordinator/coordinator.go` — replica registry / sharding heartbeats.
  Uses `pipe.Expire(timeoutCtx, replicasKey(), c.heartbeatTTL)` (L185). TTL-scoped
  liveness only.

---

## 3. `internal/audit` — stdout JSON, zero retention in-process

File: `internal/audit/audit.go` (84 lines, the whole package).

### What is recorded — `type Event` (L20–34)
```go
Timestamp string            // RFC3339, UTC
Principal string            // authenticated user/service
Action    string            // "create"|"update"|"delete"|"apply"|"promote"|"approve"|"reject"
Resource  string            // e.g. "Application", "Release", "ConftestPolicy"
Name      string
Namespace string
Success   bool
Error     string            // omitempty
Extra     map[string]string // omitempty
TraceID   string            // omitempty — from active OTel span
SpanID    string            // omitempty
```

### Where it goes
- `Auditor` interface (L37–39): `Record(ctx, Event)`. No error return, no flush, no close.
- `LogAuditor` (L43–45) holds a single `io.Writer`. `NewLogAuditor()` (L48) hardcodes
  `os.Stdout`.
- `Record` (L62–77): enriches TraceID/SpanID from `trace.SpanFromContext(ctx)` (L63–66),
  defaults Timestamp (L67–69), `json.NewEncoder(l.out).Encode(event)` (L70–72).
  **On encode failure the event is dropped silently** (L73–76, explicit comment:
  "drop the event silently").
- `NoopAuditor` (L81–84) discards everything; used when auditing is disabled.

### Retention
**None inside Paprika.** The package doc (L1–6) is explicit: events are written to
stdout "where a Kubernetes log aggregator (fluent-bit, Loki, Cloud Logging, etc.)
collects them." Retention is entirely the cluster operator's log pipeline. There is no
buffer, no ring, no index, no query API. **You cannot read audit events back out of
Paprika.**

### Wiring
Three call sites, all identical:
- `cmd/main.go:413` `opts = append(opts, apiserver.WithAuditor(audit.NewLogAuditor()))`
- `cmd/main_operator.go:499` (same)
- `cmd/cloud-run/main.go:200` (same)

`charts/chart/values.yaml` (~L962): `audit.enabled: true` by default.

### The interceptor — `internal/api/audit_middleware.go`
- `auditVerbs` (L18–26) maps mutating RPC prefixes to actions:
  `Sync→update, Apply→apply, Approve→approve, Reject→reject, Rollback→update,
  Promote→promote, Abort→update`.
- `NewAuditInterceptor(a audit.Auditor, broker *events.Broker)` (L36–86). Non-matching
  methods (`List*`/`Get*`/`Resolve*`/`Render*`) short-circuit at L44–46 and are **not audited**.
- `classifyAudit` (L91–102) splits `/paprika.v1.PaprikaService/SyncApplication` into
  action + resource by verb-prefix stripping.
- Name/Namespace are duck-typed off the request message via `GetName()`/`GetNamespace()`
  (`nameFromRequest` L121–129, `namespaceFromRequest` L133–141).
- **Dual-write**: L67–81 also publishes an `events.AuditPayload` to
  `events.TopicDashboard` on the broker, for live UI feedback. This is fire-and-forget
  pub/sub — again, no replay.
- Ordering requirement documented at L33–35: must be installed *after* the auth
  interceptor so the principal is in ctx.

`events.AuditPayload` shape: `internal/api/events/eventtypes.go` L19–28.

> **Relevance to the redesign:** an "activity feed" of *user actions* is one interceptor
> change away from being persistable — the interceptor already builds a fully-populated
> struct at `audit_middleware.go:50`. The *source-trigger* feed (gap #4) is a different
> problem; see §6.

---

## 4. `internal/governance` — read-only, no persistence

Files: `resolver.go`, `cluster_resolver.go`, `policy_evaluator.go`, `validator.go`,
`match.go`, `violation.go`.

Every type holds a **`client.Reader`**, not a `client.Client`:
- `ProjectResolver{client client.Reader}` — `resolver.go:21`, ctor L24, `Resolve` L28.
- `PolicyEvaluator{client client.Reader}` — `policy_evaluator.go:18`, ctor L21,
  `List` at L27.
- `ClusterServerResolver{client client.Reader}` — `cluster_resolver.go:24`, ctor L19,
  `Get` at L40.

There are **no `Create`/`Update`/`Patch`/`Delete` calls in the package.** The kubebuilder
RBAC marker at `resolver.go:1` grants `create;update` on appprojects, but the compiled
code never exercises it (the reader type makes it impossible). Governance decisions are
computed on demand and returned; nothing is written down. **No violation history exists.**

---

## 5. `internal/fleet` — the closest thing to a store abstraction (in-memory read model)

This is the most important existing structure for the redesign and is easy to miss.

`internal/fleet/` is a **CQRS-style read model**: an in-memory, atomically-published,
denormalized index built from controller-runtime informers.

- `ProjectionStore` interface — `store.go` — a **cache-only read contract** over exactly
  seven CRDs: Application, Stage, Release, Rollout, AppProject, Repository, Cluster.
  Each has `ListX(ctx)` and `GetX(ctx, NamespacedName) (T, bool, error)`.
  Doc comment is emphatic: *"Callers must never retain returned Kubernetes objects."*
- `CacheStore` — `store_cache.go` — the adapter implementing `ProjectionStore` against a
  `client.Reader` + `runtime.Scheme`. `NewCacheStore(reader, scheme)`. Deep-copies
  everything out of the informer cache.
- `Snapshot` — `snapshot.go` L12–34 — immutable-by-contract denormalized view:
  `Generation uint64`, maps `Applications/Projects/Repositories/Clusters/Sources`, plus
  precomputed inverted indices `ByProject, ByNamespace, ByRepository, ByCluster, BySource,
  ByStage, ByHealth, BySync, ByRelease, ByRollout, BySourceType`, and a `Trigrams`
  map for substring search.
- `Index` — `snapshot.go` L38–41 — `atomic.Pointer[Snapshot]` + `atomic.Pointer[HealthState]`.
  Readers always observe one complete snapshot. `Install` publishes a deep clone.
- `Reader` interface — `reader.go` L14–21:
  ```go
  ProjectKeys(context.Context, []string) ([]ProjectKey, error)
  QueryApplications(context.Context, QueryScope, ApplicationQuery, string) (ApplicationPage, error)
  QueryMap(context.Context, QueryScope, FleetMapQuery) (FleetMap, error)
  QueryMatrix(context.Context, QueryScope, FleetMatrixQuery) (FleetMatrix, error)
  LoadSnapshot() (*Snapshot, error)
  CheckReady() error
  ```
  `var _ Reader = (*Index)(nil)` (L23).
- `runtime.go` wires `InformerSource` (controller-runtime cache) + a `workqueue` to
  rebuild/patch the snapshot on resource deltas.
- Wired into the API server: `internal/api/server.go:41` imports fleet,
  `WithFleetIndex(reader fleet.Reader)` (L60), field `fleetIndex fleet.Reader` (L105).

### Existing summary types (`model.go`) — what the index already carries
- `ApplicationSummary` (L145–171): `Identity, Project, Targets []StageTargetSummary,
  CurrentStage, CurrentCluster, CurrentClusterLabel, SourceType, SourceRevision, Health,
  Sync, DriftCount uint32, MissingResourceCount uint32, ReleaseState, RolloutState,
  ResourceCount uint32, Repository, RepositoryConnection, EffectiveObservabilitySource,
  ObservabilityConnection, ObservabilityBindings []NamespacedName, BlockedGateCount uint32,
  LastTransitionUnixMS int64`.
- `ClusterSummary` (L188–192): **only** `Identity, DisplayName, Connection`.
  Comment explicitly excludes connection config and Secret refs.
  → **No node count, region, k8s version, pod counts, or capacity.** (gap #1/#2)
- `RepositorySummary` (L181–184): `Identity, Connection`.
- `SourceSummary` (L197–201): `Identity, Project, Connection`.
- `ConnectionState` (L120–128): `Unspecified/Healthy/Unhealthy/Disabled/NotConfigured`.
- `Health` (L~52): `Unspecified/Healthy/Progressing/Degraded/Failed/Unknown`.
- `Capability` / `CapabilitySet` — `filter.go` L14–31:
  `CapabilityUnspecified=0, CapabilityApplicationSync=1, CapabilityReleaseRollback=2,
  CapabilityGateApprove=3, CapabilityPipelineRetry=4`, keyed per-project in
  `QueryScope.CapabilitiesByProject map[ProjectKey]CapabilitySet`.
  → **Gap #11's new mutations (hold rollout, ignore drifted field, apply JSON patch,
  selective resource sync) will each need a new `Capability` constant here**, or they
  will be unauthorizable in fleet views.

### ⭐ The designed extension seam — `optional_source.go`
```go
// OptionalSourceProjector is the provider-neutral seam implemented by a later
// observability plan. Plan 1 supplies nil and imports no future CRD package.
type OptionalSourceProjector interface {
    Prototype() client.Object
    Summarize(client.Object) (SourceSummary, error)
    Bindings(app *Application, project *AppProject, stages []Stage) []types.NamespacedName
}
```
(`optional_source.go` L14–25), plus `OptionalSourceStore` (L29–32) with
`ListOptionalSources`/`GetOptionalSource`.

`projectOptionalSourceBinding` (L57–95) already sets
`summary.ObservabilityConnection = ConnectionStateNotConfigured` when the projector is
nil (L66–68), validates cross-project binding leakage fail-closed (L105–108), and
populates `EffectiveObservabilitySource` (L102).

**This is a pre-built, currently-nil hook for exactly the metrics/cost/observability
data the redesign needs (gaps #2, #3).** The author explicitly reserved it for "a later
observability plan". Use it rather than inventing a parallel path.

---

## 6. Where history exists today, and where it does not

### 6a. History that DOES exist

**`Release` CRs are the de-facto rollout history.** One `Release` object per promotion
attempt, labelled with `engine.ApplicationNameLabelKey`.

Two prune paths, both bounded by `maxReleaseHistory = 10`
(`internal/controller/pipelines/application_controller.go:48`):

1. `pruneReleaseHistory(ctx, app)` — L1746–1790. Lists Releases by app label (L1750–1755),
   returns early if `<= maxReleaseHistory` (L1757), deletes only `Superseded` releases
   (L1768–1770), never the active `app.Status.ReleaseRef` (L1765, re-checked L1781).
   Called from L406.
2. `pruneOldReleases(ctx, app)` — L2099–2117, reached via `pruneReleasesIfInline`
   (L2090–2097) which gates on `r.isInlineSource(app)`. Uses
   `listReleasesSorted` (L2119–2138, newest-first by `CreationTimestamp`) then
   `selectReleasesToKeep` (L2140–2146) = `protectActiveRelease` (L2148) +
   `protectLatestNonSuperseded` (L2157) + `fillHistoryLimit` (L2169), then
   `deleteReleases` (L2183–2199). Emits a `PrunedReleases` Normal event (L2114) and
   `PruneReleaseFailed` Warning on error (L2193).

**`ReleaseStatus.PromotionHistory []PromotionEntry`** — `api/pipelines/v1alpha1/release_types.go:105`.
`PromotionEntry` (L55–60): `Stage, Result, ManifestSnapshot, Timestamp metav1.Time`.
- Appended at `internal/controller/pipelines/release_controller.go:454–458` with
  `Result: "Pending"`.
- The last entry's `Result` is later mutated in place to `"Passed"` (L681–682),
  `"Failed"` (L705–706), `"RolledBack"` (L2216–2217), `"CanaryFailed"` (L2559–2560),
  and in `canary_readiness.go:291–292` → `"CanaryFailed"`.
- ⚠️ **`PromotionHistory` is never trimmed.** No cap, no ring, no limit constant. A
  long-lived Release that is repeatedly promoted grows its status unbounded toward the
  etcd 1.5 MiB object ceiling. **This is the cautionary precedent — do not copy it
  verbatim.** Surfaced to the API at `internal/api/server.go:1349–1366`
  (`Release.promotion_history`, proto field 8, `internal/api/paprika/v1/api.pb.go:2813`).

**`ReleaseStatus.HookStatuses []HookStatus`** (`release_types.go:127`, type at L81–94):
`Kind, Name, Namespace, Phase (PreSync|Sync|PostSync|SyncFail), Status
(Running|Succeeded|Failed|Terminated), StartedAt, CompletedAt, Message`.
Comment at L125: "Cleared at the start of each promote" — so it is *current state*,
not history. Mirrored onto `ApplicationStatus.HookStatuses`.

**`Rollout.Spec.RevisionHistoryLimit *int32`** — `api/rollouts/v1alpha1/rollout_types.go:201`.
Defaulted to `10` by the webhook (`internal/webhook/rollouts/v1alpha1/rollout_webhook.go:59–60`)
and again in the controller (`internal/controller/rollouts/rollout_controller.go:297–298`).
Used at L534–542 to prune **ReplicaSets already scaled to 0** — it prunes k8s objects,
not rollout outcome records. It does **not** give you completed-rollout history.

**`AnalysisRun` CRs** (`api/pipelines/v1alpha1/analysis_run_types.go`) are the nearest
thing to a per-run record. `AnalysisRunStatus` (L56–74): `ObservedGeneration, Phase
(Pending|Running|Successful|Failed|Error|Completed), CyclesExecuted int, Results
[]AnalysisRunResult, StartedAt, CompletedAt, Conditions`. Deleted by
`internal/controller/pipelines/analysis_manager.go:123` — **no TTL, no history limit**;
deletion is lifecycle-driven, so completed runs are not reliably retained.

**Kubernetes `Event` objects.** `EventRecorder` is used in `cmd/main_controllers.go`,
`internal/controller/rollouts/rollout_controller.go`, `internal/controller/pipelines/{conftest_gate,
analysisrun_controller,analysis_manager,release_controller,application_controller,self_heal}.go`,
`internal/observability/observability.go`. These land in etcd with the **cluster's
default 1h TTL** (`--event-ttl`) and are aggressively deduplicated. Usable for a
"recent activity" strip, **not** for a durable feed.

### 6b. History that DOES NOT exist — plainly absent

| Redesign need | Status | Nearest existing thing |
|---|---|---|
| Cluster node count / region / k8s version / pod counts / capacity | **Absent** | `ClusterStatus.Version` (`api/clusters/v1alpha1/cluster_types.go:104`) is the k8s version string, and `LastHealthCheckTime` (L102). `AgentInfo{Version, Connected, Address}` (L60–64). `fleet.ClusterSummary` carries only Identity/DisplayName/Connection. |
| CPU/mem used·requested·allocatable; req rate, latency, error rate | **Absent** | Nothing. `internal/metrics` emits *Paprika's own* OTel/Prometheus metrics outward (`metrics.go`, `otel.go`, `fleet.go`, `kubernetes.go`); there is **no Prometheus query client** — `rg 'prometheus/client_golang/api\|promql\|v1.NewAPI\|QueryRange'` hits only two test fixture strings (`internal/metrics/fleet_test.go:131`, `internal/fleet/telemetry_test.go:396`). Paprika is a metrics *producer*, never a *consumer*. |
| Cost per app / per cluster | **Absent** | Nothing whatsoever. |
| Source-trigger / webhook event feed | **Absent** | `internal/webhook/receiver/handler.go` handles GitHub (`X-GitHub-Event`, L27) and GitLab (`X-GitLab-Event`, L29) push/ping. On a push it **only stamps an annotation**: `app.Annotations["paprika.io/sync"] = h.nowString()` (L231) then `h.client.Update(ctx, app)` (L233); same for Templates (L260–262). **The event body, commit SHA, author, message, and delivery ID are all discarded.** Last-trigger timestamp is the entire surviving record, and it is overwritten each time. |
| Completed-rollout history, durations, outcomes, medians | **Partial/absent** | Release CRs (capped at 10, deleted not archived) + `PromotionHistory` timestamps. No duration field, no aggregate. |
| Pipeline run history, test counts, cache-hit rate, CPU-minutes, per-step requests | **Absent** | There is **no `PipelineRun` CRD** — `Pipeline` is a template, not a run. `AnalysisRun` is the only run-shaped CRD. |
| Commit author / message / run number | **Absent** | `ApplicationStatus.Revision` (`application_types.go:575`), `.SourceRevision` (L579), `.SourceHash` (L578) are bare strings. |
| Owner / on-call / tier / runbook & drilldown URLs | **Absent** | No such fields on any CRD. Would live naturally on `AppProject` (`api/core/v1alpha1/appproject_types.go`) or Application labels/annotations. |
| Per-resource drift detail (changed-field count, drift timestamp, reason) | **Absent** | `ResourceSync` (`application_types.go:526–532`) is **only** `Kind, Name, Namespace, Status(Synced\|OutOfSync\|Missing\|Pruned)`. `ResourceHealth` (L535–542) adds `Health, Message`. `fleet.ApplicationSummary.DriftCount uint32` is an aggregate count with no detail. |
| 6-phase lifecycle vector (source/build/test/render/deploy/verify) | **Absent** | `ApplicationPhase` is a single scalar enum: `Pending;Building;Promoting;Canarying;Verifying;Healthy;Degraded;Failed;RolledBack` (`application_types.go:562`). |
| Mutations: hold rollout / ignore field / JSON patch / selective sync | **Absent** | Audit verbs today are only `Sync, Apply, Approve, Reject, Rollback, Promote, Abort` (`audit_middleware.go:18–26`). |

---

## 7. Backup / DR posture (`charts/chart`)

- **No PVC and no `volumeClaimTemplates` anywhere in the chart.** `charts/chart/templates/manager/statefulset.yaml`
  is a `StatefulSet` (L3) but its only `volumes:` block (L180) has no claim template.
  Grep for `PersistentVolumeClaim|volumeClaimTemplates` across `charts/` matches only
  prose inside the generated `rollouts.paprika.io_rollouts.yaml` CRD schema.
- The one durability feature is **Velero**, `charts/chart/templates/extras/velero.yaml`
  — renders a `velero.io/v1 Schedule` in `.Values.velero.namespace`.
  Values (`values.yaml` L969–~985): `velero.enabled: false` (default off),
  `namespace: velero`, `storageLocation: default`, `schedule: "0 */6 * * *"`,
  `ttl: "720h"` (30 days), `includeNamespaces: []`.
  Template sets `includedNamespaces: [ .Release.Namespace, ...extras ]` and
  `includeClusterResources: true`.

**Read the intent:** the project's declared durability story is *"back up the CRs".*
Velero snapshots every 6h with 30d retention. **Anything you want to survive a disaster
must be a Kubernetes object in a backed-up namespace.** State kept only in Redis or only
in process memory is, by the project's own design, expendable.

Other relevant values blocks: `redis.*` (L952–960), `audit.enabled: true` (~L962),
`externalSecrets.*` (~L988+).

---

## 8. Recommendation

### Principle
This codebase has exactly one durable substrate — **etcd via CRDs** — and exactly one
read path optimized for the console — **`internal/fleet`'s atomic snapshot index**.
The idiomatic answer is therefore: **write history as CRs, read it through fleet.**
Do not introduce a database. Doing so would mean a new StatefulSet, a new PVC, a
migration tool, a backup story that Velero does not cover, and a second source of truth
that can diverge from etcd — for a product whose entire premise is Kubernetes-native GitOps.

### Recommended split (by data class)

**(A) Event-like history → one new namespaced CRD per record, TTL-pruned.**
Applies to: source-trigger events (#4), completed rollouts (#5), pipeline runs (#6).

Propose three CRDs in `pipelines.paprika.io/v1alpha1`:
- `SourceEvent` — provider, repo URL, ref, commit SHA, author, message, delivery ID,
  received timestamp, triggered Application refs. Written by
  `internal/webhook/receiver/handler.go` at the point it currently only stamps
  `paprika.io/sync` (L228–233). Also carries commit metadata for gap #7.
- `RolloutRecord` — app, stage, cluster, revision, started/completed, duration,
  outcome, per-phase timings (feeds gap #10's lifecycle vector and gap #5's medians).
  Written on Release terminal transition, alongside the existing `PromotionHistory`
  `Result` mutations in `release_controller.go` (L681, L705, L2216, L2559).
- `PipelineRun` — steps, test counts, cache-hit rate, CPU-minutes, per-step
  resource requests, outcome.

Why a **new CRD** and not `status`:
- Status arrays grow unbounded and are re-serialized on every reconcile.
  `PromotionHistory` (`release_types.go:105`) is the live proof: it has **no cap**,
  and every append rewrites the whole Release status. Adding 6 more such arrays would
  push objects toward etcd's 1.5 MiB limit and multiply watch traffic to every informer.
- Separate objects are independently listable, label-selectable, paginable,
  RBAC-scopable, and individually deletable — which is what a feed needs.
- They are covered by the existing Velero schedule for free (namespaced, in the
  release/app namespaces).

Retention: follow the **`maxReleaseHistory = 10`** precedent
(`application_controller.go:48`) but make it configurable and **add a time bound too**,
since a feed is time-ordered rather than count-ordered. Concretely: a
`historyLimit` (count) + `historyTTL` (duration) on the chart, enforced by a small
prune helper modelled on `pruneOldReleases`/`fillHistoryLimit`
(`application_controller.go:2099–2199`) run on a timer. **Add label indices**
(`paprika.io/application`, `paprika.io/cluster`) so fleet can select without a full list —
`engine.ApplicationNameLabelKey` is the existing convention (`application_controller.go:2123`).

⚠️ Sizing caveat to state up front: a busy fleet can produce thousands of these per day.
Cap aggressively at write time and be honest in the UI that the feed is a *recent
window* (e.g. last 200 / last 7 days), not an archive. If a customer later needs a true
archive, that is an export-to-object-store feature, not an etcd feature.

**(B) Live infrastructure facts → read-through, cached, not persisted.**
Applies to: cluster node count / region / pod counts (#1), capacity (#2).

These are *derived* from the target clusters and go stale in seconds. Persisting them
in etcd creates a write amplification loop (every node-count change writes a CR).
Instead:
- Extend `ClusterStatus` (`api/clusters/v1alpha1/cluster_types.go:91–107`) with a small
  set of **slow-moving** fields only — `Region`, `NodeCount`, `PodCount`,
  `Allocatable{CPU,Memory}` — refreshed on the existing health-check cadence
  (`HealthCheckConfig`, L52–57, default `interval: 30s`, `timeout: 10s`,
  `LastHealthCheckTime` L102). This is exactly the pattern `Version` (L104) and
  `AgentInfo` (L106) already follow.
- Extend `fleet.ClusterSummary` (`model.go:188–192`) to carry them into the snapshot.
- Keep fast-moving utilization (CPU/mem *used*, request rate, latency, error rate)
  **out of etcd entirely**.

**(C) Metrics & cost → implement the reserved `OptionalSourceProjector` seam.**
Applies to: per-app request rate / latency / error rate (#2), cost (#3).

The author already carved this out — `internal/fleet/optional_source.go:14–25`,
"the provider-neutral seam implemented by a later observability plan." Implement it:
- Define an `ObservabilitySource`-style CRD holding *connection config* (Prometheus /
  Thanos / cost-provider endpoint + credential ref) — config, not data.
- Implement `OptionalSourceProjector.Prototype/Summarize/Bindings` against it, and
  `OptionalSourceStore` on `CacheStore` (`store_cache.go`).
- Query the backend read-through, caching responses in `internal/cache` with a short TTL
  (that is what the TTL-only `Setter` at `interfaces.go:16` is *for*). A cache miss must
  degrade to "unknown", never to a wrong number — `ConnectionStateNotConfigured` and
  `ConnectionStateUnhealthy` (`model.go:127, 125`) already exist for exactly this, and
  `projectOptionalSourceBinding` already sets them (`optional_source.go:66–68, 85`).
- Note this is currently a **greenfield integration**: there is no Prometheus query
  client in the tree at all (§6b). Budget for it.

**(D) Small scalar/enum additions → extend existing CRD status in place.**
Applies to: drift detail (#9), lifecycle vector (#10), ownership (#8), commit metadata (#7).
- Drift: widen `ResourceSync` (`application_types.go:526–532`) with
  `ChangedFieldCount int32`, `DriftedAt *metav1.Time`, `DriftReason string`.
  Bounded by resource count, which `ResourceCount` already tracks — safe.
- Lifecycle: add a `Phases []PhaseStatus` (6 fixed entries) to `ApplicationStatus`, or
  six typed conditions. **Fixed cardinality — cannot grow.** Safe in status.
- Ownership (owner, on-call, tier, runbook/drilldown URLs): put on `AppProject`
  (`api/core/v1alpha1/appproject_types.go`) as spec fields, with per-Application
  annotation override. Static config, correctly spec-not-status, and it inherits
  AppProject's existing governance/RBAC.
- Commit metadata: `ApplicationStatus.Revision/SourceRevision/SourceHash`
  (L575/L579/L578) are bare strings today; add a `RevisionInfo{Author, Message,
  RunNumber, CommittedAt}` struct. Populate from the `SourceEvent` in (A).

**(E) Mutations (#11) → CRD spec fields + new audit verbs. No storage change.**
- Hold a rollout → a spec field / annotation on Rollout, reconciled.
- Ignore a drifted field → a persistent `ignoreDifferences`-style list on Application spec
  (must survive restarts, so spec, not memory).
- JSON patch / selective per-resource sync → transient RPC actions; nothing to persist
  beyond the audit trail.
- **Each new verb must be added to `auditVerbs` (`audit_middleware.go:18–26`)** or it
  will silently bypass auditing — `classifyAudit` returns `mutating=false` for any
  unrecognized prefix (L100–101) and `NewAuditInterceptor` short-circuits at L44–46.
  Add matching `fleet.Capability` constants (`filter.go:17–21`).

### Explicitly rejected options

- **External SQL/TSDB (Postgres, ClickHouse, SQLite).** Rejected. Zero precedent
  (§0), no chart support (§7 — no PVC anywhere), outside the Velero backup boundary,
  and it makes Paprika no longer installable as "just a chart". The `lib/pq`/`sqlx`
  entries in `go.mod` are Helm's, not an opening.
- **Redis as the history store (e.g. Redis Streams).** Rejected. `save ""` disables
  persistence, `maxmemory-policy allkeys-lru` permits eviction of anything, `/data` is
  an `emptyDir`, `replicas: 1`, and `redis.enabled: false` by default (§2). Data would
  be lost on any pod restart and the feature would be silently unavailable for the
  majority of installs that never enable Redis.
- **In-memory ring buffer in the API server.** Rejected as the *only* store: the API
  server is multi-replica (`NewPaprikaServerWithRedis`, `server.go:130` exists precisely
  because there are multiple replicas), so each replica would hold a different, partial
  feed and answers would flap between refreshes. `PaprikaServer` (`server.go:95–110`)
  holds no mutable history state today, and it should stay that way.
  *Acceptable only* as a short-TTL read-through cache in front of (C).
- **Growing `PromotionHistory`-style unbounded arrays in status.** Rejected — it is an
  existing latent bug, not a pattern to extend (§6a).

### Suggested sequencing
1. `SourceEvent` CRD + webhook receiver writes it (`handler.go:228–233`) → unblocks
   gaps #4 and #7 with the smallest possible change and immediately proves the
   CRD-as-history pattern end to end.
2. Extend `ResourceSync` + add the lifecycle phase vector → gaps #9, #10 (status-only,
   no new CRD, low risk).
3. `ClusterStatus` capacity fields + `fleet.ClusterSummary` widening + proto `Cluster`
   message → gap #1.
4. `RolloutRecord` + `PipelineRun` CRDs with count+TTL pruning → gaps #5, #6.
5. Ownership on `AppProject` → gap #8.
6. `OptionalSourceProjector` implementation + Prometheus/cost client → gaps #2, #3
   (largest, most greenfield; do last).
7. Mutations + new `auditVerbs` + new `fleet.Capability` values → gap #11.

**Also fix while in here:** cap `ReleaseStatus.PromotionHistory`
(`release_types.go:105`, appended at `release_controller.go:454`). It is unbounded today
and will be the first thing to break under the increased write volume this redesign brings.

---

## 9. Quick file index

| Path | Role |
|---|---|
| `internal/cache/interfaces.go` | Cache role interfaces; TTL-mandatory `Setter` (L16); key helpers (L62–85) |
| `internal/cache/factory.go` | `Config` (L20), `New` (L70), env var names (L32–35) |
| `internal/cache/redis.go` | Redis KV impl; `DeleteByPrefix` = SCAN+DEL (L72) |
| `internal/cache/memory.go` | Process-local map impl (L14) |
| `internal/cache/invalidator.go` | Prefix invalidation (L21) |
| `internal/audit/audit.go` | Entire audit package: `Event` (L20), `Record`→stdout (L62), `NoopAuditor` (L81) |
| `internal/api/audit_middleware.go` | `auditVerbs` (L18), interceptor (L36), `classifyAudit` (L91) |
| `internal/api/events/broker.go` | Redis pub/sub fan-out, no replay (L62, L125) |
| `internal/api/events/eventtypes.go` | `EventPayload` (L5), `AuditPayload` (L19) |
| `internal/api/server.go` | `PaprikaServer` fields (L95–110); `WithFleetIndex` (L60); Release→proto (L1349) |
| `internal/governance/*.go` | Read-only (`client.Reader`); no writes |
| `internal/fleet/reader.go` | `Reader` interface (L14) |
| `internal/fleet/snapshot.go` | `Snapshot` (L12), `Index` atomic pointers (L38) |
| `internal/fleet/model.go` | `ApplicationSummary` (L145), `ClusterSummary` (L188), `ConnectionState` (L120) |
| `internal/fleet/filter.go` | `Capability` (L14), `CapabilitySet` (L25) |
| `internal/fleet/optional_source.go` | ⭐ reserved observability seam (L14–32) |
| `internal/fleet/store.go` / `store_cache.go` | `ProjectionStore` contract / cache adapter |
| `internal/webhook/receiver/handler.go` | Git webhooks; discards payload, stamps annotation (L231) |
| `api/pipelines/v1alpha1/release_types.go` | `PromotionEntry` (L55), `PromotionHistory` **uncapped** (L105) |
| `api/pipelines/v1alpha1/application_types.go` | `ResourceSync` (L526), `ResourceHealth` (L535), `ApplicationStatus` (L557) |
| `api/clusters/v1alpha1/cluster_types.go` | `ClusterSpec` (L67), `ClusterStatus` (L91), `AgentInfo` (L60) |
| `internal/controller/pipelines/application_controller.go` | `maxReleaseHistory=10` (L48); prune paths (L1746, L2090–2199) |
| `charts/chart/templates/extras/redis-config.yaml` | `save ""`, `allkeys-lru` |
| `charts/chart/templates/extras/redis-deployment.yaml` | `emptyDir` for `/data` (L116) |
| `charts/chart/templates/extras/velero.yaml` | Only DR mechanism |
| `charts/chart/values.yaml` | `redis` (L952), `audit` (~L962), `velero` (L969) |

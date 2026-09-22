# Backend design — console redesign

Scope: everything the control plane must grow so the redesigned console is powered by real data.
Derived from the nine `be-*.md` reader notes and `00-gap-analysis.md` §3/§6.

Repo root: `/Users/benebsworth/projects/paprika`.

Governing principle, stated once and enforced throughout:

> **A number the control plane cannot observe is never sent as a scalar. Absence is a state, not a
> zero.** Every derived, collected or externally-sourced value travels with an explicit
> `DataState`, and the console is contractually required to hide or grey the surface rather than
> render `0`, `—` or an interpolated figure.

---

## 1. FEASIBILITY VERDICT PER GAP

| # | Gap | Verdict | What it costs |
|---|---|---|---|
| 1 | Cluster infrastructure | **BUILDABLE-WITH-COLLECTION** (≈60% BUILDABLE-NOW) | list/identity/version/phase/labels/app-count already exist; node & pod counts and real region need new collection |
| 2 | Capacity / metrics | **SPLIT: BUILDABLE-WITH-COLLECTION + NEEDS-EXTERNAL** | allocatable/requested from the K8s API; *used* needs metrics-server; per-app RED signals need Prometheus |
| 3 | Cost | **NEEDS-EXTERNAL** (with a BUILDABLE-WITH-COLLECTION estimate tier) | rate-card × requested is computable locally and must be labelled an estimate; real spend needs a billing provider |
| 4 | Source-trigger / webhook feed | **BUILDABLE-WITH-COLLECTION** | widen 2 payload structs + a new `SourceEvent` CRD + a pruner |
| 5 | Rollout history | **BUILDABLE-WITH-COLLECTION** | new `RolloutRecord` CRD written at terminal transition |
| 6 | Pipeline run history | **BUILDABLE-WITH-COLLECTION** (CPU-minutes partly NEEDS-EXTERNAL) | new `PipelineRun` CRD, a run counter, a `PipelineStep.Resources` field, a test-report convention |
| 7 | Commit metadata | **BUILDABLE-WITH-COLLECTION** | one `CommitObject()` call + 3 struct widenings; run number comes from gap 6 |
| 8 | Ownership metadata | **BUILDABLE-WITH-COLLECTION** — cheapest item in the list | spec fields on `AppProject` + Application annotation override |
| 9 | Per-resource drift detail | **BUILDABLE-WITH-COLLECTION** | the data is already computed then discarded in `internal/engine/diff.go`; persist it |
| 10 | 6-phase lifecycle vector | **BUILDABLE-NOW** (derivation only) | pure function of CRDs the Application controller already holds |
| 11 | New mutations | **BUILDABLE-NOW** for 3 of 4; selective sync is BUILDABLE-WITH-COLLECTION | each needs controller support, not just an RPC |

### 1.1 Gap 1 — Cluster infrastructure

**BUILDABLE-NOW, no new collection:** namespace/name, `spec.displayName`, `spec.mode`, `spec.server`,
`spec.serviceAccount`, `spec.labels`, `spec.disabled`, health-check interval/timeout,
`metadata.creationTimestamp`, `status.phase`, `status.conditions`, `status.observedGeneration`,
`status.lastHealthCheckTime` (a genuine last-seen), `status.version` (k8s GitVersion),
connection state (`fleet.projectClusterSummary` mapping), and `application_count` /
`target_count` from `Snapshot.ByCluster` + `Targets`.
All of this lives on `api/clusters/v1alpha1/cluster_types.go` and the Cluster informer is **already
warmed on the API server** (`cmd/main.go:961`). Nothing new is needed to ship a cluster list.

**BUILDABLE-WITH-COLLECTION:** `node_count`, `ready_node_count`, `pod_count`, `running_pod_count`,
`namespace_count`, `regions`, `zones`. Collection point is
`internal/controller/clusters/cluster_controller.go:144 checkHealth`, which **already builds a
`kubernetes.Clientset` against the target cluster every 30s** and throws everything but
`ServerVersion()` away. Add `Nodes().List` (gives count + `topology.kubernetes.io/region|zone` +
`Status.Allocatable` + `NodeInfo.KubeletVersion`) and a paged `Pods().List` with
`resourceVersion=0`. Persist into additive `ClusterStatus` fields.

**Two live bugs this work must fix, not paper over:**
- `cluster_controller.go:79-81` hard-returns `Pending/AwaitingAgent` for agent mode, so agent
  clusters are permanently Pending and never report a version. `agentclient.Health()` exists and has
  **zero production callers**. Wire it, and add `spec.agentAddress` (documented at
  `docs/guides/multi-cluster.md:50` but absent from `ClusterSpec`).
- `status.agentInfo` has **zero writers repo-wide**. It is a schema stub. Either populate it or the
  proto must report `DATA_STATE_NOT_CONFIGURED` for it — never render it as connected.

**New RBAC requirement, on the *remote* credential, not the hub:** the repo has zero node access
today (`rg 'Nodes()'` → nothing). Listing nodes and pods needs `nodes: get;list` and
`pods: list` on the kubeconfig SA / agent SA. A `Forbidden` MUST degrade to
`DATA_STATE_NOT_AVAILABLE` with a reason, never to zero.

### 1.2 Gap 2 — Capacity / metrics

Three genuinely different problems; do not conflate them.

**(a) Cluster CPU/memory *allocatable* and *capacity* — BUILDABLE-WITH-COLLECTION.**
Sum `node.Status.Allocatable["cpu"|"memory"]` and `.Capacity` in the same `Nodes().List` as gap 1.

**(b) Cluster CPU/memory *requested* — BUILDABLE-WITH-COLLECTION.**
Sum container `Resources.Requests` over non-terminal pods, plus `max(initContainer requests)` per
the scheduler formula. Same pod list as gap 1. Cost note: a full pod list on a large cluster is
expensive — it belongs in the 30s cluster reconcile with paging, **never in an API request path**.

**(c) Cluster CPU/memory *used* — NEEDS-EXTERNAL (`metrics.k8s.io` / metrics-server).**
`k8s.io/metrics` is in neither `go.mod` nor `go.sum`. metrics-server is not guaranteed installed —
the repo's own dev cluster logs show `the server could not find the requested resource
(get pods.metrics.k8s.io)`. Sane default: `used_state = DATA_STATE_NOT_AVAILABLE`,
`unavailable_reason = "metrics.k8s.io is not served by this cluster"`, `used = 0` and the console
renders the meter with the requested/allocatable segments only and a hatched unknown band.

**(d) Per-application request rate / latency / error rate — NEEDS-EXTERNAL (Prometheus).**
Paprika has **zero ability to read metrics from anywhere** — no Prometheus HTTP API client, no
PromQL parser, no metrics API client. `internal/analysis` is worse than nothing here:
`latencyP99` is a hardcoded stub that returns `Passed: true, "no metrics server available, assuming
pass"` (`analysis.go:163-168`), and `errorRate` is a pod-exit-code ratio against a hardcoded
`app.kubernetes.io/name=demo-app` selector. **That stub is a bug to fix, not a pattern to copy.**

The route is Chunk 1 of the already-written, 0/131-complete plan
`docs/superpowers/plans/2026-07-11-observability-sources-golden-signals.md`: an
`ObservabilitySource` CRD, `internal/metricprovider` contracts, a Prometheus adapter with
server-side AST matcher injection (the browser never submits PromQL), endpoint/IP allowlist +
DNS-rebinding-safe dialer, credential loading, a health controller, caches and limits.
Sane default when unconfigured: `DATA_STATE_NOT_CONFIGURED` and a "connect an observability source"
affordance. **Do not source cluster inventory or capacity from Prometheus** — the enterprise design
explicitly requires a Prometheus outage not to block fleet inventory.

The seam is pre-built and correct: `fleet.WeightReader` / `TargetWeightKey` (`internal/fleet/map.go:34-54`),
consumed by `Snapshot.QueryMap`/`QueryMatrix`, with `request_rate_weight` / `used_resource_fallback`
already on the wire, and `Index.QueryMap` passing `nil` today (`reader.go:104`, `:124`). Implementing
it is the only change needed to make `FLEET_SIZE_METRIC_REQUEST_RATE` stop silently falling back.

### 1.3 Gap 3 — Cost

**NEEDS-EXTERNAL.** There is no source of truth for cost anywhere in the repo — `grep -ci cost` over
the generated TS is 0 and the Go tree has nothing.

Two tiers, and the wire must distinguish them:
- **Estimate tier — BUILDABLE-WITH-COLLECTION once gap 2(a)/(b) lands.** A `CostSource` CRD carrying
  a rate card (`$/vCPU-hour`, `$/GiB-hour`, optional per-node-class overrides). Cost =
  rate × requested (per app, attributing pod requests to the owning Application via the existing
  `app.paprika.io/name` label) or rate × allocatable (per cluster). This is an **estimate** and must
  be labelled `COST_BASIS_RATE_CARD_REQUESTED` / `_ALLOCATABLE` so the console renders "est.".
- **Actual tier — NEEDS-EXTERNAL.** A billing provider (cloud billing export, OpenCost/Kubecost).
  `COST_BASIS_BILLING`.

Sane default with nothing configured: `QueryCostResponse.state = DATA_STATE_NOT_CONFIGURED`, empty
result set. One check hides every cost surface in the console: the COST/MO column, the cluster
`$14.2k /mo` chip, the heat tooltip, the cost drilldown.

### 1.4 Gap 4 — Source-trigger / webhook event feed

**BUILDABLE-WITH-COLLECTION.** Today a push is *destroyed*: the receiver decodes exactly two fields
per provider (`internal/webhook/receiver/handler.go:350-364` — `ref` + `clone_url` /
`git_http_url`), invalidates the cache with a hardcoded `sourceType = "git"` and an empty revision,
stamps `paprika.io/sync` on matching objects and returns 202. `head_commit`, `pusher`, `sender`,
`after`, `commits[]`, `checkout_sha`, `user_name` are all parsed away. `grep` for
`LastTriggered|WebhookEvent|SourceEvent` → 0 hits repo-wide.

Work: widen the two payload structs (cheap, high value — it also lets `triggerReconciliation` pass a
real revision to `Invalidate` instead of `""`), and persist a `SourceEvent` CR per accepted delivery.
Also emit `SOURCE_EVENT_KIND_POLL_DETECTED` from `application_controller.go:1354 checkSourceChanged`
so polled (non-webhook) sources appear in the same feed, and `_MANUAL_SYNC` from `SyncApplication`.

Explicitly **not** viable as the store: `events.Broker` is Redis pub/sub with zero retention that
**drops on a full subscriber buffer** (`broker.go:182`); `internal/audit` writes JSON to stdout and
is unreadable from inside Paprika; k8s Events expire on the cluster's 1h TTL; `/events` SSE is
deliberately `http.NotFoundHandler()` everywhere.

Also fix while here: `annotateMatchingApplications` does a **cluster-wide unindexed `List` per push**
(`handler.go:217`). That will not survive the fleet sizes this console implies. Add a field index.

### 1.5 Gap 5 — Rollout history

**BUILDABLE-WITH-COLLECTION.** There is categorically no history: `RolloutStatus` is all scalars,
overwritten each reconcile; `Cleanup` is a no-op in all five strategies; there is no rollout-duration
histogram (only `PipelineDuration` and `ReleaseDuration` exist), so even a median cannot be derived
from existing telemetry.

The nearest existing thing is not usable: `Release` CRs are content-addressed per (revision, stage),
capped at `maxReleaseHistory = 10`, and `requestReleaseResync` (`application_controller.go:1960`)
**re-runs terminal Releases in place, destroying the previous outcome**. Rollout children are
owner-ref'd to their Release and die with it.

Work: a `RolloutRecord` CR written on the terminal transition in
`rollout_controller.go:888 updateStatusFromResult` (which already has the phase transition in hand)
and on release-driven promotions in the release controller. Fields must be **captured at write
time** — `startedAt`, `finishedAt`, `duration`, outcome, reason, final weight, steps completed,
revision, triggering principal — none are derivable later. Medians are computed server-side over the
retained window and reported with an explicit `sample_size` and `window_start_unix_ms`.

### 1.6 Gap 6 — Pipeline run history

**BUILDABLE-WITH-COLLECTION, with one NEEDS-EXTERNAL sub-item.**

- **Run history + run number:** there is no `PipelineRun` CRD; `PipelineStatus` holds the latest run
  only, and `LastExecutionID = "run-" + name` (`pipeline_controller.go:191`) is a **constant string,
  not a counter**. Needs a `PipelineRun` CRD plus a monotonic counter on `PipelineStatus`.
- **Per-step durations:** exist for the current run only (`StepStatus.StartedAt/CompletedAt`) and
  `retryStep` reuses the original `StartedAt`, collapsing attempts. Snapshot them into the record;
  record `attempts` separately.
- **Per-step resource requests:** `CreateStepJob` (`internal/engine/workflow.go:372`) sets **no**
  `corev1.ResourceRequirements` and `PipelineStep` has no field for one. New CRD field + plumbing.
- **CPU-minutes:** once requests exist, `requests × wall duration` is computable — but that is
  *allocation*, not usage. Ship it as `COMPUTE_BASIS_REQUESTED` and say so. Measured CPU-minutes is
  NEEDS-EXTERNAL (metrics-server / Prometheus).
- **Test counts:** nothing parses step output; `GetStepLogs` returns raw concatenated pod logs.
  Needs a convention: a `PipelineSpec.TestReport{Path, Format}` (junit/json) the workflow engine
  collects from the step's Job. Absent that declaration → `DATA_STATE_NOT_CONFIGURED`.
- **Cache-hit rate:** pipeline steps have no cache concept at all. The only real cache is the
  manifest render cache (`internal/engine/cached_renderer.go`), which emits no hit/miss counter.
  Add counters and report it scoped as `manifest-render`; report pipeline-step caching as
  `DATA_STATE_NOT_AVAILABLE`. **Do not relabel render-cache hits as pipeline cache hits.**

### 1.7 Gap 7 — Commit metadata

**BUILDABLE-WITH-COLLECTION, and the cheapest high-value item after ownership.**
`go-git/plumbing/object` is never imported repo-wide. `resolveAndCheckout`
(`internal/source/git.go:228`) already holds an open `*git.Repository` and the resolved
`*plumbing.Hash` — one `CommitObject(*hash)` call yields author, email, message and commit time.
Then widen `source.ResolveResult` (today exactly 3 fields: `LocalPath`, `Hash`, `Revision`) and
thread it through the three lockstep sites: `proto/paprika/v1/api.proto:503-507`
`ResolveSourceResponse`, `internal/reposerver/server.go:82-86`,
`internal/reposerverclient/client.go:149-153`.

Adjacent free wins in the same change: OCI discards `result.Chart.Digest` / `Manifest.Digest`
(the natural immutable revision); S3 discards `LastModified` / `VersionId`;
`Repository.status.connectionState.Revision` and `.ResponseTime` are declared and **never written**.
Run number comes from gap 6. Actor for API-initiated changes comes from the auth principal
(note `ApproveGate` currently hardcodes `ApprovedBy = "api"` — fix it).

Known holes to represent honestly: Kustomize sources resolve with **empty Hash *and* Revision**
(`helm_sdk_renderer.go:87-92`), and helm-repo sources get `sha256(Path+Repo+Name)` with an empty
revision, so a chart republish is invisible. Both must report
`CommitInfo.state = DATA_STATE_NOT_AVAILABLE`.

### 1.8 Gap 8 — Ownership metadata

**BUILDABLE-WITH-COLLECTION, no external system, smallest change in the plan.** Nothing exists
today; `Application.parameters` is a free map nothing populates.

Ownership is *configuration*, so it belongs in **spec**, not status: `AppProject.spec.ownership`
(owner, on-call, tier, escalation URL, drilldown link templates) with per-Application annotation
override. It inherits AppProject's existing governance and RBAC for free. Drilldown URLs are
templates resolved server-side (`{{application}}`, `{{namespace}}`, `{{cluster}}`, `{{stage}}`) and
**must be validated http(s) and rendered server-side**, so the console never builds a URL from
untrusted config.

### 1.9 Gap 9 — Per-resource drift detail

**BUILDABLE-WITH-COLLECTION — the data already exists in memory and is deliberately thrown away.**
`internal/engine/diff.go:314 specContainsAt` walks to the exact differing path and then **returns
only a bool**. Threading a bounded `[]string` of JSON pointers out of it is a localized change.
`ResourceDiff` (`diff.go:31`) is then flattened to `ResourceSync{Kind,Name,Namespace,Status}` — the
only per-resource drift signal on the wire today.

Work: widen `ResourceSync` (status, bounded by resource count so it is safe) with
`ChangedFieldCount`, `ChangedFields []string` (cap 20), `DriftedAt`, `Reason`. Drift *reason* is a
small enum, not prose — **do not promise the design's English sentences** ("maxReplicas drifted
12 → 20"); those are semantic interpretations the API does not have. "Last written by
`kubectl-client-side-apply` 12 minutes ago" is genuinely available from `metadata.managedFields` in
the live manifest and should be surfaced as `last_applied_by` / `last_applied_at_unix_ms`.

### 1.10 Gap 10 — 6-phase lifecycle vector

**BUILDABLE-NOW.** Every input already exists on objects the Application controller holds:
`Status.Phase`, `Status.Stages`, `Status.Gates`, `Status.HealthChecks`, `Status.AnalysisResults`,
`Status.HookStatuses`, `Status.PipelineRef`, plus Release and Rollout phases. Today
`mapApplicationHealth` (`projection.go:168`) collapses all of it into one `Health` and **discards
the phase**.

Design decision: **the Application controller computes the vector into
`ApplicationStatus.LifecyclePhases` (exactly 6 fixed entries) and the fleet projector copies it.**
Rationale: the controller already has the Pipeline in hand, so this avoids adding Pipeline as an
eighth kind to `ProjectionStore`'s deliberately frozen seven-CRD contract, avoids a new informer,
and keeps the CR as the system of record per AGENTS.md. Delta invalidation is already correct.

`LIFECYCLE_PHASE_STATE_NOT_APPLICABLE` (this app has no build/test stage) must be distinguishable
from `_UNKNOWN` (applicable, no data) — that distinction is what stops the console drawing an empty
cell that looks like a failure.

### 1.11 Gap 11 — Mutations

| Mutation | Verdict | Substrate |
|---|---|---|
| Hold / Resume rollout | **BUILDABLE-NOW** | annotation + `status.hold` latch, **not** `spec.paused` |
| Ignore drifted field | **BUILDABLE-NOW** | extend `IgnoreDiff` with group/kind/name/namespace scoping |
| Apply JSON patch | **BUILDABLE-NOW**, but it is break-glass | `dynamicClient.Patch`; dry-run by default |
| Selective per-resource sync | **BUILDABLE-WITH-COLLECTION** | needs scoped-apply support in the release controller |

**Hold must not use `spec.paused`.** `release_controller.go:587` does `ro.Spec = expected.Spec` on
every reconcile of a rollout-managed Release, so anything the API writes to a release-managed
`Rollout.spec` — including `spec.paused` — is silently reverted. Use the `latchAbort` pattern
(`rollout_controller.go:252`): an annotation latched into durable status. The reconcile
short-circuit at `rollout_controller.go:164` is the right behaviour to reuse — it returns before
both `strategy.Sync` and `configureTraffic`, so the mesh weight freezes exactly where it is.

**Ignore is currently Application-global.** `IgnoreDiff{JSONPointers []string}`
(`application_types.go:145`) has no group/kind/name scoping, unlike Argo. A per-resource "ignore this
field" needs the scoping fields plus matching logic in `ApplyIgnoreDifferences`
(`diff_ignore.go:14`).

**`ApplyResourcePatch` writes to the cluster outside GitOps and by definition creates drift.** It
must: default to dry-run (`confirm` must be explicitly true), require an admin-tier capability,
return an explicit `warning` string stating the change will be reverted on the next sync, and be
audited. It is the one mutation an operator may reasonably want disabled entirely.

**Selective sync** cannot be faked. `SyncApplication` sets `paprika.io/sync` and syncs the whole
application; accepting a resource selection and then syncing everything would be dishonest. The
release controller needs to honour a bounded resource selector.

---

## 2. PROTO EXTENSION DESIGN

House rules obeyed throughout (from `be-proto-conventions.md`): no imports; 2-space indent;
enum values prefixed with the SCREAMING_SNAKE enum name with `_UNSPECIFIED = 0`; `optional` only for
genuine presence; time as `int64 *_unix_ms`; `uint32` per-object counts / `uint64` aggregates;
`double` for rates and ratios; fleet-style pagination (`uint32 page_size` + `string cursor` /
`string next_cursor`); `FleetObjectKey` reused for every namespaced identity; **all new RPCs
appended after `GetSystemStatus`**; **no field added to any of the 120 hash-locked messages.**

Locked messages are *referenced* freely (`Condition`, `Rollout`, `ArtifactRef` appear as field types
in new messages) — referencing does not change a message's own `DescriptorProto`, so no hash churn.

### 2.0 The honesty primitives — new, shared by everything below

```proto
enum DataState {
  DATA_STATE_UNSPECIFIED = 0;
  DATA_STATE_OK = 1;
  DATA_STATE_NOT_CONFIGURED = 2;
  DATA_STATE_NOT_AVAILABLE = 3;
  DATA_STATE_STALE = 4;
  DATA_STATE_ERROR = 5;
  DATA_STATE_FORBIDDEN = 6;
}

enum DataClass {
  DATA_CLASS_UNSPECIFIED = 0;
  DATA_CLASS_CLUSTER_INVENTORY = 1;
  DATA_CLASS_CLUSTER_CAPACITY = 2;
  DATA_CLASS_APPLICATION_SIGNALS = 3;
  DATA_CLASS_COST = 4;
  DATA_CLASS_SOURCE_EVENTS = 5;
  DATA_CLASS_ROLLOUT_HISTORY = 6;
  DATA_CLASS_PIPELINE_RUNS = 7;
  DATA_CLASS_COMMIT_METADATA = 8;
  DATA_CLASS_OWNERSHIP = 9;
  DATA_CLASS_DRIFT_DETAIL = 10;
  DATA_CLASS_LIFECYCLE = 11;
}

message DataSourceStatus {
  DataClass data_class = 1;
  DataState state = 2;
  string provider = 3;
  int64 observed_at_unix_ms = 4;
  // Age beyond which the server reports DATA_STATE_STALE.
  int64 staleness_budget_ms = 5;
  string unavailable_reason = 6;
  uint32 retention_limit = 7;
  int64 retention_window_ms = 8;
}

message GetDataSourcesRequest {
  optional string namespace = 1;
}

message GetDataSourcesResponse {
  // Always one entry per DataClass, in enum order, regardless of configuration.
  repeated DataSourceStatus sources = 1;
  uint64 index_generation = 2;
}

enum ResourceUnit {
  RESOURCE_UNIT_UNSPECIFIED = 0;
  RESOURCE_UNIT_MILLICORES = 1;
  RESOURCE_UNIT_BYTES = 2;
}

message ResourceMeter {
  ResourceUnit unit = 1;
  DataState used_state = 2;
  double used = 3;
  DataState requested_state = 4;
  double requested = 5;
  DataState allocatable_state = 6;
  double allocatable = 7;
  double capacity = 8;
  int64 observed_at_unix_ms = 9;
  string unavailable_reason = 10;
}
```

`ResourceMeter` carries a **per-component** state precisely because requested/allocatable come from
the Kubernetes API (normally `OK`) while `used` needs metrics-server (frequently `NOT_AVAILABLE`).
That asymmetry is the whole point of the message.

### 2.1 Cluster + ListClusters / GetCluster (gap 1, part of 2, part of 3)

```proto
enum ClusterMode {
  CLUSTER_MODE_UNSPECIFIED = 0;
  CLUSTER_MODE_IN_CLUSTER = 1;
  CLUSTER_MODE_DIRECT = 2;
  CLUSTER_MODE_AGENT = 3;
}

enum ClusterPhase {
  CLUSTER_PHASE_UNSPECIFIED = 0;
  CLUSTER_PHASE_PENDING = 1;
  CLUSTER_PHASE_HEALTHY = 2;
  CLUSTER_PHASE_UNHEALTHY = 3;
  CLUSTER_PHASE_DISABLED = 4;
}

message ClusterInventory {
  DataState state = 1;
  uint32 node_count = 2;
  uint32 ready_node_count = 3;
  uint32 pod_count = 4;
  uint32 running_pod_count = 5;
  uint32 namespace_count = 6;
  // Distinct topology.kubernetes.io/region values observed on nodes. Empty when unknown.
  repeated string regions = 7;
  repeated string zones = 8;
  // Distinct kubelet versions; more than one entry means version skew.
  repeated string kubelet_versions = 9;
  int64 observed_at_unix_ms = 10;
  string unavailable_reason = 11;
}

message ClusterCapacity {
  ResourceMeter cpu = 1;
  ResourceMeter memory = 2;
  // e.g. "metrics-server". Empty when no usage source is present.
  string usage_provider = 3;
}

message ClusterAgentInfo {
  // NOT_CONFIGURED unless mode == CLUSTER_MODE_AGENT.
  DataState state = 1;
  string address = 2;
  string version = 3;
  int64 last_seen_unix_ms = 4;
  bool connected = 5;
}

message Cluster {
  FleetObjectKey identity = 1;
  string display_name = 2;
  ClusterMode mode = 3;
  string server = 4;
  string service_account = 5;
  map<string, string> labels = 6;
  bool disabled = 7;
  ClusterPhase phase = 8;
  FleetConnectionState connection = 9;
  // Empty when never observed. Always empty for agent-mode clusters today.
  string kubernetes_version = 10;
  int64 last_health_check_unix_ms = 11;
  int64 created_at_unix_ms = 12;
  int64 observed_generation = 13;
  repeated Condition conditions = 14;
  uint64 application_count = 15;
  uint64 target_count = 16;
  ClusterInventory inventory = 17;
  ClusterCapacity capacity = 18;
  CostSummary cost = 19;
  ClusterAgentInfo agent = 20;
  string health_check_interval = 21;
  string health_check_timeout = 22;
}

message ListClustersRequest {
  optional string namespace = 1;
  uint32 page_size = 2;
  string cursor = 3;
  bool include_capacity = 4;
  // Include clusters with zero authorized applications. Requires admin.
  bool include_unreferenced = 5;
}

message ListClustersResponse {
  repeated Cluster clusters = 1;
  uint64 total = 2;
  string next_cursor = 3;
  uint64 index_generation = 4;
}

message GetClusterRequest {
  string namespace = 1;
  string name = 2;
}

message GetClusterResponse {
  Cluster cluster = 1;
  uint64 index_generation = 2;
}
```

Absence semantics: `kubernetes_version == ""` means never observed (unambiguous — a version is never
legitimately empty). `inventory.state` / `capacity.*_state` / `cost.state` / `agent.state` carry the
`DataState`. `application_count` is always real (it comes from the snapshot).

### 2.2 Capacity / metrics surface (gap 2)

Cluster capacity rides on `Cluster.capacity` above. Per-application golden signals get their own
batched RPC — deliberately **not** fields on `ApplicationSummary`, so that a Prometheus outage can
never degrade or slow the main fleet list.

```proto
enum SignalKind {
  SIGNAL_KIND_UNSPECIFIED = 0;
  SIGNAL_KIND_REQUEST_RATE = 1;
  SIGNAL_KIND_ERROR_RATE = 2;
  SIGNAL_KIND_LATENCY = 3;
  SIGNAL_KIND_SATURATION = 4;
}

enum SignalUnit {
  SIGNAL_UNIT_UNSPECIFIED = 0;
  SIGNAL_UNIT_REQUESTS_PER_SECOND = 1;
  SIGNAL_UNIT_RATIO = 2;
  SIGNAL_UNIT_MILLISECONDS = 3;
  SIGNAL_UNIT_PERCENT = 4;
}

message SignalValue {
  SignalKind kind = 1;
  DataState state = 2;
  double value = 3;
  SignalUnit unit = 4;
  // 0 when the signal is not a quantile; 0.99 for p99.
  double quantile = 5;
  int64 observed_at_unix_ms = 6;
  int64 window_seconds = 7;
  string unavailable_reason = 8;
}

message ApplicationSignals {
  FleetObjectKey application = 1;
  string stage = 2;
  FleetObjectKey cluster = 3;
  DataState state = 4;
  // The effective observability source. Empty when none is bound.
  FleetObjectKey source = 5;
  // One entry per requested SignalKind, even when unavailable.
  repeated SignalValue signals = 6;
}

message QueryApplicationSignalsRequest {
  // Bounded batch of at most 100 identities; matches one console page.
  repeated FleetObjectKey applications = 1;
  string stage = 2;
  repeated SignalKind signals = 3;
  int64 window_seconds = 4;
}

message QueryApplicationSignalsResponse {
  // NOT_CONFIGURED when no observability source exists anywhere in scope.
  DataState state = 1;
  repeated ApplicationSignals applications = 2;
  uint64 index_generation = 3;
}
```

The request carries **no source identity and no PromQL** — operators configure expressions on the
CRD, the server compiles and injects matchers. Per-signal partial failure is required: one failing
signal must not discard the other three.

### 2.3 Cost (gap 3)

```proto
enum CostBasis {
  COST_BASIS_UNSPECIFIED = 0;
  // Estimate: rate card x requested resources.
  COST_BASIS_RATE_CARD_REQUESTED = 1;
  // Estimate: rate card x node allocatable.
  COST_BASIS_RATE_CARD_ALLOCATABLE = 2;
  // Actual spend from a billing provider.
  COST_BASIS_BILLING = 3;
}

message CostSummary {
  DataState state = 1;
  CostBasis basis = 2;
  double monthly_amount = 3;
  // ISO 4217. Empty when state != DATA_STATE_OK.
  string currency = 4;
  int64 observed_at_unix_ms = 5;
  string provider = 6;
  string unavailable_reason = 7;
}

message ApplicationCost {
  FleetObjectKey application = 1;
  CostSummary cost = 2;
}

message ClusterCost {
  FleetObjectKey cluster = 1;
  CostSummary cost = 2;
}

message QueryCostRequest {
  FleetFilter filter = 1;
  repeated FleetObjectKey applications = 2;
  repeated FleetObjectKey clusters = 3;
  uint32 page_size = 4;
  string cursor = 5;
}

message QueryCostResponse {
  // NOT_CONFIGURED when no cost source exists. One check hides every cost surface.
  DataState state = 1;
  repeated ApplicationCost applications = 2;
  repeated ClusterCost clusters = 3;
  CostSummary total = 4;
  string next_cursor = 5;
  uint64 index_generation = 6;
}
```

`basis` is load-bearing: the console MUST render an "est." affix for `RATE_CARD_*` and MUST NOT
present an estimate as billed spend.

### 2.4 Commit metadata (gap 7)

```proto
message CommitInfo {
  DataState state = 1;
  // Full SHA, OCI digest, or S3 ETag depending on source type.
  string revision = 2;
  string short_revision = 3;
  string author_name = 4;
  string author_email = 5;
  // First line only, clamped to 200 bytes by the server.
  string message = 6;
  int64 committed_at_unix_ms = 7;
  // Provider commit URL. Empty when the provider is unknown.
  string url = 8;
}

message GetRevisionInfoRequest {
  string namespace = 1;
  string application = 2;
  // Empty means the application's current revision.
  string revision = 3;
}

message GetRevisionInfoResponse {
  CommitInfo commit = 1;
  FleetObjectKey repository = 2;
  string repository_url = 3;
  uint64 run_number = 4;
  DataState run_number_state = 5;
}
```

Kustomize and helm-repo sources report `state = DATA_STATE_NOT_AVAILABLE` because they genuinely
have no revision identity today.

### 2.5 Source-event feed (gap 4)

```proto
enum SourceEventKind {
  SOURCE_EVENT_KIND_UNSPECIFIED = 0;
  SOURCE_EVENT_KIND_GIT_PUSH = 1;
  SOURCE_EVENT_KIND_GIT_TAG = 2;
  SOURCE_EVENT_KIND_OCI_PUSH = 3;
  SOURCE_EVENT_KIND_S3_OBJECT = 4;
  SOURCE_EVENT_KIND_POLL_DETECTED = 5;
  SOURCE_EVENT_KIND_MANUAL_SYNC = 6;
}

enum SourceEventOutcome {
  SOURCE_EVENT_OUTCOME_UNSPECIFIED = 0;
  SOURCE_EVENT_OUTCOME_ACCEPTED = 1;
  SOURCE_EVENT_OUTCOME_NO_MATCH = 2;
  SOURCE_EVENT_OUTCOME_REJECTED = 3;
  SOURCE_EVENT_OUTCOME_FAILED = 4;
}

message SourceEvent {
  FleetObjectKey identity = 1;
  SourceEventKind kind = 2;
  FleetSourceType source_type = 3;
  string repository_url = 4;
  FleetObjectKey repository = 5;
  // Branch, tag, object key, or OCI tag.
  string reference = 6;
  CommitInfo commit = 7;
  // github | gitlab | s3 | oci | poll | api
  string provider = 8;
  string delivery_id = 9;
  int64 received_at_unix_ms = 10;
  SourceEventOutcome outcome = 11;
  // Bounded to 50; the count is authoritative.
  repeated FleetObjectKey triggered_applications = 12;
  uint32 triggered_application_count = 13;
  bool triggered_applications_truncated = 14;
  string message = 15;
}

message ListSourceEventsRequest {
  optional string namespace = 1;
  repeated FleetObjectKey applications = 2;
  repeated SourceEventKind kinds = 3;
  int64 since_unix_ms = 4;
  uint32 page_size = 5;
  string cursor = 6;
}

message ListSourceEventsResponse {
  DataState state = 1;
  repeated SourceEvent events = 2;
  string next_cursor = 3;
  // Oldest event still retained. The feed is a recent window, never an archive.
  int64 retention_horizon_unix_ms = 4;
  uint32 retention_limit = 5;
}
```

### 2.6 Rollout history (gap 5)

```proto
enum RolloutOutcome {
  ROLLOUT_OUTCOME_UNSPECIFIED = 0;
  ROLLOUT_OUTCOME_SUCCEEDED = 1;
  ROLLOUT_OUTCOME_ABORTED = 2;
  ROLLOUT_OUTCOME_FAILED = 3;
  ROLLOUT_OUTCOME_ROLLED_BACK = 4;
  ROLLOUT_OUTCOME_SUPERSEDED = 5;
}

message RolloutHistoryEntry {
  FleetObjectKey identity = 1;
  FleetObjectKey application = 2;
  FleetObjectKey rollout = 3;
  FleetObjectKey release = 4;
  string stage = 5;
  FleetObjectKey cluster = 6;
  string strategy = 7;
  RolloutOutcome outcome = 8;
  int64 started_at_unix_ms = 9;
  int64 finished_at_unix_ms = 10;
  int64 duration_ms = 11;
  uint32 steps_completed = 12;
  uint32 steps_total = 13;
  int32 final_weight = 14;
  string revision = 15;
  CommitInfo commit = 16;
  string reason = 17;
  string message = 18;
  string triggered_by = 19;
}

message RolloutHistoryStats {
  DataState state = 1;
  uint64 total = 2;
  uint64 succeeded = 3;
  uint64 aborted = 4;
  uint64 failed = 5;
  uint64 rolled_back = 6;
  int64 median_duration_ms = 7;
  int64 p90_duration_ms = 8;
  // Number of retained records the statistics actually cover.
  uint64 sample_size = 9;
  int64 window_start_unix_ms = 10;
}

message ListRolloutHistoryRequest {
  optional string namespace = 1;
  repeated FleetObjectKey applications = 2;
  repeated FleetObjectKey clusters = 3;
  repeated string stages = 4;
  int64 since_unix_ms = 5;
  uint32 page_size = 6;
  string cursor = 7;
}

message ListRolloutHistoryResponse {
  DataState state = 1;
  repeated RolloutHistoryEntry entries = 2;
  string next_cursor = 3;
  RolloutHistoryStats stats = 4;
  int64 retention_horizon_unix_ms = 5;
  uint32 retention_limit = 6;
}
```

`sample_size` + `window_start_unix_ms` prevent the console rendering "median 22m" as a fleet-lifetime
statistic when it is a median over 40 retained records from the last 7 days.

### 2.7 Pipeline run history (gap 6)

```proto
enum PipelineRunOutcome {
  PIPELINE_RUN_OUTCOME_UNSPECIFIED = 0;
  PIPELINE_RUN_OUTCOME_SUCCEEDED = 1;
  PIPELINE_RUN_OUTCOME_FAILED = 2;
  PIPELINE_RUN_OUTCOME_CANCELLED = 3;
}

enum ComputeBasis {
  COMPUTE_BASIS_UNSPECIFIED = 0;
  // Declared requests multiplied by wall duration. An allocation figure, not usage.
  COMPUTE_BASIS_REQUESTED = 1;
  COMPUTE_BASIS_MEASURED = 2;
}

message StepResources {
  DataState state = 1;
  // Millicores.
  double cpu_request_millicores = 2;
  // Bytes.
  double memory_request_bytes = 3;
  double cpu_limit_millicores = 4;
  double memory_limit_bytes = 5;
}

message PipelineRunStep {
  string name = 1;
  string phase = 2;
  int64 started_at_unix_ms = 3;
  int64 finished_at_unix_ms = 4;
  int64 duration_ms = 5;
  uint32 attempts = 6;
  StepResources resources = 7;
  string image = 8;
  string message = 9;
}

message PipelineTestSummary {
  DataState state = 1;
  uint32 total = 2;
  uint32 passed = 3;
  uint32 failed = 4;
  uint32 skipped = 5;
  uint32 flaked = 6;
  // "junit" | "json". Empty when no report was declared.
  string report_format = 7;
}

message PipelineCacheSummary {
  DataState state = 1;
  uint32 hits = 2;
  uint32 misses = 3;
  double hit_ratio = 4;
  // "manifest-render". Pipeline step caching does not exist and reports NOT_AVAILABLE.
  string scope = 5;
}

message PipelineRunSummary {
  FleetObjectKey identity = 1;
  FleetObjectKey pipeline = 2;
  FleetObjectKey application = 3;
  uint64 run_number = 4;
  PipelineRunOutcome outcome = 5;
  int64 started_at_unix_ms = 6;
  int64 finished_at_unix_ms = 7;
  int64 duration_ms = 8;
  uint32 steps_total = 9;
  uint32 steps_succeeded = 10;
  repeated PipelineRunStep steps = 11;
  CommitInfo commit = 12;
  string triggered_by = 13;
  PipelineTestSummary tests = 14;
  PipelineCacheSummary cache = 15;
  DataState compute_state = 16;
  double cpu_minutes = 17;
  ComputeBasis cpu_minutes_basis = 18;
  repeated ArtifactRef artifacts = 19;
}

message ListPipelineRunsRequest {
  optional string namespace = 1;
  FleetObjectKey pipeline = 2;
  FleetObjectKey application = 3;
  int64 since_unix_ms = 4;
  uint32 page_size = 5;
  string cursor = 6;
}

message ListPipelineRunsResponse {
  DataState state = 1;
  repeated PipelineRunSummary runs = 2;
  string next_cursor = 3;
  int64 retention_horizon_unix_ms = 4;
  uint32 retention_limit = 5;
}

message GetPipelineRunRequest {
  string namespace = 1;
  string name = 2;
}

message GetPipelineRunResponse {
  PipelineRunSummary run = 1;
}
```

### 2.8 Ownership metadata (gap 8)

```proto
enum OwnershipTier {
  OWNERSHIP_TIER_UNSPECIFIED = 0;
  OWNERSHIP_TIER_1 = 1;
  OWNERSHIP_TIER_2 = 2;
  OWNERSHIP_TIER_3 = 3;
  OWNERSHIP_TIER_4 = 4;
}

enum DrilldownKind {
  DRILLDOWN_KIND_UNSPECIFIED = 0;
  DRILLDOWN_KIND_DASHBOARD = 1;
  DRILLDOWN_KIND_LOGS = 2;
  DRILLDOWN_KIND_TRACES = 3;
  DRILLDOWN_KIND_RUNBOOK = 4;
  DRILLDOWN_KIND_COST = 5;
  DRILLDOWN_KIND_REPOSITORY = 6;
  DRILLDOWN_KIND_CUSTOM = 7;
}

message DrilldownLink {
  DrilldownKind kind = 1;
  string label = 2;
  // Fully resolved server-side. http(s) only, validated.
  string url = 3;
}

message Ownership {
  DataState state = 1;
  string owner = 2;
  string owner_label = 3;
  string on_call = 4;
  OwnershipTier tier = 5;
  string escalation_url = 6;
  repeated DrilldownLink links = 7;
  // "application" | "appproject" | "inherited"
  string source = 8;
}

message GetApplicationOwnershipRequest {
  string namespace = 1;
  string name = 2;
}

message GetApplicationOwnershipResponse {
  Ownership ownership = 1;
}
```

### 2.9 Per-resource drift detail (gap 9)

```proto
enum DriftReason {
  DRIFT_REASON_UNSPECIFIED = 0;
  DRIFT_REASON_FIELD_CHANGED = 1;
  DRIFT_REASON_RESOURCE_MISSING = 2;
  DRIFT_REASON_RESOURCE_UNMANAGED = 3;
  DRIFT_REASON_PRUNE_PENDING = 4;
  DRIFT_REASON_IGNORED = 5;
}

message DriftedField {
  // JSON pointer into the object.
  string path = 1;
  string desired = 2;
  string live = 3;
  bool ignored = 4;
}

message ResourceDriftDetail {
  string group = 1;
  string version = 2;
  string kind = 3;
  string name = 4;
  string namespace = 5;
  FleetSyncState sync = 6;
  DriftReason reason = 7;
  uint32 changed_field_count = 8;
  // Bounded to 20 entries. changed_field_count is authoritative.
  repeated DriftedField fields = 9;
  bool fields_truncated = 10;
  int64 drift_detected_at_unix_ms = 11;
  // NOT_AVAILABLE for objects last reconciled before this feature shipped.
  DataState detail_state = 12;
  // From metadata.managedFields. Empty when unknown.
  string last_applied_by = 13;
  int64 last_applied_at_unix_ms = 14;
}

message ListDriftDetailsRequest {
  string namespace = 1;
  string application = 2;
  uint32 page_size = 3;
  string cursor = 4;
  bool include_fields = 5;
}

message ListDriftDetailsResponse {
  DataState state = 1;
  repeated ResourceDriftDetail resources = 2;
  uint32 drifted_count = 3;
  uint32 missing_count = 4;
  uint32 pruned_count = 5;
  string next_cursor = 6;
  int64 evaluated_at_unix_ms = 7;
}
```

### 2.10 Lifecycle phase vector (gap 10)

```proto
enum LifecyclePhase {
  LIFECYCLE_PHASE_UNSPECIFIED = 0;
  LIFECYCLE_PHASE_SOURCE = 1;
  LIFECYCLE_PHASE_BUILD = 2;
  LIFECYCLE_PHASE_TEST = 3;
  LIFECYCLE_PHASE_RENDER = 4;
  LIFECYCLE_PHASE_DEPLOY = 5;
  LIFECYCLE_PHASE_VERIFY = 6;
}

enum LifecyclePhaseState {
  LIFECYCLE_PHASE_STATE_UNSPECIFIED = 0;
  // The application has no such stage at all; render as inert, not failed.
  LIFECYCLE_PHASE_STATE_NOT_APPLICABLE = 1;
  LIFECYCLE_PHASE_STATE_PENDING = 2;
  LIFECYCLE_PHASE_STATE_RUNNING = 3;
  LIFECYCLE_PHASE_STATE_BLOCKED = 4;
  LIFECYCLE_PHASE_STATE_SUCCEEDED = 5;
  LIFECYCLE_PHASE_STATE_FAILED = 6;
  // Applicable but no data; render as unknown, not failed.
  LIFECYCLE_PHASE_STATE_UNKNOWN = 7;
}

// Compact per-row form carried on ApplicationSummary.
message LifecycleVector {
  // Exactly 6 entries, in LifecyclePhase order 1..6.
  repeated LifecyclePhaseState states = 1;
  int64 observed_at_unix_ms = 2;
}

message LifecyclePhaseStatus {
  LifecyclePhase phase = 1;
  LifecyclePhaseState state = 2;
  int64 started_at_unix_ms = 3;
  int64 finished_at_unix_ms = 4;
  int64 duration_ms = 5;
  string detail = 6;
  FleetObjectKey reference = 7;
  // "Pipeline" | "Release" | "Rollout" | "AnalysisRun"
  string reference_kind = 8;
}

message ApplicationLifecycle {
  FleetObjectKey application = 1;
  // Always 6 entries, fixed order.
  repeated LifecyclePhaseStatus phases = 2;
  int64 observed_at_unix_ms = 3;
}

message GetApplicationLifecycleRequest {
  string namespace = 1;
  string name = 2;
}

message GetApplicationLifecycleResponse {
  ApplicationLifecycle lifecycle = 1;
}
```

### 2.11 Mutations (gap 11)

```proto
message RolloutHold {
  bool held = 1;
  string held_by = 2;
  int64 held_at_unix_ms = 3;
  // 0 means held until explicitly resumed.
  int64 expires_at_unix_ms = 4;
  string reason = 5;
  int32 frozen_weight = 6;
}

message GetRolloutHoldRequest {
  string namespace = 1;
  string name = 2;
}

message GetRolloutHoldResponse {
  RolloutHold hold = 1;
}

message HoldRolloutRequest {
  string namespace = 1;
  string name = 2;
  string reason = 3;
  int64 expires_at_unix_ms = 4;
}

message HoldRolloutResponse {
  Rollout rollout = 1;
  RolloutHold hold = 2;
}

message ResumeRolloutRequest {
  string namespace = 1;
  string name = 2;
  string reason = 3;
}

message ResumeRolloutResponse {
  Rollout rollout = 1;
}

message IgnoredFieldRule {
  string group = 1;
  string kind = 2;
  string name = 3;
  string namespace = 4;
  repeated string json_pointers = 5;
  string reason = 6;
  string created_by = 7;
  int64 created_at_unix_ms = 8;
}

message IgnoreDriftedFieldRequest {
  string namespace = 1;
  // Application name.
  string name = 2;
  string group = 3;
  string kind = 4;
  string resource_name = 5;
  string resource_namespace = 6;
  repeated string json_pointers = 7;
  string reason = 8;
  // True stops ignoring the listed pointers.
  bool remove = 9;
}

message IgnoreDriftedFieldResponse {
  repeated IgnoredFieldRule rules = 1;
}

enum PatchType {
  PATCH_TYPE_UNSPECIFIED = 0;
  PATCH_TYPE_JSON_PATCH = 1;
  PATCH_TYPE_MERGE_PATCH = 2;
  PATCH_TYPE_STRATEGIC_MERGE = 3;
}

message ApplyResourcePatchRequest {
  string namespace = 1;
  // Application name.
  string name = 2;
  string group = 3;
  string version = 4;
  string kind = 5;
  string resource_name = 6;
  string resource_namespace = 7;
  PatchType patch_type = 8;
  string patch = 9;
  // The server dry-runs unless confirm is explicitly true.
  bool confirm = 10;
  string reason = 11;
}

message ApplyResourcePatchResponse {
  bool applied = 1;
  bool dry_run = 2;
  string result_manifest = 3;
  string diff = 4;
  // Always populated when applied: this change is outside Git and will be reverted on next sync.
  string warning = 5;
  int64 applied_at_unix_ms = 6;
}

message ResourceSelector {
  string group = 1;
  string version = 2;
  string kind = 3;
  string name = 4;
  string namespace = 5;
}

message SyncResourcesRequest {
  string namespace = 1;
  // Application name.
  string name = 2;
  // Empty selects the whole application, matching SyncApplication.
  repeated ResourceSelector resources = 3;
  bool prune = 4;
  // The server dry-runs unless confirm is explicitly true.
  bool confirm = 5;
  string reason = 6;
}

message SyncResourcesResponse {
  bool accepted = 1;
  bool dry_run = 2;
  uint32 selected_count = 3;
  repeated ResourceSelector unmatched = 4;
  string sync_token = 5;
}
```

`confirm` rather than `dry_run` is deliberate: proto3 bools default to `false`, so the safe value
must be the default. A client that forgets the field gets a dry run.

### 2.12 `ApplicationSummary` extension — the one deliberate contract change

```proto
message OwnershipSummary {
  string owner = 1;
  string on_call = 2;
  OwnershipTier tier = 3;
}

message CommitSummary {
  string short_revision = 1;
  string author_name = 2;
  // First line, clamped to 120 bytes.
  string message = 3;
  int64 committed_at_unix_ms = 4;
}
```

Appended to `ApplicationSummary` (22 → 26 fields):

```proto
  LifecycleVector lifecycle = 23;
  OwnershipSummary ownership = 24;
  CommitSummary commit = 25;
  // Release identifier for the current stage, e.g. "r241". Empty when none.
  string release_id = 26;
```

Rationale: the applications table renders a 6-cell LIFECYCLE strip and owner/on-call tags **per row**
for up to 500 rows. Serving those from per-row RPCs would be N+1 on the hottest view in the console.
All four are cheap, bounded, snapshot-derived and change only when the application itself changes —
so they cause no extra `index_generation` churn.

**Deliberately NOT added to `ApplicationSummary`:** cost, capacity, signals, drift detail. Those are
high-churn or externally sourced; carrying them in the snapshot would bump `index_generation` on
every scrape and blow the UI's page cache (`ui/src/lib/use-fleet-data.ts:396-438`), and would couple
the fleet list's latency and availability to a Prometheus or billing backend.

### 2.13 `FleetCapability` extension

```proto
  FLEET_CAPABILITY_ROLLOUT_HOLD = 5;
  FLEET_CAPABILITY_RESOURCE_PATCH = 6;
  FLEET_CAPABILITY_DRIFT_IGNORE = 7;
```

Selective sync deliberately reuses `FLEET_CAPABILITY_APPLICATION_SYNC` — it is the same authority.
`FLEET_CAPABILITY_RESOURCE_PATCH` maps to `ActionAdmin`, not `ActionWrite`, because it writes to the
cluster outside GitOps.

Adding enum values does **not** change any locked message's descriptor hash (fields reference enums
by name), so only the `wantEnums` map in the contract test needs updating.

### 2.14 RPCs — appended, in this order

```proto
  rpc GetDataSources(GetDataSourcesRequest) returns (GetDataSourcesResponse);                      // 41
  rpc ListClusters(ListClustersRequest) returns (ListClustersResponse);                            // 42
  rpc GetCluster(GetClusterRequest) returns (GetClusterResponse);                                  // 43
  rpc QueryApplicationSignals(QueryApplicationSignalsRequest) returns (QueryApplicationSignalsResponse); // 44
  rpc QueryCost(QueryCostRequest) returns (QueryCostResponse);                                     // 45
  rpc ListSourceEvents(ListSourceEventsRequest) returns (ListSourceEventsResponse);                // 46
  rpc ListRolloutHistory(ListRolloutHistoryRequest) returns (ListRolloutHistoryResponse);          // 47
  rpc ListPipelineRuns(ListPipelineRunsRequest) returns (ListPipelineRunsResponse);                // 48
  rpc GetPipelineRun(GetPipelineRunRequest) returns (GetPipelineRunResponse);                      // 49
  rpc GetRevisionInfo(GetRevisionInfoRequest) returns (GetRevisionInfoResponse);                   // 50
  rpc GetApplicationOwnership(GetApplicationOwnershipRequest) returns (GetApplicationOwnershipResponse); // 51
  rpc ListDriftDetails(ListDriftDetailsRequest) returns (ListDriftDetailsResponse);                // 52
  rpc GetApplicationLifecycle(GetApplicationLifecycleRequest) returns (GetApplicationLifecycleResponse); // 53
  rpc GetRolloutHold(GetRolloutHoldRequest) returns (GetRolloutHoldResponse);                      // 54
  rpc HoldRollout(HoldRolloutRequest) returns (HoldRolloutResponse);                               // 55
  rpc ResumeRollout(ResumeRolloutRequest) returns (ResumeRolloutResponse);                         // 56
  rpc IgnoreDriftedField(IgnoreDriftedFieldRequest) returns (IgnoreDriftedFieldResponse);          // 57
  rpc ApplyResourcePatch(ApplyResourcePatchRequest) returns (ApplyResourcePatchResponse);          // 58
  rpc SyncResources(SyncResourcesRequest) returns (SyncResourcesResponse);                         // 59
```

Verb choices are not cosmetic — `internal/api/auth/middleware.go:249 classify` is a name heuristic:

| RPC | classify → | audit verb | notes |
|---|---|---|---|
| `GetDataSources`, `GetCluster`, `ListClusters`, `GetRevisionInfo`, `GetApplicationOwnership`, `ListDriftDetails`, `GetApplicationLifecycle`, `ListSourceEvents`, `ListRolloutHistory`, `ListPipelineRuns`, `GetPipelineRun`, `GetRolloutHold` | ActionRead | n/a | all contain `list`/`get` |
| `QueryApplicationSignals`, `QueryCost` | **ActionWrite** ⚠ | n/a | `Query*` contains neither `list` nor `get`. Must be added to `classify`, exactly as `QueryApplications` is today, or renamed. |
| `HoldRollout` / `ResumeRollout` | ActionWrite / rollouts | **add `"Hold"`, `"Resume"`** | `auditVerbs` is prefix-based |
| `IgnoreDriftedField` | ActionWrite / applications | **add `"Ignore"`** | |
| `ApplyResourcePatch` | ActionWrite / applications | `Apply` ✓ existing | |
| `SyncResources` | ActionWrite / applications | `Sync` ✓ existing | |

Fleet-wide, cross-project reads that MUST be added to `defersProjectSetAuthorization`
(`auth/middleware.go:79-89`): `GetDataSources`, `ListClusters`, `QueryApplicationSignals`,
`QueryCost`, `ListSourceEvents`, `ListRolloutHistory`, `ListPipelineRuns`. Without this the coarse
namespace/project check incorrectly denies them.

**Deliberately not adding a `clusters` authz `Resource`.** `auth.Resource` today is
`applications, pipelines, releases, stages, templates, artifacts, rollouts`. Adding `clusters` would
mean every existing deployment's `RBACRules` silently lack it and clusters vanish. Instead
`ListClusters` classifies as `applications/read` and derives cluster visibility from
`Snapshot.ByCluster` intersected with the caller's authorized applications. A `clusters` resource can
be introduced later as an explicit, documented values migration.

---

## 3. BACKEND IMPLEMENTATION PLAN

### 3.1 Per-RPC table

| RPC | Handler file (package `apiserver`) | Reads from | Persisted / collected | Storage decision |
|---|---|---|---|---|
| `GetDataSources` | `data_sources_handler.go` | injected provider registry + `fleet.Reader` | nothing | none — computed per request |
| `ListClusters` / `GetCluster` | `cluster_handler.go` | `s.client` (Cluster informer already warmed, `cmd/main.go:961`) + `Snapshot.ByCluster`/`Targets` for counts | `ClusterStatus` additive fields | etcd via CRD status, 30s cadence |
| `QueryApplicationSignals` | `signals_handler.go` | `internal/metricprovider` → Prometheus | nothing durable; bounded TTL result cache | in-memory cache only |
| `QueryCost` | `cost_handler.go` | `internal/costprovider` (rate-card or billing) | `CostSource` CRD holds *config*, not data | in-memory cache; config in etcd |
| `ListSourceEvents` | `source_events_handler.go` | `SourceEvent` CRs via `s.client` | new CRD | etcd, count+TTL pruned |
| `ListRolloutHistory` | `rollout_history_handler.go` | `RolloutRecord` CRs | new CRD | etcd, count+TTL pruned |
| `ListPipelineRuns` / `GetPipelineRun` | `pipeline_runs_handler.go` | `PipelineRun` CRs | new CRD | etcd, count+TTL pruned |
| `GetRevisionInfo` | `revision_handler.go` | `ApplicationStatus.RevisionInfo`, else newest `SourceEvent` | `ApplicationStatus.RevisionInfo` | etcd, status |
| `GetApplicationOwnership` | `ownership_handler.go` | Application annotations + `AppProject.spec.ownership` | spec fields | etcd, spec |
| `ListDriftDetails` | `drift_handler.go` | `ApplicationStatus.Resources` (widened) + live `managedFields` via `dynamicClient` | widened `ResourceSync` | etcd, status |
| `GetApplicationLifecycle` | `lifecycle_handler.go` | `ApplicationStatus.LifecyclePhases` | 6 fixed status entries | etcd, status |
| `GetRolloutHold` / `HoldRollout` / `ResumeRollout` | `rollout_hold_handler.go` | Rollout CR | annotation + `RolloutStatus.Hold` | etcd, annotation + status latch |
| `IgnoreDriftedField` | `drift_handler.go` | Application CR | `ApplicationSpec.IgnoreDifferences` (scoped) | etcd, spec |
| `ApplyResourcePatch` | `resource_patch_handler.go` | `dynamicClient` + `restMapper` | nothing (audit record only) | none |
| `SyncResources` | `sync_handler.go` | Application CR | bounded selector annotation | etcd, annotation |

All handlers hang off the single `PaprikaServer` struct (`internal/api/server.go:94`); new
dependencies enter as `With…() ServerOption`, never as constructor parameters. The compile-time
assertion at `server.go:201` forces every method to exist in the same change.

### 3.2 New CRDs

| CRD | Group | Written by | Retention |
|---|---|---|---|
| `SourceEvent` | `core.paprika.io/v1alpha1` | webhook receiver (`handler.go:182`), application controller (`checkSourceChanged`), `SyncApplication` | count (default 200/ns) + TTL (default 7d) |
| `RolloutRecord` | `rollouts.paprika.io/v1alpha1` | rollout controller terminal transition (`rollout_controller.go:888`), release controller promotions | count (default 50/app) + TTL (default 30d) |
| `PipelineRun` | `pipelines.paprika.io/v1alpha1` | pipeline controller (`handlePipelineResult`, `pipeline_controller.go:120` — already holds `start time.Time`) | count (default 50/pipeline) + TTL (default 30d) |
| `ObservabilitySource` | `observability.paprika.io/v1alpha1` | operator (config only) | n/a |
| `CostSource` | `observability.paprika.io/v1alpha1` | operator (config only) | n/a |

Why new CRDs rather than status arrays: `ReleaseStatus.PromotionHistory`
(`release_types.go:105`) is the cautionary precedent — it is **completely uncapped** and every append
rewrites the whole Release status. Separate objects are independently listable, label-selectable,
paginable, RBAC-scopable and individually deletable, and they fall inside the existing Velero
schedule for free. Label every record with `paprika.io/application` and `paprika.io/cluster` plus a
field index so listing never does a cluster-wide unindexed `List`.

Why **not** a database, Redis, or an in-memory ring: there is no `database/sql` anywhere and the
`lib/pq`/`sqlx` entries in `go.mod` are Helm's transitive deps; the chart has no PVC anywhere and
Velero is the declared DR story; Redis is `enabled: false` by default, single-replica, `save ""`,
`allkeys-lru`, `/data` on an `emptyDir`; and the API server is multi-replica so an in-memory ring
would give each replica a different partial feed that flaps between refreshes.

### 3.3 CRD status/spec additions (no new controller needed)

- `ClusterStatus` (+): `NodeCount`, `ReadyNodeCount`, `PodCount`, `RunningPodCount`,
  `NamespaceCount`, `Regions []string`, `Zones []string`, `KubeletVersions []string`,
  `CPUAllocatable/CPUCapacity/CPURequested/CPUUsed`, `MemoryAllocatable/MemoryCapacity/
  MemoryRequested/MemoryUsed`, `InventoryObservedAt`, `CapacityObservedAt`,
  `InventoryState`, `CapacityState`, `UnavailableReason`. Plus **writers for the existing
  `AgentInfo` stub** and a new `ClusterSpec.AgentAddress`.
- `ApplicationStatus` (+): `LifecyclePhases []LifecyclePhaseStatus` (fixed 6),
  `RevisionInfo {Author, AuthorEmail, Message, CommittedAt, URL, State}`.
- `ResourceSync` (+): `ChangedFieldCount int32`, `ChangedFields []string` (cap 20),
  `DriftedAt *metav1.Time`, `Reason string`.
- `ApplicationSpec.IgnoreDifferences` → `IgnoreDiff` (+): `Group`, `Kind`, `Name`, `Namespace`,
  `Reason`, `CreatedBy`, `CreatedAt`.
- `RolloutStatus` (+): `Hold *RolloutHold{HeldBy, HeldAt, ExpiresAt, Reason, FrozenWeight}`.
- `PipelineSpec` (+): `TestReport {Path, Format}`. `PipelineStep` (+):
  `Resources *corev1.ResourceRequirements`. `PipelineStatus` (+): `RunNumber uint64` (monotonic —
  replaces the constant `LastExecutionID = "run-" + name`).
- `AppProject.Spec` (+): `Ownership {Owner, OwnerLabel, OnCall, Tier, EscalationURL, Links []}`,
  `DefaultObservabilitySourceRef`, `DefaultCostSourceRef`.
- **Fix while here:** cap `ReleaseStatus.PromotionHistory`. It is an existing latent etcd-size bug
  and this redesign's write volume hits it first.

### 3.4 Controller / reconciler work

1. **`ClusterReconciler` (extend, no new controller).** `internal/controller/clusters/cluster_controller.go`.
   In `checkHealth` (`:144`), which already builds a target-cluster `Clientset` every 30s, add
   `Nodes().List` and a paged `Pods().List(resourceVersion=0)`, plus an optional
   `metrics.k8s.io` read. Extract the arithmetic into a new unit-testable
   `internal/clusterinventory` package. **Write status only when values actually changed** —
   follow the `connectionStateEqual` (`repository_controller.go:154`) precedent, or this becomes a
   30s etcd write per cluster. Also fix the discarded timeout context at `:156` and the permanent
   `Pending` for agent mode at `:79-81`.
2. **`RolloutReconciler` (extend).** A `latchHold` mirroring `latchAbort` (`:252`), and a
   short-circuit next to the existing `spec.Paused` branch (`:164`) that returns before
   `strategy.Sync` and `configureTraffic`. Write a `RolloutRecord` on terminal transition inside
   `updateStatusFromResult` (`:888`).
3. **`ApplicationReconciler` (extend).** Compute `LifecyclePhases`; populate `RevisionInfo` from the
   widened `ResolveResult`; emit `SOURCE_EVENT_KIND_POLL_DETECTED` from `checkSourceChanged`
   (`:1354`).
4. **`PipelineReconciler` (extend).** Monotonic run number; write a `PipelineRun` in
   `handlePipelineResult` (`:120`); collect the test report; pass step `Resources` into
   `CreateStepJob` (`internal/engine/workflow.go:372`).
5. **`ReleaseReconciler` (extend).** Honour a bounded resource selector for scoped sync; record
   promotions into `RolloutRecord` for non-rollout stages. **Landmine:** `:587` does
   `ro.Spec = expected.Spec` every reconcile — hold state must never live in `Rollout.spec`.
   **Landmine:** `syncApplicationGateStatus` (`:2881`) replaces `app.Status.Gates` wholesale, so any
   new `GateStatus` field needs explicit carry-forward in `checkApprovalGates`.
6. **`HistoryPruner` (new, one small `manager.Runnable`).** A single ticker pruning all three record
   CRDs by count + TTL, modelled on `pruneOldReleases` / `fillHistoryLimit`
   (`application_controller.go:2099-2199`). One pruner, three kinds — not three controllers.
7. **`ObservabilitySource` health controller (new).** From the existing plan; writes
   `status.phase/capabilities/lastCheckedAt/responseTime`.

### 3.5 New Go packages

| Package | Purpose |
|---|---|
| `internal/clusterinventory` | node/pod aggregation arithmetic, pure and unit-testable |
| `internal/metricprovider` (+`/prometheus`) | provider contracts, AST matcher injection, endpoint allowlist, validating dialer, bounded decode, normalization |
| `internal/costprovider` (+`/ratecard`) | `CostProvider` interface, rate-card evaluator, billing adapter seam |
| `internal/fleet/weights` | the `WeightReader` implementation and its cluster/cost siblings, behind an `atomic.Pointer` refreshed on its own ticker |
| `internal/history` | shared record write + prune + list/paginate helper over the three record CRDs |

### 3.6 Fleet index changes — deliberately minimal

**Add** to `fleet.ApplicationSummary` (`model.go:145`): `LifecyclePhases [6]PhaseState` (a fixed
**array**, not a slice — keeps `reflect.DeepEqual` in `upsertApplication` cheap and needs no
`cloneApplications` change), `LifecycleObservedUnixMS int64`, `Owner`/`OnCall` strings, `Tier uint8`,
`CommitShortRevision`/`CommitAuthor`/`CommitMessage` (clamped) + `CommitUnixMS`, `ReleaseID string`.
Populate in `projectApplication` (`projection.go:48`).

Ownership from `AppProject` requires two edits the fleet notes already identified:
`loadProjectionInput` must fetch the project **unconditionally**, and the `ResourceAppProject` delta
branch (`rebuild.go:840`) must stop gating reprojection on `r.optionalSourceProjector != nil`.

**Do NOT add** cluster capacity, cost, or signals to `Snapshot`. This contradicts one reading of the
cluster notes and is deliberate: `ClusterStatus` is written on a 30s cadence, so projecting capacity
into `ClusterSummary` would make `upsertCluster` see a change every 30s per cluster and bump
`Snapshot.Generation` continuously — which is the UI's cache-invalidation key
(`use-fleet-data.ts:396`). At 100 clusters that is a generation bump roughly every 300ms and the
console page cache never survives. `ListClusters` therefore reads Cluster CRs directly from the
already-warmed cache-backed `client.Client`, and uses the snapshot **only** for `ByCluster` counts
and authorization scoping.

**Implement `WeightReader`** (`map.go:50-54`) in `internal/fleet/weights` and pass it at
`reader.go:104`/`:124` instead of `nil`. Fallback semantics are already specified and tested — a
missing/NaN/Inf/negative/overflowing weight sets `used_resource_fallback` per leaf. Never silently
render 0.

Add `fleetQueryKind` values (`telemetry.go:34`) and `paprikametrics.FleetQueryKind`
(`internal/metrics/fleet.go:25`) for any new query kind, or it records as `unknown`.
`fleet.Reader` has two implementations — `*Index` and `unavailableReader` (`runtime.go:452`) — and
there is no generated mock; both must be updated if the interface grows.

### 3.7 Source-layer changes

- `internal/source/git.go:228 resolveAndCheckout`: add `mirrorRepo.CommitObject(*hash)`.
- `internal/source/resolver.go:14-19`: widen `ResolveResult` with `Author`, `AuthorEmail`,
  `Message`, `CommittedAt`, `Digest` (OCI), `LastModified` (S3).
- Thread through the three lockstep sites: `api.proto:503-507`, `reposerver/server.go:82-86`,
  `reposerverclient/client.go:149-153`. `ResolveSourceResponse` is one of the 120 hash-locked
  messages, so adding fields to it **requires recomputing its hash** — see §6.
- `internal/webhook/receiver/handler.go:350-364`: widen both payload structs; pass the real revision
  to `Invalidate` instead of `""`; write a `SourceEvent`; add a field index to replace the
  cluster-wide unindexed `List` at `:217`.

### 3.8 Cross-cutting API wiring

- `internal/api/auth/middleware.go`: add the seven fleet-wide reads to
  `defersProjectSetAuthorization`; make `classify` treat `Query*` as read (or add an explicit
  procedure→(action,resource) table — the current substring scan is also non-deterministic when a
  procedure matches two keywords, since Go map iteration order is random).
- `internal/api/audit_middleware.go:18`: add `"Hold"`, `"Resume"`, `"Ignore"` to `auditVerbs`, and
  update the table in `audit_middleware_test.go:16-27`.
- `internal/api/fleet_capabilities.go:20`: add three `fleetCapabilityGrant` tuples —
  `{ActionWrite, ResourceRollouts, {CapabilityRolloutHold}}`,
  `{ActionWrite, ResourceApplications, {CapabilityDriftIgnore}}`,
  `{ActionAdmin, ResourceApplications, {CapabilityResourcePatch}}` — and matching `fleet.Capability`
  constants in `internal/fleet/filter.go`.
- New metrics go through the **OTel SDK** in `internal/metrics/otel.go` per AGENTS.md, not the raw
  Prometheus client. Keep the repo's cardinality discipline: closed enum attributes only, never
  names, endpoints, credentials or PromQL.
- `test/fleetconsole/server.go:41`: add fixtures for every new RPC. The `fleet-ui-smoke` CI job runs
  the **real Go server** against Playwright, so an unfixtured RPC breaks it.

---

## 4. DEGRADED-MODE CONTRACT

This is normative. It is what stops the console shipping fake numbers.

### 4.1 The three representations of absence

| Class | Representation | Applies to |
|---|---|---|
| **A. State-carrying** | a `DataState` field adjacent to the numbers | everything where `0` is a plausible real value: cost, capacity, signals, inventory counts, test counts, cache ratio, CPU-minutes, step resources, drift detail, agent info |
| **B. Empty scalar** | `""` or `*_UNSPECIFIED` | identity-ish metadata where empty is unambiguous: owner, on-call, commit author/message, kubernetes version, regions, release id, provider commit URL |
| **C. Completeness markers** | explicit booleans/limits | `fields_truncated`, `triggered_applications_truncated`, `retention_horizon_unix_ms`, `retention_limit`, `sample_size`, `window_start_unix_ms`, `basis`, `cpu_minutes_basis`, `used_resource_fallback` |

### 4.2 `DataState` semantics — server obligations

| State | Meaning | Server MUST | Console MUST |
|---|---|---|---|
| `OK` | fresh, real | populate numerics and `observed_at_unix_ms` | render |
| `NOT_CONFIGURED` | no source configured for this data class | zero all numerics; set `unavailable_reason` to a short, safe, actionable string | **hide** the board/column entirely; optionally show a "connect a source" affordance |
| `NOT_AVAILABLE` | source configured, capability absent (e.g. no metrics-server, kustomize has no revision, node RBAC denied) | zero all numerics; set `unavailable_reason` | **grey** the surface with the reason; never a number |
| `STALE` | last good sample older than `staleness_budget_ms` | keep the **last good** numerics and the true `observed_at_unix_ms` | render **with an age badge**; never present as current |
| `ERROR` | source configured and failing | zero all numerics; `unavailable_reason` must be sanitized | show an error affordance |
| `FORBIDDEN` | caller may not see it | zero all numerics | hide, without implying the data is absent |

`STALE` is the only non-`OK` state in which numeric fields are populated. In every other non-`OK`
state numerics MUST be zero, so a client that ignores the state renders `0` rather than a stale
wrong figure — and `0` next to a hidden board is visibly a bug, not a plausible lie.

`unavailable_reason` follows the fleet path's sanitization rule (`mapFleetError`,
`fleet_handler.go:186`): safe, generic, never leaking backend text. `TestGetSystemStatusErrorMappingIsGeneric`
is the template.

### 4.3 Staleness budgets (server-decided, surfaced via `GetDataSources`)

| Data class | Budget | Rationale |
|---|---|---|
| cluster inventory / capacity | 3 × health-check interval (default 90s) | tolerates two missed 30s reconciles |
| application signals | 3 × scrape window, floor 90s | matches provider refresh |
| cost | 24 h | monthly figures move slowly |
| source events / rollout history / pipeline runs | n/a — records are immutable | use `retention_horizon_unix_ms` instead |

### 4.4 `GetDataSources` — the console's boot-time capability probe

`GetDataSources` returns **exactly one `DataSourceStatus` per `DataClass`, in enum order, always** —
mirroring the fixed 7-health / 4-sync bucket convention already asserted by
`system_status_handler_test.go:99`. The console calls it once at boot and uses it to decide which
boards exist at all, instead of probing every RPC and inferring from empty results.

Concretely:
- No `ObservabilitySource` anywhere → `APPLICATION_SIGNALS = NOT_CONFIGURED` → the console does not
  render latency/error-rate/request-rate anywhere, and `FLEET_SIZE_METRIC_REQUEST_RATE` is not
  offered as a treemap sizing option.
- No `CostSource` → `COST = NOT_CONFIGURED` → the COST/MO column, the cluster `$/mo` chip, the heat
  tooltip cost row and the cost drilldown all disappear. One check, four surfaces.
- Remote `nodes` RBAC denied → `CLUSTER_INVENTORY = NOT_AVAILABLE` with reason → node/pod counts
  greyed, everything else on the cluster card still renders.
- metrics-server absent → `CLUSTER_CAPACITY = OK` (allocatable/requested are real) but each
  `ResourceMeter.used_state = NOT_AVAILABLE` → the meter draws requested and allocatable segments
  and a hatched unknown band.

### 4.5 Explicitly forbidden behaviours

1. Never substitute one metric for another without a wire-visible flag. The single sanctioned
   fallback is `used_resource_fallback` on map nodes and matrix cells, which already exists and is
   already tested.
2. Never let an estimate be indistinguishable from a measurement — `CostBasis` and `ComputeBasis`
   exist for exactly this.
3. Never present a windowed aggregate as a lifetime one — `sample_size`, `window_start_unix_ms` and
   `retention_horizon_unix_ms` are mandatory on every aggregate.
4. Never emit a stub that claims success. `internal/analysis` `latencyP99` returning
   `Passed: true, "no metrics server available, assuming pass"` (`analysis.go:163-168`) is the
   in-repo example of the failure mode this contract exists to prevent; it should be fixed to return
   an explicit unavailable outcome as part of this work.
5. Never derive a per-resource "drift reason" sentence the API cannot substantiate. `DriftReason` is
   an enum plus field paths; `last_applied_by` comes from real `managedFields`.

---

## 5. SEQUENCING

### Phase 0 — Land the contract first, stub-implemented (1 PR, blocks nothing after it)

Add **every** message, enum and RPC from §2 to `api.proto`; regenerate; implement all 19 methods on
`*PaprikaServer` returning honest `DATA_STATE_NOT_CONFIGURED` / empty pages; wire
`GetDataSources` to report every class as `NOT_CONFIGURED`; add fixtures to
`test/fleetconsole/server.go`; update the three contract-test maps.

This is the highest-leverage move available. It means:
- the UI builds every board against the **final** wire shape from day one, with no mock/fixture
  divergence and no rework when real data lands;
- every board ships its degraded state first, which is the state most installs will actually be in;
- backend tracks then fill in behind a stable contract, each independently shippable.

It also concentrates **all** proto-contract churn into one reviewable PR.

### Phase 1 — Cheap, CRD-only, fully parallel (5 independent tracks)

| Track | Gap | Unblocks in the UI |
|---|---|---|
| 1a Ownership (`AppProject.spec.ownership` + annotations + projector) | 8 | app-detail owner/on-call/tier tags, drilldown rail |
| 1b Lifecycle vector (controller derivation + `ApplicationStatus` + projector) | 10 | the LIFECYCLE strip and overview board 01 |
| 1c Drift detail (thread paths out of `specContainsAt`, widen `ResourceSync`) | 9 | sync & diff workbench field counts and drift timestamps |
| 1d Commit metadata (`CommitObject`, `ResolveResult`, `ApplicationStatus.RevisionInfo`) | 7 | pipeline header, rollout history rows, app detail |
| 1e Cluster inventory (`Nodes`/`Pods` in the 30s loop + `ListClusters`/`GetCluster`) | 1, 2(a)(b) | board 06 clusters, fleet-map column meta |

1a and 1b touch `projectApplication` and should be sequenced within their own track to avoid a
merge conflict, but neither blocks the other three. 1e carries a remote-RBAC change and should start
early because it needs a chart + docs change and cluster-side coordination.

### Phase 2 — History records (2a first, then 2b/2c in parallel)

- **2a** `internal/history` shared write/prune/list helper + `SourceEvent` CRD + widened webhook
  payloads + the field index. Establishes the pattern end to end and immediately unblocks board 05
  (source triggers), which the gap analysis called "the most fabricated board in the design".
- **2b** `RolloutRecord` + the hold latch → the Recent·7d rollout tab and `HoldRollout`.
- **2c** `PipelineRun` + run counter + step resources + test report + render-cache counters → the
  pipeline stats strip.

### Phase 3 — Remaining mutations

`IgnoreDriftedField` (after 1c), `SyncResources` (needs release-controller scoped apply),
`ApplyResourcePatch` (break-glass, admin capability, dry-run default). Plus the `auditVerbs`,
`classify` and `fleetCapabilityGrants` wiring.

### Phase 4 — External integrations (start immediately, runs alongside everything)

Isolated in new packages, so it does not contend with Phases 1–3:
- 4a `ObservabilitySource` CRD + `internal/metricprovider` + Prometheus adapter → `QueryApplicationSignals`.
- 4b `fleet.WeightReader` implementation → makes `FLEET_SIZE_METRIC_REQUEST_RATE` real.
- 4c `CostSource` rate-card tier (depends on 1e's requested/allocatable numbers) → `QueryCost` estimates.
- 4d Billing adapter → `COST_BASIS_BILLING`.
- 4e metrics-server integration → `ResourceMeter.used_state = OK`.

4a is the largest and most security-sensitive item in the whole plan (SSRF, credential handling,
cardinality, DoS) and should be staffed as its own workstream from day one.

### What unblocks the UI earliest

Phase 0 unblocks **all** UI work immediately. After that, in order of console value per unit of
backend effort: 1b (lifecycle strip — a headline design element), 1e (board 06 — the board the gap
analysis said "cannot be built"), 2a (board 05), 1a, 1c, 1d, 2b, 2c. Cost and signals land last and
degrade honestly until they do.

---

## 6. RISKS

### 6.1 Proto breaking-change risk — the dominant risk

`internal/api/fleet_contract_test.go` is the guardrail. This design deliberately concentrates all
churn into three edits, all in Phase 0:

1. **`fleetMessageDescriptorContracts["ApplicationSummary"]`** — asserts an *exact* field count and
   per-field number/kind/cardinality (`:488`). Adding fields 23–26 fails it until updated. This is
   the one considered contract change; §2.12 states why N+1 per-row RPCs is the worse option.
2. **`wantEnums["FleetCapability"]`** (`:20-104`) — exact `require.Equalf` on the value map. Adding
   the three new capabilities fails it until updated. No message hash changes.
3. **`legacyFleetMessageDescriptorHashes["ResolveSourceResponse"]`** (`:607`) — if commit metadata
   is added to `ResolveSourceResponse` (gap 7), its SHA-256 must be recomputed. **Mitigation: don't.**
   Return commit metadata via `GetRevisionInfo` and keep `ResolveSourceResponse` at three fields;
   carry the richer data internally on `source.ResolveResult` and `ApplicationStatus.RevisionInfo`.
   With that mitigation **zero** of the 120 locked hashes change.

Everything else is free: new top-level messages are unconstrained (`require.Len` is on the map, not
the file), and referencing locked messages (`Condition`, `Rollout`, `ArtifactRef`) as field types
does not alter their descriptors.

**Ordering is absolute.** `methods.Get(i)` is checked positionally for i = 0..39. Every new RPC goes
after `GetSystemStatus`. Inserting anywhere earlier fails immediately and loudly.

`GetSystemStatusResponse` is left untouched, so `TestSystemStatusContract` (`:117`) stays green —
that is why deployment-capability probing lives in a new `GetDataSources` rather than a new field on
the status response.

Also: `PaprikaServer` does **not** embed `UnimplementedPaprikaServiceHandler`, so adding 19 RPCs
breaks the build at `server.go:201` until all 19 methods exist. That is a feature — it makes Phase 0
atomic — but it means Phase 0 cannot be split across PRs.

### 6.2 `internal/cicontract` tests

A proto-only change needs **zero** `ci.yml` / `workflows_test.go` edits — `testCanonicalCIValidation`
and `testGeneratedDriftDetection` pin job IDs, timeouts, action SHAs and nine exact command strings
in exact order. The one way this design could trip them is if someone adds a **new codegen output
directory**: `rm -rf -- internal/api/paprika ui/src/gen` is pinned verbatim, so a new output dir
would need both the workflow and the pinned string list updated in lockstep. Don't add one.

Related, and easy to miss: `make generate-proto` is **fail-soft** — it silently keeps the committed
files if `protoc-gen-go`, `protoc-gen-connect-go` or `ui/node_modules/.bin/protoc-gen-es` are
missing. A "successful" local regeneration can be a no-op; only the `generated` CI job catches it.
`go tool buf lint` currently fails on three pre-existing `Severity` findings — do not fix those
(renaming breaks the wire) and do not add new ones: every new enum value here is correctly prefixed.

### 6.3 Lint strictness

`internal/api/*.go` has **no** golangci exclusion, and `cyclop max-complexity: 10` is the strictest
setting in the repo. Nineteen new handlers, each doing validate → authorize → read → convert, will
trip `cyclop`, `funlen` (100/60) and `dupl` (150 tokens). Repo precedent is explicit helper
extraction plus `//nolint:cyclop // <reason>` (74 in the tree; `fleet_handler.go:26,80,127` are the
template). Two more traps: `exhaustive` requires a switch on a proto enum to name **every** member —
a `default:` clause does not satisfy it, and this design adds 14 new enums; and `errcheck` runs with
`check-blank` and `check-type-assertions`, so `_ = f()` and unchecked type assertions are errors.
Budget for it; do not discover it at PR time.

### 6.4 Fleet index performance at 10k applications

`scale_test.go` gates query p95 ≤ 300 ms at 10 000 apps **and** bounded retained-heap growth across
two identical installs. Threats and mitigations:

- **Summary growth.** Four new fields on `ApplicationSummary`. Mitigation: `LifecyclePhases` is a
  fixed `[6]PhaseState` **array**, not a slice — no `cloneApplications` change, no per-generation
  aliasing risk, and `reflect.DeepEqual` in `upsertApplication` (`snapshot.go:414`) stays cheap.
  Commit message and owner strings are clamped server-side.
- **Generation churn.** The single biggest hazard, and the reason capacity/cost/signals are kept out
  of `Snapshot`. `index_generation` is the UI's cache-invalidation key; a 30s-cadence cluster status
  write projected into `ClusterSummary` would invalidate the whole console page cache continuously.
- **Facets.** Unchanged — no new facet dimension is proposed. Adding one later means a new
  `By<X> IDSet` index, `canonicalApplicationFilter`/`PageKey` changes, and silent invalidation of
  every in-flight cursor. Treat it as its own project.
- **AppProject reprojection.** Making the project fetch unconditional means an `AppProject` edit
  reprojects every application in that project. Rare, but it should be measured against the scale
  gate, not assumed.
- **New informers.** None added — the lifecycle vector is computed by the Application controller
  specifically to avoid an eighth kind in the frozen seven-CRD `ProjectionStore` contract.

### 6.5 Destabilising the running controller

Ranked by likelihood of causing a production incident:

1. **`release_controller.go:587` `ro.Spec = expected.Spec`** — anything the API writes to a
   release-managed `Rollout.spec` (including `spec.paused`) is silently reverted every reconcile.
   Hold **must** be an annotation + status latch. Getting this wrong produces a Hold button that
   appears to work and does nothing.
2. **Whole-field status replacement.** `patchPipelineStatus` (`pipeline_controller.go:101`) does
   `fresh.Status = *desiredStatus`; `syncApplicationGateStatus` (`release_controller.go:2881`) does
   `fresh.Status.Gates = statuses`. Any list added to those statuses is clobbered unless the
   reconciler owns it and carries it forward.
3. **etcd write amplification.** Cluster status every 30s × N clusters, plus three new record kinds.
   Guard every status write with an equality check (`connectionStateEqual` precedent) and prune
   aggressively. A busy fleet can produce thousands of records per day; the feed is a *recent
   window*, and the wire says so.
4. **Cost of the pod list.** A full `Pods().List` per cluster per 30s is the most expensive new call
   in the design. Page it, use `resourceVersion=0`, and consider a longer capacity cadence than the
   health cadence if it bites.
5. **`requestReleaseResync` (`application_controller.go:1960`)** re-runs terminal Releases in place
   and destroys the recorded outcome. `RolloutRecord` must be written **at** the transition, not
   reconstructed later.
6. **Uncapped `ReleaseStatus.PromotionHistory`** — an existing latent etcd-size bug that this
   redesign's write volume will hit first. Cap it in Phase 2.
7. **Remote RBAC.** Node/pod listing needs new permissions on the *target* cluster credential. A
   `Forbidden` must degrade to `NOT_AVAILABLE`, never crash the reconcile or flip the cluster to
   Unhealthy.
8. **Readiness.** API readiness is gated on `fleet.Reader.CheckReady()`. Nothing in this design adds
   a new startup dependency to that path — the metric and cost providers must be optional and must
   never block readiness. Verify that explicitly.

### 6.6 Security risks specific to the new surface

- **`ApplyResourcePatch`** writes to the cluster outside GitOps and by definition creates drift.
  Admin capability, dry-run default, mandatory audit, explicit `warning` on the response, and it
  should be disable-able by configuration.
- **Prometheus provider** is an SSRF surface: HTTP(S) only, admin allowlist deny-all by default, a
  custom dialer re-validating every resolved address, loopback/link-local/metadata ranges denied,
  and the browser never submits PromQL.
- **Drilldown URLs** come from operator config and are rendered into the console. Validate scheme
  server-side and resolve templates server-side.
- **Multi-tenant leakage.** `ListClusters` would be the first RPC to expose cluster names outside the
  project shield that `system_status_handler_test.go:172-214` asserts. Every new tenant-scoped read
  needs the `protojson.Marshal` secret-marker leak test from that file.
- **Unaudited mutations.** `auditVerbs` is prefix-based; `HoldRollout`, `ResumeRollout` and
  `IgnoreDriftedField` are silently **not** audited until the verbs are added. That is a compliance
  bug that looks like nothing.

### 6.7 Process risks

- `fleet-ui-smoke` runs the real Go server against Playwright — every new RPC needs a
  `test/fleetconsole/server.go` fixture or that job fails on an unrelated PR.
- The `generated` CI job wipes and regenerates; every generated Go **and** TS file must be committed.
- 19 RPCs, 5 new CRDs, 7 CRD widenings and ~14 new enums is a large surface. Phase 0 is what makes it
  tractable: one contract PR, then narrow, independently revertable feature PRs behind it.

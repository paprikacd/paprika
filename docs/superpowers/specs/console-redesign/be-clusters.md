# BE-CLUSTERS — How Paprika models clusters (agent, agentclient, coordinator, sharding, mtls + everything they touch)

Scope note up front: **`internal/coordinator` and `internal/sharding` have nothing to do with target
clusters.** They shard the *hub's own* controller-manager replicas. `internal/mtls` is a 29-line env-var
helper for hub↔hub TLS and is **not** used by the agent. The real cluster model lives in
`api/clusters/v1alpha1`, `internal/controller/clusters`, `internal/controller/pipelines/cluster_pool.go`
and `internal/fleet`. Those are covered here too because the task cannot be answered without them.

---

## 1. Multi-cluster architecture: hub-PUSH, not agent-push

**Paprika is hub-push / hub-dial in all three modes. Nothing ever dials the control plane. There is no
registration handshake, no long-lived stream, no agent heartbeat, no "connected agents" table.**

Three connection modes on the `Cluster` CR
(`api/clusters/v1alpha1/cluster_types.go:26-32`, values from `api/pipelines/v1alpha1/stage_types.go:9-16`):

| Mode | Constant | How the hub reaches the cluster |
|------|----------|--------------------------------|
| `in-cluster` (default) | `ClusterModeInCluster` | `rest.InClusterConfig()` — the operator's own SA |
| `direct` | `ClusterModeDirect` | kubeconfig from a Secret, or bare `spec.server` |
| `agent` | `ClusterModeAgent` | HTTP POST to an agent process running in the remote cluster |

### 1.1 The agent is a passive HTTP server, not a phoning-home daemon

`internal/agent/server/server.go`

- `type Server struct` (line 54): `v1connect.UnimplementedPaprikaServiceHandler`, `clusterID string`,
  `dynClient dynamic.Interface`, `mapper apimeta.RESTMapper`, `discovery discovery.DiscoveryInterface`.
  **That's the entire per-agent state. No name, region, version, node list, connection time.**
- `NewServer(clusterID string, cfg *rest.Config)` (line 64) — builds dynamic client + RESTMapper +
  discovery from the *local* in-cluster config.
- `Handler()` (line 537) registers exactly three routes:
  - `POST /apply` → `handleApply` (line 551) → `Apply` (line 108)
  - `GET /healthz` → hard-coded `200 "ok"` (does **not** touch the API server)
  - `/paprika.v1.PaprikaService/` → the full Connect handler, but **every RPC returns
    `CodeUnimplemented`** (lines 612-780; e.g. `ListPipelines` line 613, `ListApplications` line 628,
    `GetResourceTree` line 766). The agent implements zero read RPCs.
- `Run(ctx, addr)` (line 577) — plain `http.Server`, `ReadHeaderTimeout: 10s`. **No TLS.** It does not
  call `mtls.ServingConfig()`; only `cmd/main.go:serveListener` (line 1129) and
  `internal/reposerver/server.go:174` do.
- `ApplyRequest` (line 86): `Namespace`, `AppName`, `Manifests []byte`, `SyncOptions *pipelinesv1alpha1.SyncOptions`.
- `ApplyResponse` (line 97): `Applied int`, `Errors []string`, `HookStatuses []pipelinesv1alpha1.HookStatus`.
- `HealthResponse` (line 524): **`{ Healthy bool }` — one field.** `Health()` (line 529) calls
  `s.discovery.ServerVersion()` and throws the version away. This is the single richest
  "what does the agent know about its cluster" call site and it discards everything.
- The agent does apply hooks (PreSync→Sync→PostSync, lines 197-487) — that is the only real logic.

### 1.2 The controller side

`internal/agentclient/client.go` (81 lines, the whole file):

```go
type ControllerClient struct {
    baseURL string
    client  *http.Client
}
func NewControllerClient(baseURL string, client *http.Client) *ControllerClient  // :26
func (c *ControllerClient) Health(ctx context.Context) error                     // :37
func (c *ControllerClient) Apply(ctx, *agentserver.ApplyRequest) (*agentserver.ApplyResponse, error) // :47
func (c *ControllerClient) Enabled() bool                                        // :81
```

- `Health()` (line 37) is a **Connect `ListPipelines` probe that treats `CodeUnimplemented` as success** —
  i.e. it only proves "something Connect-shaped is listening". It returns no data.
- **`Health()` has zero production callers.** Only `internal/agent/agent_test.go:63` calls it. Nothing in
  any controller ever probes an agent for liveness.
- `Apply()` is plain JSON over `POST {baseURL}/apply`.

Call chain into the agent — `internal/controller/pipelines/release_controller.go`:

- `applyManifestsForCluster` (line 1185) → branch at **line 1189**:
  `if cluster.Mode == paprikav1.ClusterModeAgent || cluster.AgentAddress != ""` → `applyViaAgent`.
- `applyViaAgent` (line 1209): `baseURL := cluster.AgentAddress`; if empty, defaults to
  **`fmt.Sprintf("http://%s.%s.svc.cluster.local:8083", cluster.Name, cluster.Namespace)`** (line 1213).
  Plain `http://`. Uses `r.AgentClientBuilder` if set, else `agentclient.NewControllerClient(baseURL, http.DefaultClient)`.
- `internal/controller/pipelines/agent_client.go:14` defines the `AgentApplier` seam (`Apply` only).
- `internal/controller/pipelines/canary_readiness.go:128` has the same mode check for canary readiness.

### 1.3 Deployment topology

- `cmd/main.go:176-177` — `--mode=agent` dispatches to `runAgentMode` (line 846).
- `runAgentMode(ctx, addr, probeAddr, clusterID, metricsAddr, log)`: `clusterID` defaults to `"default"`
  (line 847-849), from flag `--agent-cluster-id` / env **`PAPRIKA_AGENT_CLUSTER_ID`**
  (`cmd/main.go:282-283`). Nothing validates that this matches a `Cluster` CR name.
- Chart: `charts/chart/templates/agent/daemonset.yaml` — the agent ships as a **DaemonSet** (one pod per
  node) fronted by `charts/chart/templates/agent/service.yaml` (ports: `probe` 8081, `http` from
  `.Values.agent.service.port`). Plus `agent/vpa.yaml` and `networkpolicy/agent.yaml`.
- `charts/chart/values.yaml:661-691` — `agent.enabled: false` by default;
  args `--mode=agent --ui-bind-address=:8083 --health-probe-bind-address=:8081`; `agent.clusterID: ""`;
  `agent.tls.{enabled,certSecret,caSecret}` are declared **but referenced by no template and no Go code** —
  dead config.

### 1.4 "Registration" and "staying connected" — what actually happens

**Registration = a human/GitOps creates a `Cluster` CR.** `docs/guides/multi-cluster.md:15-51`. Nothing
self-registers. There is no join token, no CSR flow, no `RegisterCluster` RPC.

**Staying connected** = the `ClusterReconciler` polls, from the hub outward:
`internal/controller/clusters/cluster_controller.go`

- `Reconcile` (line 55):
  1. `spec.disabled` → Phase `Disabled` (line 69-71).
  2. `buildConfig` (line 93): in-cluster → `rest.InClusterConfig()`; direct → Secret kubeconfig
     (`configFromSecret`, line 116, key defaults to `"kubeconfig"`) or bare `&rest.Config{Host: spec.server}`;
     **agent → returns `(nil, nil)`** (line 101-102).
  3. **Line 79-81: `if mode == agent { return updatePhase(..., ClusterPhasePending, "AwaitingAgent",
     "waiting for agent connection") }` — and nothing anywhere ever moves it off Pending.**
     Agent-mode clusters are permanently `Pending`, never report a `Version`, and project to
     `ConnectionStateUnspecified` in the fleet index. **This is a live, load-bearing gap.**
  4. `checkHealth` (line 144): builds a `kubernetes.Clientset`, calls `Discovery().ServerVersion()`,
     returns `version.GitVersion`. (Note line 156: the timeout ctx is created and *discarded* —
     `_, cancel := context.WithTimeout(...)` — so `spec.healthCheck.timeout` is not actually applied.)
  5. `updatePhase` (line 171): stamps `Phase`, `ObservedGeneration`, `LastHealthCheckTime = now`, and a
     `metav1.Condition{Type: string(phase), Status: True, Reason, Message}`; conflict-retried status update;
     returns `RequeueAfter` = `spec.healthCheck.interval` (default **30s**).
- Registered in `cmd/main_controllers.go:451` as `{"clusters-cluster", &clusterscontroller.ClusterReconciler{...}}`
  inside `setupCoreControllers` — i.e. **operator mode only**, not `--mode=api`.
- Admission: `internal/webhook/clusters/v1alpha1/cluster_webhook.go` — `ClusterCustomDefaulter.Default`
  (line 52) defaults `mode=in-cluster`, `healthCheck.interval=30s`, `healthCheck.timeout=10s`,
  `connectionTimeout=30s`. `validateCluster` (line 92) requires a valid mode, requires
  `server` or `kubeconfigSecretRef` for direct mode, and parses the durations.

### 1.5 The second, invisible connection state: `ClusterConnectionPool`

`internal/controller/pipelines/cluster_pool.go` — a per-process cache of dynamic clients keyed by
**sha256 of the kubeconfig bytes** (`kubeconfigHash`, line 180), not by cluster name.

- `type pooledClient struct` (line 31) — **all unexported**:
  `client dynamic.Interface`, `restConfig *rest.Config`, `kubeconfigHash string`, `createdAt time.Time`,
  `lastUsed time.Time`, `healthy bool`, `failures int`, `circuitOpen bool`, `circuitOpenAt time.Time`.
- `type ClusterConnectionPool struct` (line 45): `client`, `defaultConfig`, `clients map[string]*pooledClient`,
  `mu`, `ttl`, `Clock`.
- Constants (line 23-28): `defaultClientTTL = 5m`, `healthCheckInterval = 30s`,
  `circuitBreakerThreshold = 5`, `circuitBreakerReset = 2m`.
- `healthCheckLoop` (line 266) → `runHealthChecks` (line 281) lists 1 namespace per pooled client every 30s
  and flips `healthy`/`failures`/`circuitOpen`. `evictExpired` (line 350) drops entries idle > 2×TTL.
- **None of this is exported, metered, or surfaced.** It is the freshest per-cluster reachability signal in
  the system and the console cannot see it. Worth exposing (see §5).

---

## 2. Every field the control plane holds about a cluster

### 2.1 `Cluster` CR — `api/clusters/v1alpha1/cluster_types.go`

```go
type Cluster struct {            // :118
    metav1.TypeMeta
    metav1.ObjectMeta            // Name, Namespace, CreationTimestamp, Labels, Annotations, UID, ...
    Spec   ClusterSpec
    Status ClusterStatus
}
type ClusterList struct{ ...; Items []Cluster }   // :130
```

`ClusterSpec` (line 67-88) — **9 fields, all operator-authored, none discovered:**

| Field | Type | Notes |
|---|---|---|
| `DisplayName` | `string` | free text; fleet falls back to `metadata.name` |
| `Mode` | `ClusterMode` | enum `direct\|agent\|in-cluster`, kubebuilder default `in-cluster` |
| `Server` | `string` | API server URL |
| `KubeconfigSecretRef` | `*SecretRef{Name,Namespace,Key}` | line 45-49 |
| `ServiceAccount` | `string` | impersonation target; read by `resolveClusterRef` |
| `Labels` | `map[string]string` | **free-form; the only place a `region`/`tier` could live today, and nothing reads it** |
| `HealthCheck` | `*HealthCheckConfig{Interval,Timeout}` | line 52-57, defaults `30s`/`10s` |
| `Disabled` | `bool` | |
| `ConnectionTimeout` | `string` | default `30s`; **parsed by the webhook, never used at runtime** |

`ClusterStatus` (line 91-107) — **6 fields:**

| Field | Type | Written by |
|---|---|---|
| `ObservedGeneration` | `int64` | `updatePhase` :177 |
| `Phase` | `ClusterPhase` = `Pending\|Healthy\|Unhealthy\|Disabled` (:37-42) | `updatePhase` :174 |
| `Conditions` | `[]metav1.Condition` (listType=map on `type`) | `updatePhase` :180 — Type is the phase string, Reason ∈ {`Disabled`,`ConfigError`,`AwaitingAgent`,`HealthCheckFailed`,`Ready`} |
| `LastHealthCheckTime` | `*metav1.Time` | `updatePhase` :178 — **updated on every reconcile, so it is a genuine last-seen** |
| `Version` | `string` | `Reconcile` :89, from `Discovery().ServerVersion().GitVersion`. **Empty forever in agent mode.** |
| `AgentInfo` | `*AgentInfo{Version, Connected *metav1.Time, Address}` (:60-64) | **NOBODY. Zero writers.** `rg AgentInfo` hits only `zz_generated.deepcopy.go`, the CRD YAMLs, and the type decl. It is a schema stub. |

Printer columns (`:112-115`): Mode, Phase, Server, Age.

### 2.2 `ClusterRef` — the inline/target-side reference

`api/pipelines/v1alpha1/stage_types.go:19-27`:

```go
type ClusterRef struct {
    Name             string
    Namespace        string
    Mode             ClusterMode
    AgentAddress     string
    KubeconfigSecret string
    ServiceAccount   string
    Server           string
}
```

Used at `Stage.Spec.Cluster` and `ApplicationPromotionStage.Cluster`
(`api/pipelines/v1alpha1/application_types.go:281`).

**Two concrete mismatches implementers must know:**

1. **`ClusterSpec` has no `agentAddress` field, but `docs/guides/multi-cluster.md:50` documents
   `spec.agentAddress` for agent-mode Cluster CRs.** The doc is wrong. Only the inline `ClusterRef` has
   `AgentAddress`. An agent-mode `Cluster` CR literally cannot carry its agent's address today; the
   hub falls back to the `{name}.{namespace}.svc.cluster.local:8083` guess.
2. `ReleaseReconciler.resolveClusterRef` (`release_controller.go:1277-1298`) copies `KubeconfigSecret`,
   `Server` and `ServiceAccount` from the `Cluster` CR onto the ref — **but not `Mode`.** So a
   `Cluster` with `mode: agent` referenced by a `Stage` that omits `mode` will *not* route through the
   agent; it falls through to direct apply. Any ListClusters work that surfaces "mode" should be aware
   the effective mode is the Stage's, not the CR's.

Resolution helper: `internal/governance/cluster_resolver.go` — `ClusterServerResolver.ResolveServer`
(line 28) returns `ref.Server` → `Cluster.Spec.Server` → `"https://kubernetes.default.svc"`.

### 2.3 `fleet.ClusterSummary` — the projected, API-facing shape

`internal/fleet/model.go:186-192`:

```go
type ClusterSummary struct {
    Identity    ClusterKey        // = types.NamespacedName
    DisplayName string
    Connection  ConnectionState
}
```

Only **three** fields. Deliberately minimal — the comment at :186-187 says connection configuration and
Secret refs are excluded on purpose.

Projection: `internal/fleet/connection_projection.go:34-58` `projectClusterSummary`:

- `DisplayName = TrimSpace(spec.displayName)`, falling back to `cluster.Name`.
- `spec.Disabled || phase == Disabled` → `ConnectionStateDisabled`
- `phase == Healthy` → `ConnectionStateHealthy`
- `phase == Unhealthy` → `ConnectionStateUnhealthy`
- `phase == Pending` (and anything else) → `ConnectionStateUnspecified` (zero)

`ConnectionState` enum: `internal/fleet/model.go:120-128`
(`Unspecified/Healthy/Unhealthy/Disabled/NotConfigured`).

Per-application cluster projection: `projectStageConnection` (:74-116) builds
`StageTargetSummary{StableID, Stage, Ring, Cluster ClusterKey, ClusterLabel, Health, ClusterConnection,
UnmanagedInlineCluster}` (model.go:131-140). A named `ClusterRef` that *also* carries inline connection
fields is failed closed to `Unhealthy` (:99-104); a nameless ref becomes label `inlineClusterLabel` +
`NotConfigured` (:86-90). `hasInlineClusterConfiguration` is at :118.

---

## 3. Where cluster state is held

Four layers, in order:

1. **etcd / the `Cluster` CR** — source of truth. CRD YAML at
   `config/crd/bases/clusters.paprika.io_clusters.yaml` and
   `charts/chart/templates/crd/clusters.clusters.paprika.io.yaml`.
2. **controller-runtime informer cache** — warmed in *both* runtimes:
   - operator: `mgr.GetCache()` (fleet store built at `cmd/main_operator.go:230`)
   - api server: `cmd/main.go:createAPICacheBundle` :939 — `warmObjects` includes
     **`&clustersv1alpha1.Cluster{}` at line 961**, and the returned `client.Client` is cache-backed
     (`client.CacheOptions{Reader: apiCache}`, :971-975). **So the API server can already `List` Clusters
     from cache with no new plumbing.**
3. **fleet index snapshot** — `internal/fleet/snapshot.go:13-34`:
   - `Clusters map[ClusterKey]ClusterSummary` (line 18)
   - `ByCluster map[ClusterKey]IDSet` (line 23) — inverted index cluster → set of application IDs
   Rebuilt from `store.ListClusters` (`internal/fleet/rebuild.go:546`, projection at :640-653, incremental
   at :887). Store contract: `internal/fleet/store.go:31-32`
   (`ListClusters`/`GetCluster`), implemented by `CacheStore` at
   `internal/fleet/store_cache.go:153` and `:165`. `ResourceCluster` is one of the seven watched kinds
   (`store.go:46`; informer registered at `internal/fleet/runtime.go:124`).
   Snapshot editor ops: `upsertCluster` (`snapshot.go:500`), delete (`:511`).
4. **`ClusterConnectionPool`** in-memory per-controller-process (see §1.5). Unexported, unexposed.

---

## 4. What is exposed over the API today

**There is no `Cluster` message and no `ListClusters`/`GetCluster` RPC.**
`rg '^type Cluster' internal/api/paprika/v1/*.go` → **no matches.** The 41 RPCs are at
`proto/paprika/v1/api.proto:1146-1186`; none of them is cluster-oriented.
`cmd/paprika` (the CLI) has **no cluster command**.

Clusters surface *only* as identity + label + connection state inside the fleet surface:

| Proto | Line | Content |
|---|---|---|
| `FleetObjectKey{namespace,name}` | ~970 | the only cluster identity type |
| `FleetFilter.clusters` | 978 | `repeated FleetObjectKey` |
| `StageTargetSummary.cluster` / `.cluster_label` / `.cluster_connection` / `.unmanaged_inline_cluster` | 991-995 | per-stage target |
| `ApplicationSummary.current_cluster` / `.current_cluster_label` | 1003-1004 | |
| `FleetConnectionState` enum | ~957 | UNSPECIFIED/HEALTHY/UNHEALTHY/DISABLED/NOT_CONFIGURED |
| `FLEET_SORT_FIELD_CLUSTER = 3` | 903 | |
| `FLEET_GROUP_DIMENSION_CLUSTER = 2` | 924 | matrix axis |
| `FLEET_FACET_DIMENSION_CLUSTER = 3` | 939 | **facet counts per cluster** |

Served by `internal/api/fleet_handler.go` (filter decode :227/:261, sort :470, group :512,
summary conversion :557-591, facet dimension :859) and `internal/api/system_status_handler.go`
via RPCs `QueryApplications`, `QueryFleetMap`, `QueryFleetMatrix`, `GetSystemStatus`
(`api.proto:1183-1186`).

Facet machinery that already yields **per-cluster application counts**:
`internal/fleet/facets.go:143 clusterFacetBuckets` + `:159 clusterLabel` (label from
`Snapshot.Clusters[key].DisplayName`, else `key.Name`).

Consequence for the console: the UI can already colour a cluster chip by health and count apps per
cluster, but **cannot list clusters that have zero applications**, cannot show a k8s version, and cannot
show anything about an agent.

---

## 5. Where `ListClusters` / `GetCluster` would draw from, and what it can honestly report today

### 5.1 Recommended source: `PaprikaServer.client`

`internal/api/server.go:94-110` — `PaprikaServer` already holds:
`client client.Client` (cache-backed, Cluster informer warmed), `k8sClient kubernetes.Interface`,
`dynamicClient`, `restMapper`, `fleetIndex fleet.Reader`, `authorizer`, `Auditor`, `Clock`.

**Template to copy: `ListPolicies` (`internal/api/server.go:504-527`)** — the other cluster-scoped,
non-project-scoped list. It is 24 lines: `s.client.List(ctx, &list)` → map → `recordAPIList` →
`connect.NewResponse`.

For a `GetCluster` on a *specific* cluster, `s.client.Get(ctx, client.ObjectKey{...}, &cluster)`.

Optional enrichment source: `s.fleetIndex.LoadSnapshot()` → `Snapshot.Clusters` and `Snapshot.ByCluster`
(both exported fields). Use `ByCluster[key]` for a live application count. Note `fleet.Reader`
(`internal/fleet/reader.go:11-21`) exposes `ProjectKeys`, `QueryApplications`, `QueryMap`, `QueryMatrix`,
`LoadSnapshot`, `CheckReady` — `LoadSnapshot` is the door in.

### 5.2 Honest field-by-field verdict for a `Cluster` proto message

**Available now, zero new collection:**

| Proto field | Source |
|---|---|
| `namespace`, `name` | `ObjectMeta` |
| `display_name` | `spec.displayName` (fallback `metadata.name`) |
| `mode` | `spec.mode` (enum direct/agent/in-cluster) |
| `server` | `spec.server` |
| `service_account` | `spec.serviceAccount` |
| `labels` | `spec.labels` (free-form map) |
| `disabled` | `spec.disabled` |
| `connection_timeout`, `health_check_interval`, `health_check_timeout` | `spec.*` (strings) |
| `created_at` | `metadata.creationTimestamp` |
| `phase` | `status.phase` |
| `conditions[]` | `status.conditions` (type/status/reason/message/lastTransitionTime/observedGeneration) |
| `observed_generation` | `status.observedGeneration` |
| `last_health_check_time` | `status.lastHealthCheckTime` — **this is the honest "last seen"** |
| `kubernetes_version` | `status.version` (GitVersion). **Empty for agent-mode and for never-reconciled clusters — must be `optional`/allowed-empty in the UI.** |
| `connection_state` | reuse the existing `FleetConnectionState` enum via `fleet.projectClusterSummary`'s exact mapping (or re-derive from phase) |
| `application_count` | `len(fleetIndex.LoadSnapshot().ByCluster[key])` |
| `stage_target_count` | walk `Snapshot.Applications[*].Targets` where `Target.Cluster == key` (same walk `clusterFacetBuckets` does) |

**Declared but always empty (do not ship as if populated):**

- `agent_info.version`, `agent_info.connected`, `agent_info.address` — the struct exists
  (`cluster_types.go:60-64`) and is in the CRD, but **has no writer anywhere in the repo.**

**Absent entirely — requires NEW collection:**

- `node_count`, `region`/`zone`, cloud provider
- `pod_count`, `namespace_count`
- CPU / memory `allocatable`, `requested`, `used`
- monthly cost
- connection latency / RTT, request rate, error rate
- agent last-seen / agent version

### 5.3 Cheapest honest paths to the missing fields (for the implementer)

1. **node count + region — lowest cost by far.** `ClusterReconciler.checkHealth`
   (`cluster_controller.go:144-169`) *already builds a `kubernetes.Clientset` against the target cluster
   every 30s*. One extra `cli.CoreV1().Nodes().List(ctx, metav1.ListOptions{})` in that same function gives:
   - `len(items)` → `status.nodeCount`
   - `items[i].Labels["topology.kubernetes.io/region"]` (and `.../zone`) → `status.region`
   - `sum(items[i].Status.Allocatable[cpu|memory])` → allocatable capacity
   - `items[i].Status.NodeInfo.KubeletVersion` → per-node version skew
   Add `NodeCount int32`, `Region string`, `AllocatableCPU/AllocatableMemory resource.Quantity` to
   `ClusterStatus`. **Caveat: the target cluster's credential (kubeconfig SA / agent SA) needs
   `nodes: get;list` RBAC — `rg 'Nodes()'` finds no node access anywhere in the repo today, and no chart
   role grants it. This is a remote-cluster RBAC change, not a hub one.**
2. **requested / used CPU+memory** — needs either `metrics.k8s.io` (metrics-server) or a Prometheus query
   client. **Neither exists in the repo.** `internal/analysis/analysis.go` is HTTP probes +
   pod restart/status counting via `kubernetes.Interface` (`checkRestartRate` :177,
   `checkPodStatusRate` :206) — no PromQL client, no metrics API client. This is genuinely new work.
   `internal/fleet/optional_source.go:16-32` defines an `OptionalSourceProjector` /
   `OptionalSourceStore` seam explicitly reserved for "a later observability plan" — that is the
   architecturally sanctioned hook for golden-signal / capacity data, and it is currently supplied `nil`.
   `ApplicationSummary.EffectiveObservabilitySource` / `ObservabilityConnection`
   (`model.go:163-168`, proto :1018-1019) are the already-wired output slots.
3. **agent liveness / `AgentInfo`** — `agentclient.ControllerClient.Health()` already exists and is
   unused. Wiring the agent branch of `Reconcile` (`cluster_controller.go:79-81`) to call it and stamp
   `Status.AgentInfo{Address, Connected: now}` + Phase Healthy/Unhealthy is a small, self-contained change
   that fixes the permanent-`Pending` bug and populates the existing schema. It needs an address, which
   requires **adding `spec.agentAddress` to `ClusterSpec`** (see §2.2 mismatch #1) or accepting the
   `{name}.{namespace}.svc.cluster.local:8083` convention.
4. **connection latency / circuit state** — already computed in `ClusterConnectionPool`
   (`pooledClient.healthy/failures/circuitOpen/circuitOpenAt/lastUsed`). Exposing it needs an accessor
   on the pool plus a way to map kubeconfig-hash → cluster name (today the pool is keyed by hash only,
   so a `name` field on `pooledClient` would have to be added at `createAndCacheClient`, line 195).

### 5.4 RBAC and authorization notes

- **Hub RBAC is already sufficient to read Clusters.** `charts/chart/templates/rbac/manager-role.yaml:212-214`
  grants `clusters.paprika.io/clusters`, `:253-259` covers `clusters/finalizers` and `clusters/status`.
  The api-server deployment uses the same ServiceAccount
  (`charts/chart/templates/api-server/deployment.yaml:175` → `paprika.serviceAccountName`).
  Aggregated viewer/editor/admin roles exist at `rbac/clusters-cluster-{viewer,editor,admin}-role.yaml`.
- **There is no `clusters` authz Resource.** `internal/api/auth/authz.go:22-30` enumerates exactly:
  `applications, pipelines, releases, stages, templates, artifacts, rollouts`.
  A `ListClusters` RPC must either add `ResourceClusters Resource = "clusters"` (and update the RPC→resource
  map at `internal/api/auth/middleware.go:240-252`) or reuse `ResourceApplications`.
- **Clusters are not project-scoped, so there is no natural tenant filter.** `fleet.QueryScope`
  (`internal/fleet/filter.go:29-32`) is `{Projects ProjectSet, CapabilitiesByProject map[ProjectKey]CapabilitySet}`
  — project only. The fleet handler leaks-proofs cluster labels by filtering the *applications* a caller can
  see (see `fleet_handler_test.go:581-605`, and `system_status_handler_test.go:172-214` which asserts
  `secret-cluster-marker`/`secret-cluster-label-marker` never appear in an unauthorized response).
  **A flat `ListClusters` would be the first RPC to expose cluster names outside that project shield.**
  Safe default: derive the visible cluster set from `Snapshot.ByCluster` intersected with the caller's
  authorized application IDs, and only fall back to a raw `ClusterList` for admins.

---

## 6. The three packages the task named that are *not* about target clusters

### `internal/coordinator` — hub replica membership ring (Redis)

`internal/coordinator/coordinator.go`:

- Keys: `paprika:coordinator:replicas` (Redis SET of pod names, :23) and
  `paprika:coordinator:heartbeat:<pod>` (:24, TTL).
- `DefaultHeartbeatInterval = 15s`, `DefaultHeartbeatTTL = 30s` (:17-18).
- `type Coordinator struct` (:26-41): `client redis.UniversalClient`, `self string` (pod name),
  `ring *Ring`, `heartbeatInterval`, `heartbeatTTL`, `ctx/cancel/wg`, `healthy bool`, `mu`, `events chan struct{}`.
- `Join` (:71) SADDs self + SETs heartbeat, degrades gracefully on Redis failure (:76-82).
  `Leave` (:97) DELs heartbeat + SREMs, then sleeps 2s. `Healthy` (:111). `Events()` (:121).
- `syncRing` (:125) SMEMBERs, drops members whose heartbeat key has expired, `ring.Rebuild(clean)`,
  sets `metrics.CoordinatorReplicas`.
- `heartbeatLoop` (:163) — jittered ticker; on failure sets `healthy=false` and bumps
  `metrics.CoordinatorHeartbeatFailuresTotal`; on success records `metrics.CoordinatorHeartbeatSeconds`.
- `internal/coordinator/ring.go` — FNV-1a consistent hash, **16 virtual nodes** (`defaultReplicas`, :22),
  `Lookup(key)` (:36), `Members()` (:52), `Rebuild()` (:68).
- `internal/coordinator/shard_filter.go` — `RingShardFilter{ring, self}`; `Matches(namespace)` (:16)
  returns true when the ring is empty (fail-open) else `owner == self`.
- Wired at `cmd/main_operator.go:272-284` (`NewCoordinator(client, podName, ...)`,
  `deps.shardFilter.SetMatcher(coordinator.NewRingShardFilter(c.Ring(), podName))`, re-set on ring events).

**This is the only heartbeat/liveness ring in the codebase. Do not mistake it for cluster connectivity —
its members are Paprika controller pods, and its hash key is a Kubernetes *namespace*.** (It would,
separately, make a decent honest source for a "control plane replicas" tile in the console.)

### `internal/sharding` — env-var namespace-hash shard filter

`internal/sharding/sharding.go`: env `PAPRIKA_SHARD_ID`, `PAPRIKA_SHARD_TOTAL`, `POD_NAME` (:14-18).
`Matcher` interface (:22-24) — the seam `RingShardFilter` plugs into. `Filter` (:27-33) with
`Matches(namespace)` (:97) = `hashNamespace(ns) % totalShards == shardID` unless a `Matcher` overrides.
`extractOrdinalFromPodName` (:136) handles StatefulSet `controller-manager-0`. Nothing cluster-related.

### `internal/mtls` — 29 lines, hub-to-hub only

`internal/mtls/mtls.go`: `EnabledEnv = "PAPRIKA_MTLS_ENABLED"`, `CertEnv = "PAPRIKA_TLS_CERT"`,
`KeyEnv = "PAPRIKA_TLS_KEY"` (:7-14); `ServingConfig() (cert, key string, enabled bool)` (:19).
Callers: `cmd/main.go:1132` (inside `serveListener`, :1129) and `internal/reposerver/server.go:174`.
Chart wiring: `charts/chart/templates/extras/mtls.yaml` plus `{{ if .Values.mtls.enabled }}` blocks in
the manager / api-server / repo-server / webhook-receiver deployments.
**The agent server does not use it** — `agentserver.Run` (:577) is unconditional plaintext, and
`applyViaAgent` dials `http://`. Cross-cluster manifest delivery in agent mode is unencrypted today.

---

## 7. One-paragraph summary for the implementer

Clusters are modelled as a namespaced `Cluster` CRD with 9 spec fields and 6 status fields; the hub always
dials out (in-cluster SA, kubeconfig Secret, or plain-HTTP POST to a DaemonSet agent on :8083), and nothing
ever registers itself. A single reconciler polls every 30s and records `phase`, `conditions`,
`lastHealthCheckTime` and the k8s `GitVersion` — except in agent mode, where it hard-returns
`Pending/AwaitingAgent` and records nothing, and where the declared `status.agentInfo` struct has no writer
at all. The fleet index already projects each cluster down to `{Identity, DisplayName, Connection}` plus a
cluster→applications inverted index, and that is the entirety of what any RPC exposes today. A
`ListClusters`/`GetCluster` RPC modelled on `ListPolicies` can be written against the already-warmed
cache-backed `client.Client` and can honestly return identity, display name, mode, server, labels,
disabled, phase, conditions, last-health-check time, k8s version and an application count — but **not**
node count, region, pod counts, capacity, cost, latency or agent liveness, all of which require new
collection. The cheapest genuine win is adding a `Nodes().List` to the existing per-reconcile clientset
(node count + region + allocatable) and wiring the already-written-but-never-called
`agentclient.Health()` into the agent branch so agent-mode clusters stop being permanently `Pending`.

# Application Workspace and Multi-Cluster Gateway Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Application detail into a stage-aware operations workspace whose resource, event, log, activity, and investigation evidence always comes from the selected stage's real target cluster.

**Architecture:** A shared fail-closed `clusteraccess.Resolver` gives deployment, governance, and read paths one ClusterRef interpretation, while a pooled direct-client bundle and mTLS-authenticated agent transport implement the two remote access modes. Authorized API handlers call an `ApplicationResourceGateway` only after AppProject checks; it deterministically resolves Application→Stage→Cluster and supplies lazy evidence to additive overview/activity RPCs and the tabbed static Next.js workspace.

**Tech Stack:** Go 1.26.0, controller-runtime/client-go, Connect RPC/protobuf, Paprika mTLS/cert-manager, OpenTelemetry, Helm, Next.js 16, React 19, TypeScript, TanStack Query, Vitest/Testing Library, kind, Playwright.

**Approved spec:** `docs/superpowers/specs/2026-07-11-enterprise-operations-console-design.md`

**Prerequisite:** Complete `docs/superpowers/plans/2026-07-11-enterprise-fleet-console.md`; this plan reuses its `ApplicationSummary`, URL scope codec, operations shell, TanStack Query setup, and Playwright harness.

**Execution skills:** `@superpowers:test-driven-development`, `@frontend-development`, `@vercel-react-best-practices`, `@security-best-practices`, and `@superpowers:verification-before-completion`.

---

## Chunk 1: Stage-Aware Application Operations

### File structure

- `internal/clusteraccess/resolver.go` — the only strict/legacy ClusterRef interpretation and typed resolution errors.
- `internal/clusteraccess/legacy.go` — the single connection-mode validator and `SufficientLegacyInline` predicate shared by runtime resolution, admission, and upgrade audit.
- `internal/clusteraccess/direct_pool.go` — bounded direct-cluster bundles containing REST config, dynamic client, typed clientset, discovery, and REST mapper.
- `internal/clusteraccess/warnings.go` — one-release compatibility warning condition, audit, and OTel recording.
- `internal/applicationgateway/stage_resolver.go` — deterministic Application→generated Stage ownership validation.
- `internal/applicationgateway/desired_bundle.go` — selected-stage Release/snapshot loading and the only projection of desired roots/status into live evidence.
- `internal/applicationgateway/gateway.go` — transport-neutral resource/event/log/investigation interface and routing.
- `internal/applicationgateway/direct_transport.go` — target-cluster client-go evidence operations.
- `internal/applicationgateway/agent_transport.go` — Connect client backed by verified Paprika mTLS.
- `internal/api/application_overview_handler.go` — cheap current-state synthesis only.
- `internal/api/application_activity_handler.go` — bounded, normalized, coverage-aware Application timeline.
- `internal/activity/` — shared normalization, authorization-scoped query, coverage, deduplication, and cursor logic for Application/global timelines.
- `ui/src/components/applications/workspace/` — focused tabs under the existing Application deep link.
- `hack/kind-multicluster.sh` and `test/e2e/application_resource_gateway_test.go` — two-cluster no-fallback acceptance gate.

### Compatibility invariants

- Keep `/dashboard/application?namespace=<ns>&name=<name>` and every existing resource RPC wire-compatible; `stage` is an additive optional field and blank means the deterministic default stage.
- The browser owns only a stage name. It never supplies an independently editable cluster identity.
- Authorization of the Application's AppProject happens before Stage or Cluster lookup, so resolution errors cannot disclose unauthorized cluster identities.
- A strict named ClusterRef never reuses inline fields and never falls back to the API server's control-plane client.
- Direct mode requires a kubeconfig Secret; its REST config is always Secret-derived. `server` may override only that cloned Secret-derived config. In-cluster mode is the only mode allowed to use the control-plane REST config.
- A name-empty/all-inline-empty reference means the control-plane in-cluster target. An unchanged name-empty inline reference remains a deprecated, visibly unmanaged legacy target.
- `clusters.allowLegacyNamedInlineFallback` is one-release-only. It may recover a missing named Cluster only when the legacy inline data is sufficient; it never bypasses Disabled/Unhealthy Cluster status and records a warning condition, audit event, and metric every time it is used.
- `SufficientLegacyInline` has one definition matching old usable shapes: direct accepts empty/`direct` mode, requires a kubeconfig Secret, forbids agent address, and permits an optional HTTPS server/service account; agent accepts empty/`agent` mode, requires an HTTPS agent address, and forbids server/kubeconfig/service account; named in-cluster fallback is never sufficient. With the flag enabled, named-plus-inline plus a Healthy Cluster uses the Cluster CR only, ignores inline fields, and warns; a missing Cluster may use only a sufficient inline direct/agent definition. Disabled/Unhealthy Clusters never fall back.
- Metrics are additive OTel instruments through the existing `paprika` meter. Do not introduce a direct Prometheus client.

### Task 1: Add the strict shared Cluster resolver and migration policy

**Files:**
- Create: `internal/clusteraccess/resolver.go`
- Create: `internal/clusteraccess/resolver_test.go`
- Create: `internal/clusteraccess/legacy.go`
- Create: `internal/clusteraccess/legacy_test.go`
- Create: `internal/clusteraccess/warnings.go`
- Create: `internal/clusteraccess/warnings_test.go`
- Modify: `api/clusters/v1alpha1/cluster_types.go`
- Modify: `api/clusters/v1alpha1/zz_generated.deepcopy.go` (generated)
- Generated: `config/crd/bases/clusters.clusters.paprika.io_clusters.yaml`
- Generated: `charts/chart/templates/crd/clusters.clusters.paprika.io.yaml`
- Modify: `internal/governance/cluster_resolver.go`
- Modify: `internal/governance/cluster_resolver_test.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/pipelines/release_controller_unit_test.go`
- Modify: `internal/controller/pipelines/release_controller_test.go`
- Modify: `cmd/main_controllers.go`
- Modify: `internal/metrics/otel.go`

- [ ] **Step 1: Write the resolver's failing truth-table tests**

Cover all connection modes and assert the source of every resolved field:

| Reference | Compatibility flag | Expected |
|---|---:|---|
| name empty, all inline empty | either | in-cluster target |
| name empty, usable inline | either | `LegacyInline`, `Managed=false` |
| name set, inline empty, Healthy Cluster | either | Cluster CR only |
| name set, inline empty, missing/Disabled/Unhealthy Cluster | either | typed fail-closed error |
| name set, any inline, flag disabled | false | `ErrAmbiguousClusterRef` |
| name set, sufficient inline plus Healthy Cluster, flag enabled | true | Cluster CR only, inline ignored, compatibility warning |
| name set, missing Cluster plus sufficient direct/agent inline, flag enabled | true | legacy fallback plus compatibility warning |
| name set, missing Cluster plus insufficient inline | true | typed fail-closed error |

Also prove that `SufficientLegacyInline` implements the exact compatibility invariant above, the Secret namespace/key come from `Cluster.spec.kubeconfigSecretRef`, not `ClusterRef.namespace`, direct mode without a kubeconfig Secret is invalid, and agent/in-cluster modes reject direct-only fields. Set `ServiceAccountNamespace` to the Stage/Application namespace; `Cluster.spec.serviceAccount` is a target service-account name, not a namespace selector.

- [ ] **Step 2: Run the resolver tests and confirm they fail**

Run: `rtk go test ./internal/clusteraccess -run TestResolver -count=1`

Expected: FAIL because `Resolver`, `ResolvedCluster`, and typed errors do not exist.

- [ ] **Step 3: Implement focused resolution types**

Use this public boundary; callers must not inspect `ClusterRef` after resolution:

```go
type Options struct {
    AllowLegacyNamedInlineFallback bool
}

type ResolvedCluster struct {
    Identity             types.NamespacedName
    Mode                 pipelinesv1alpha1.ClusterMode
    Server               string
    AgentAddress         string
    KubeconfigSecret     *clustersv1alpha1.SecretRef
    ServiceAccount       string
    ServiceAccountNamespace string
    Managed              bool
    LegacyInline         bool
    CompatibilityWarning string
}

type Resolver struct {
    reader  client.Reader
    options Options
}
```

Add `AgentAddress string \`json:"agentAddress,omitempty"\`` to `ClusterSpec`. For named references, default only the Cluster CR namespace from the Stage namespace, require `status.phase=Healthy`, source all connection data from the Cluster CR, and set `ServiceAccountNamespace` from the Stage namespace. Put connection-shape validation and `SufficientLegacyInline` in `legacy.go`; resolver, webhook, and audit must call it rather than recreating mode checks. Clone objects/results so callers cannot mutate cache entries.

- [ ] **Step 4: Add failing compatibility-recorder tests**

Use fake `audit.Auditor`, status writer, and OTel test reader. Assert one compatibility use sets `LegacyClusterFallback=True` on the Stage, emits action `legacy-cluster-fallback` without credentials, and increments `paprika.cluster.resolution.legacy_fallback` with mode only. Assert strict success emits none of them. The recorder is idempotent for the condition but emits audit/metric visibility on every runtime use as required.

- [ ] **Step 5: Implement warning recording and adapt deployment/governance**

Return warnings as data from `Resolve`; do not log inside the pure resolver. Add `WarningRecorder.Record(ctx, stage, resolved)` and invoke it in Release deployment and gateway paths. Replace `ReleaseReconciler.resolveClusterRef` and `governance.ClusterServerResolver` with adapters around the shared resolver. Inject the same configured resolver from `cmd/main_controllers.go`; delete the old merge-on-not-found method.

- [ ] **Step 6: Run strict resolver and existing deployment/governance suites**

Run: `rtk go test ./internal/clusteraccess ./internal/governance ./internal/controller/pipelines -run 'Test(Resolver|ResolveCluster|Release)' -count=1`

Expected: PASS; missing named Clusters and ambiguous named-inline references no longer reach a dynamic client.

- [ ] **Step 7: Regenerate deepcopy code and commit**

Run: `rtk make generate manifests`

Expected: generated deepcopy and both shipped Cluster CRD schemas include `spec.agentAddress`; protobuf output is otherwise unchanged.

```bash
rtk git add api/clusters/v1alpha1/cluster_types.go api/clusters/v1alpha1/zz_generated.deepcopy.go config/crd/bases/clusters.clusters.paprika.io_clusters.yaml charts/chart/templates/crd/clusters.clusters.paprika.io.yaml internal/clusteraccess/resolver.go internal/clusteraccess/resolver_test.go internal/clusteraccess/legacy.go internal/clusteraccess/legacy_test.go internal/clusteraccess/warnings.go internal/clusteraccess/warnings_test.go internal/governance/cluster_resolver.go internal/governance/cluster_resolver_test.go internal/controller/pipelines/release_controller.go internal/controller/pipelines/release_controller_unit_test.go internal/controller/pipelines/release_controller_test.go internal/metrics/otel.go cmd/main_controllers.go
rtk git commit -m "feat(clusters): enforce strict shared cluster resolution"
```

### Task 2: Build fail-closed direct cluster client bundles

**Files:**
- Create: `internal/clusteraccess/direct_pool.go`
- Create: `internal/clusteraccess/direct_pool_test.go`
- Modify: `internal/controller/pipelines/cluster_pool.go`
- Modify: `internal/controller/pipelines/cluster_pool_test.go`
- Modify: `internal/controller/pipelines/cluster_client_manager.go`
- Modify: `internal/controller/clusters/cluster_controller.go`
- Modify: `internal/controller/clusters/cluster_controller_test.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Write failing bundle and credential tests**

Assert one cache entry yields a cloned `*rest.Config`, `dynamic.Interface`, `kubernetes.Interface`, discovery client, and REST mapper. Cover custom `SecretRef.key`, Secret namespace, HTTPS server override, service-account impersonation, UID/resourceVersion cache invalidation, TTL/circuit breaking, and concurrent single creation. Assert direct-without-Secret, missing key, invalid kubeconfig, forbidden Secret, and non-HTTPS override all return an error without reading or cloning the default config. Assert only `ModeInCluster` returns the default bundle and every returned config is a clone.

- [ ] **Step 2: Run and confirm failure**

Run: `rtk go test ./internal/clusteraccess -run 'TestDirect(Pool|Bundle)' -count=1`

Expected: FAIL because `DirectPool` and `ClientBundle` do not exist.

- [ ] **Step 3: Implement the bundle cache**

```go
type ClientBundle struct {
    Config     *rest.Config
    Dynamic    dynamic.Interface
    Kubernetes kubernetes.Interface
    Discovery  discovery.DiscoveryInterface
    Mapper     meta.RESTMapper
}

func (p *DirectPool) Bundle(ctx context.Context, cluster ResolvedCluster) (*ClientBundle, error)
```

Use the configured Secret key, defaulting only an empty key to `kubeconfig`. For direct mode, parse and clone only the Secret-derived config before applying the optional HTTPS `Server`; never use `defaultConfig` as a direct-mode credential source. Apply `Impersonate.UserName = "system:serviceaccount:<ServiceAccountNamespace>:<ServiceAccount>"` only when both resolved fields are non-empty. In-cluster mode clones `defaultConfig` and rejects Secret/server/agent/service-account fields. Key the cache by connection identity plus Secret UID/resourceVersion, server, service-account namespace/name, and mode. Keep the existing five-minute TTL/circuit-breaker semantics and stop health workers with the parent context.

- [ ] **Step 4: Make controllers consume the shared pool**

Adapt the existing `ClusterConnectionPool` interfaces so Release and Application reconciliation obtain the dynamic member of the shared bundle. For Pending direct-cluster health, validate the Cluster's own connection definition and create a candidate `ResolvedCluster` directly; do not call the runtime resolver that requires Healthy status. Obtain the same bundle and call discovery `ServerVersion` with its configured timeout: success sets `status.phase=Healthy`, while Secret/config/auth/connectivity failures set Unhealthy. It must not retry with the default in-cluster config. Do not leave a second Secret parser behind.

- [ ] **Step 5: Run unit and race tests**

Run: `rtk go test ./internal/clusteraccess ./internal/controller/clusters ./internal/controller/pipelines -run 'Test(Direct|ClusterConnectionPool|ClusterReconciler)' -count=1`

Run: `rtk go test -race ./internal/clusteraccess -count=1`

Expected: PASS; race detector reports no duplicate-map or stale-bundle access.

- [ ] **Step 6: Commit direct access**

```bash
rtk git add internal/clusteraccess/direct_pool.go internal/clusteraccess/direct_pool_test.go internal/controller/clusters/cluster_controller.go internal/controller/clusters/cluster_controller_test.go internal/controller/pipelines/cluster_pool.go internal/controller/pipelines/cluster_pool_test.go internal/controller/pipelines/cluster_client_manager.go cmd/main_controllers.go
rtk git commit -m "feat(clusters): pool complete direct client bundles"
```

### Task 3: Establish authenticated, externally reachable agent transport

**Files:**
- Modify: `internal/mtls/mtls.go`
- Modify: `internal/mtls/mtls_test.go`
- Modify: `internal/agent/server/server.go`
- Create: `internal/agent/server/security_test.go`
- Modify: `internal/webhook/clusters/v1alpha1/cluster_webhook.go`
- Create: `internal/webhook/clusters/v1alpha1/cluster_webhook_test.go`
- Modify: `cmd/main.go`
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/extras/mtls.yaml`
- Modify: `charts/chart/templates/agent/daemonset.yaml`
- Modify: `charts/chart/templates/agent/service.yaml`
- Modify: `charts/chart/templates/networkpolicy/agent.yaml`

- [ ] **Step 1: Write the certificate-identity tests**

Generate a CA plus certificates with explicit EKUs and URI SANs. Accept only client certificates with `clientAuth` and URI `spiffe://paprika.io/component/controller-manager` or `spiffe://paprika.io/component/api-server`; reject a valid CA-signed repo-server URI, missing/wrong EKU, untrusted CA, and expired certificate. On the client, require `serverAuth` and verify the DNS/IP SAN parsed from `Cluster.spec.agentAddress`.

- [ ] **Step 2: Run the identity tests red**

Run: `rtk go test ./internal/mtls ./internal/agent/server -run 'Test(MTLS|AgentPeerIdentity)' -count=1`

Expected: FAIL because current serving config neither requires client certificates nor authorizes a peer identity.

- [ ] **Step 3: Implement strict agent TLS only**

Add `PAPRIKA_TLS_CA` plus client/server config builders. Agent server config uses TLS 1.2 minimum, `RequireAndVerifyClientCert`, verified chains, client-auth EKU, and an explicit URI allowlist; generic split-plane servers retain their existing compatibility behavior. Agent mode fails startup for incomplete CA/cert/key unless `PAPRIKA_AGENT_ALLOW_INSECURE=true` is explicitly set for test/development. Never add bearer or plaintext fallback.

- [ ] **Step 4: Add external identity configuration tests**

Test generated agent certificates with Service DNS names plus `agent.tls.dnsNames`/`ipAddresses`, externally supplied `agent.tls.certSecret`/`caSecret`, and URI SANs on controller/API certificates. Test Cluster admission with the shared connection validator: agent mode requires an HTTPS address and forbids direct fields; direct requires a kubeconfig Secret and forbids agent address; in-cluster forbids all connection fields.

- [ ] **Step 5: Implement certificate, Service, and NetworkPolicy configuration**

When no external cert Secret is supplied, generate the agent server certificate with `server auth`, configured DNS/IP SANs, and Service DNS SANs. Add controller/API URI SANs with `client auth`. Mount the selected CA/cert/key in agent and callers. Preserve configurable Service type/port. When NetworkPolicy is enabled, external ingress remains deny-by-default and is opened only to `agent.networkPolicy.allowedIngressCIDRs`; same-namespace probes remain allowed. Document that `agentAddress` must match a certificate SAN.

- [ ] **Step 6: Run TLS, webhook, and Helm tests green**

Run: `rtk go test ./internal/mtls ./internal/agent/server ./internal/webhook/clusters/v1alpha1 -run 'Test(MTLS|AgentPeerIdentity|Cluster)' -count=1`

Run: `rtk helm lint charts/chart && rtk helm template paprika charts/chart --set agent.enabled=true --set mtls.enabled=true --set 'agent.tls.dnsNames[0]=agent.example.com' --set 'agent.networkPolicy.allowedIngressCIDRs[0]=10.0.0.0/8' | rtk rg 'spiffe://paprika.io/component|agent.example.com|10.0.0.0/8|PAPRIKA_TLS_CA'`

Expected: tests/lint pass; only the two allowed client identities and configured external address/policy render.

- [ ] **Step 7: Commit authenticated transport**

```bash
rtk git add internal/mtls/mtls.go internal/mtls/mtls_test.go internal/agent/server/server.go internal/agent/server/security_test.go internal/webhook/clusters/v1alpha1/cluster_webhook.go internal/webhook/clusters/v1alpha1/cluster_webhook_test.go cmd/main.go charts/chart/values.yaml charts/chart/templates/extras/mtls.yaml charts/chart/templates/agent/daemonset.yaml charts/chart/templates/agent/service.yaml charts/chart/templates/networkpolicy/agent.yaml
rtk git commit -m "feat(agent): require authenticated mtls peers"
```

### Task 4: Add discovery-backed agent health and client routing

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.js`
- Generated: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generated: `ui/src/gen/paprika/v1/api_connect.js`
- Generated: `ui/src/gen/paprika/v1/api_connect.d.ts`
- Modify: `internal/agent/server/server.go`
- Create: `internal/agent/server/health_test.go`
- Create: `internal/api/agent_health_handler.go`
- Modify: `internal/agentclient/client.go`
- Create: `internal/agentclient/client_test.go`
- Modify: `internal/controller/clusters/cluster_controller.go`
- Modify: `internal/controller/clusters/cluster_controller_test.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Write failing health-contract tests**

Add tests for an additive `AgentHealth` RPC whose response contains healthy, Kubernetes version, checked-at, and a safe message. A fake discovery success is Healthy; discovery failure, timeout, invalid TLS, or address failure is Unhealthy. Prove `ListPipelines=Unimplemented` and the generic liveness `/healthz` are not accepted as cluster health. Do not invent a cluster ID from API-server addresses or Namespace reads.

- [ ] **Step 2: Run the health tests red**

Run: `rtk go test ./internal/agent/server ./internal/agentclient ./internal/controller/clusters -run 'TestAgentHealth' -count=1`

Expected: compile failure because `AgentHealth` does not exist.

- [ ] **Step 3: Add and generate the health RPC**

Append `AgentHealth` and its messages without renumbering existing fields. Also add `ManagedResourceRef{api_version,kind,namespace,name}` and repeated `managed_roots = 4` to both tree requests; this is controller-to-agent input, and the public API handler added in Task 7 always discards caller-supplied roots and derives its own DesiredBundle roots. Run `rtk make generate`, implement health with a request-scoped discovery `ServerVersion`, and make the non-agent Paprika server return `Unimplemented` in `agent_health_handler.go`. Change `agentclient.Health` to call only this RPC through the verified mTLS client.

- [ ] **Step 4: Wire Cluster health reconciliation**

Build the agent client from `spec.agentAddress`, strict TLS config, and the controller identity. Apply `spec.connectionTimeout`; success updates Healthy and `status.agentInfo`, while every connection/discovery failure sets Unhealthy. Pending health checks never go through the runtime resolver's Healthy gate.

- [ ] **Step 5: Run health tests green and commit**

Run: `rtk go test ./internal/agent/server ./internal/agentclient ./internal/controller/clusters -run 'TestAgentHealth' -count=1`

Expected: PASS with discovery failure represented as Unhealthy.

```bash
rtk git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go internal/api/agent_health_handler.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts internal/agent/server/server.go internal/agent/server/health_test.go internal/agentclient/client.go internal/agentclient/client_test.go internal/controller/clusters/cluster_controller.go internal/controller/clusters/cluster_controller_test.go cmd/main_controllers.go
rtk git commit -m "feat(agent): report discovery-backed cluster health"
```

### Task 5: Add least-privilege agent evidence slices

**Files:**
- Modify: `internal/agent/server/server.go`
- Create: `internal/agent/server/resource_test.go`
- Create: `internal/agent/server/tree_test.go`
- Create: `internal/agent/server/logs_test.go`
- Modify: `internal/agentclient/client.go`
- Modify: `internal/agentclient/client_test.go`
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/agent/daemonset.yaml`
- Create: `charts/chart/templates/rbac/agent-serviceaccount.yaml`
- Create: `charts/chart/templates/rbac/agent-role.yaml`
- Create: `charts/chart/templates/rbac/agent-rolebinding.yaml`
- Create: `test/e2e/agent_rbac_test.go`

- [ ] **Step 1: Implement GetResource red-green**

Test identity/mapping, managed/application label enforcement, bounded Events, namespace scope, and an unconditional Secret-kind denial before REST mapping. Run `rtk go test ./internal/agent/server -run TestGetResource -count=1`, implement live-only evidence, and rerun for PASS.

- [ ] **Step 2: Implement tree methods red-green**

Test managed roots supplied by the control-plane desired bundle, owner-reference child traversal, custom GVK mapping, deduplication, and detailed pod/workload readiness. Run the tree tests red, implement `GetResourceTree`/`GetResourceTreeDetailed`, and rerun green. The agent never invents desired roots or consumes Application status.

- [ ] **Step 3: Implement log methods red-green**

Test pod/container selection, limits, managed ownership, Secret denial, follow cancellation, backpressure, and slow-client cleanup. Run log tests red, implement unary/streaming methods, and rerun green.

- [ ] **Step 4: Add typed client methods red-green**

For each of the five evidence calls, assert mTLS transport, cancellation, Connect error mapping, and bounded response decoding in `client_test.go`; implement one method at a time and run its test before the next.

- [ ] **Step 5: Render an exact dedicated ClusterRole**

Use a dedicated agent ServiceAccount and cluster-wide binding by default, and automount only that ServiceAccount token into the agent pod. Grant `get/list/watch/create/delete/patch/update` only for core ConfigMaps/Services/PVCs/ServiceAccounts/Pods; apps Deployments/ReplicaSets/StatefulSets/DaemonSets; batch Jobs/CronJobs; networking Ingresses/NetworkPolicies; autoscaling HPAs; policy PDBs; Gateway API HTTPRoutes; and Istio VirtualServices. Events receive `get/list/watch/create/patch`; `pods/log` receives only `get`. Secrets, Namespaces, RBAC resources, and wildcard API/resource rules are absent. `agent.rbac.extraRules` is the explicit administrator opt-in for custom resources or Secret-bearing deployments and is documented as privilege expansion.

- [ ] **Step 6: Prove real authorization**

In `agent_rbac_test.go`, install the rendered chart in kind and run `SelfSubjectAccessReview` through the agent ServiceAccount: allowed workload reads/logs succeed; Secret get/list and RoleBinding writes fail; an `extraRules` custom-resource rule succeeds only when configured. This is the authorization gate—fake-client label tests are not treated as RBAC proof.

- [ ] **Step 7: Run unit/render checks and commit**

Run: `rtk go test ./internal/agent/server ./internal/agentclient -count=1`

Run: `rtk helm template paprika charts/chart --set agent.enabled=true | rtk rg 'pods/log|secrets|resources:|extraRules'`

Expected: unit tests pass; default agent role has no Secrets or wildcard rule. The real authorization test runs in Task 15's kind gate.

```bash
rtk git add internal/agent/server/server.go internal/agent/server/resource_test.go internal/agent/server/tree_test.go internal/agent/server/logs_test.go internal/agentclient/client.go internal/agentclient/client_test.go charts/chart/values.yaml charts/chart/templates/agent/daemonset.yaml charts/chart/templates/rbac/agent-serviceaccount.yaml charts/chart/templates/rbac/agent-role.yaml charts/chart/templates/rbac/agent-rolebinding.yaml test/e2e/agent_rbac_test.go
rtk git commit -m "feat(agent): add scoped resource evidence"
```

### Task 6: Implement deterministic Stage resolution, DesiredBundle, and the ApplicationResourceGateway

**Files:**
- Create: `internal/applicationgateway/types.go`
- Create: `internal/applicationgateway/stage_resolver.go`
- Create: `internal/applicationgateway/stage_resolver_test.go`
- Create: `internal/applicationgateway/desired_bundle.go`
- Create: `internal/applicationgateway/desired_bundle_test.go`
- Create: `internal/applicationgateway/gateway.go`
- Create: `internal/applicationgateway/gateway_test.go`
- Create: `internal/applicationgateway/direct_transport.go`
- Create: `internal/applicationgateway/direct_transport_test.go`
- Create: `internal/applicationgateway/agent_transport.go`
- Create: `internal/applicationgateway/agent_transport_test.go`
- Modify: `internal/metrics/otel.go`

- [ ] **Step 1: Write the failing Stage resolver table**

Test this exact algorithm: explicit stage; otherwise `status.currentStage`; otherwise lowest `(ring,name)` spec stage. Require the spec entry, generated Stage name `<application>-<stage>`, matching controller-owner UID, `app.paprika.io/name` label, and `Stage.spec.name`. Assert missing/mismatched data returns typed `FailedPrecondition` input and never calls a transport.

- [ ] **Step 2: Run and confirm failure**

Run: `rtk go test ./internal/applicationgateway -run TestStageResolver -count=1`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement Stage selection and the desired-state boundary**

`DesiredBundleLoader.Load(ctx, target)` is the only component allowed to turn a selected stage into desired roots/status. It loads the matching `Application.status.stages[]` entry, then that entry's Release and `Release.status.renderedManifestSnapshot` (or compatible `spec.manifestSource.configMapRef`), verifies controlling Release owner UID plus Application/project labels on the ConfigMap, and parses `manifests.yaml` into immutable `DesiredResource` roots.

```go
type DesiredBundle struct {
    Release       types.NamespacedName
    Snapshot      types.NamespacedName
    SnapshotBased bool
    IsCurrent     bool
    Resources     []DesiredResource
    Gates         []GateState
    Hooks         []HookState
}

type DesiredBundleLoader interface {
    Load(ctx context.Context, target *Target) (*DesiredBundle, error)
}
```

For the current stage, snapshot is preferred; renderer fallback is allowed only when no immutable snapshot exists and sets `SnapshotBased=false`. For a non-current stage, absent Release/snapshot is `FailedPrecondition`; global `Application.status.resources`, `resourceHealth`, `hookStatuses`, `gates`, `releaseRef`, health, sync, and rollout state are never copied. Non-current sync/health/posture is computed from desired-versus-live evidence or explicitly Unknown.

- [ ] **Step 4: Run DesiredBundle tests red, implement, and rerun green**

Run: `rtk go test ./internal/applicationgateway -run 'Test(StageResolver|DesiredBundle)' -count=1`

Expected before implementation: FAIL for missing loader. Expected after the minimal loader and owner/label checks: PASS.

- [ ] **Step 5: Define the gateway/live-transport split**

```go
type Target struct {
    Application *pipelinesv1alpha1.Application
    Stage       *pipelinesv1alpha1.Stage
    Cluster     clusteraccess.ResolvedCluster
}

type Gateway interface {
    Resolve(ctx context.Context, app *pipelinesv1alpha1.Application, stage string) (*Target, error)
    GetResource(ctx context.Context, target *Target, ref ResourceRef) (*ResourceEvidence, error)
    GetTree(ctx context.Context, target *Target, detailed bool) ([]ResourceNode, error)
    GetLogs(ctx context.Context, target *Target, ref ResourceRef, options LogOptions) (*LogResult, error)
    StreamLogs(ctx context.Context, target *Target, ref ResourceRef, options LogOptions, sink LogSink) error
    Investigate(ctx context.Context, target *Target, ref ResourceRef) (*investigator.Response, error)
    ListEvents(ctx context.Context, target *Target, options EventOptions) ([]KubernetesEvent, error)
}
```

`ResourceGateway` owns `DesiredBundleLoader`; handlers never assemble or pass roots. `GetResource` loads the bundle, asks a transport for live evidence, then merges the selected desired manifest/diff/status. `GetTree` loads the bundle and passes only its exact root identities to `Transport.GetTree`; both transports discover live children from those roots, and the gateway merges missing desired roots plus selected-stage status. The agent request's root list is produced internally by `agent_transport.go`; browser-supplied identities are never trusted. Logs and raw Events remain live-only. Use separate direct and agent `Transport` implementations. The in-cluster target deliberately uses the default `DirectPool` bundle; only deterministic resolution may select it.

- [ ] **Step 6: Write routing/no-fallback and stage-isolation tests**

Assert direct and agent calls receive the derived target and DesiredBundle roots, connection errors contain safe cluster identity/last known phase/retryability, and a direct/agent failure never invokes the in-cluster transport. For every resource/tree result, prove selecting non-current prod cannot inherit current-dev desired manifest, status, gates, hooks, health, or rollout. Handler tests must separately prove an authorization denial leaves stage resolver, DesiredBundle loader, cluster resolver, and transport call counts at zero.

- [ ] **Step 7: Implement GetResource transport red-green**

Run the `GetResource` direct/agent cases red, move only live lookup/Event collection into the transports, merge desired/diff in the gateway, and rerun those cases green.

- [ ] **Step 8: Implement GetTree transport red-green**

Run tree cases red, pass exact DesiredBundle roots to direct/agent transports, merge live children and Unknown status rules, and rerun green. No transport reads Application status.

- [ ] **Step 9: Implement logs, Events, and investigation red-green**

Move each helper only after its focused test is red. Agent transport maps to the secured client. Application Event listing gets DesiredBundle roots once, fetches bounded event evidence with fixed concurrency, deduplicates, and stops at the request limit; coverage remains best-effort. Investigation gathers live/event/log evidence through the selected transport and runs the existing registry in the control plane. Record `paprika.multicluster.request.duration` and `.errors` with operation and mode only—never Application/cluster names.

- [ ] **Step 10: Run focused and race tests**

Run: `rtk go test ./internal/applicationgateway ./internal/clusteraccess ./internal/agentclient -count=1`

Run: `rtk go test -race ./internal/applicationgateway -count=1`

Expected: PASS; every remote failure remains scoped to the selected Application section.

- [ ] **Step 11: Commit the gateway**

```bash
rtk git add internal/applicationgateway/types.go internal/applicationgateway/stage_resolver.go internal/applicationgateway/stage_resolver_test.go internal/applicationgateway/desired_bundle.go internal/applicationgateway/desired_bundle_test.go internal/applicationgateway/gateway.go internal/applicationgateway/gateway_test.go internal/applicationgateway/direct_transport.go internal/applicationgateway/direct_transport_test.go internal/applicationgateway/agent_transport.go internal/applicationgateway/agent_transport_test.go internal/metrics/otel.go
rtk git commit -m "feat(applications): add stage-aware resource gateway"
```

### Task 7: Add stage-aware RPC contracts and migrate evidence handlers one slice at a time

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.js`
- Generated: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generated: `ui/src/gen/paprika/v1/api_connect.js`
- Generated: `ui/src/gen/paprika/v1/api_connect.d.ts`
- Modify: `internal/api/server.go`
- Modify: `internal/api/resource_handler.go`
- Modify: `internal/api/resource_handler_test.go`
- Modify: `internal/api/resource_tree_handler.go`
- Modify: `internal/api/resource_tree_handler_test.go`
- Modify: `internal/api/resource_logs_handler.go`
- Modify: `internal/api/resource_logs_handler_test.go`
- Modify: `internal/api/stream_resource_logs_handler.go`
- Modify: `internal/api/stream_resource_logs_handler_test.go`
- Modify: `internal/api/investigator_handler.go`
- Modify: `internal/api/investigator_handler_test.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/cloud-run/main.go`

- [ ] **Step 1: Add compile-failing stage-routing handler tests**

For each resource/tree/log/investigation RPC, assert authorization is called before the gateway, `stage="prod"` reaches only prod, blank stage uses the deterministic default, mismatch maps to `FailedPrecondition`, connectivity maps to `Unavailable`, and permission denial does not expose Stage/Cluster details. A denial must leave Stage resolver, DesiredBundle loader, Cluster resolver, direct pool, and agent client call counts at zero. Include streaming cancellation and non-current DesiredBundle isolation cases.

- [ ] **Step 2: Run and confirm missing-contract failures**

Run: `rtk go test ./internal/api -run 'Test(GetResource|GetResourceTree|GetResourceLogs|StreamResourceLogs|Investigate).*Stage' -count=1`

Expected: compile failure because requests lack `stage` and `PaprikaServer` lacks a gateway.

- [ ] **Step 3: Extend requests additively and regenerate**

Append, without renumbering existing fields:

- `stage = 6` to `GetResourceRequest` and `InvestigateRequest`.
- `stage = 3` to `GetResourceTreeRequest`.
- `stage = 3` to `GetResourceTreeDetailedRequest`.
- `stage = 7` to `GetResourceLogsRequest`.
- `stage = 8` to `StreamResourceLogsRequest`.

Run: `cd ui && rtk npm ci`

Run: `rtk make generate`

Expected: Go/TypeScript clients expose optional stage fields and all existing field numbers remain stable.

- [ ] **Step 4: Inject gateway and record compatibility warnings in every process**

Add `WithApplicationResourceGateway`. Wire one resolver/pool/gateway and `WarningRecorder` per operator, standalone API, and Cloud Run process. Each recorder receives that process's status writer, Auditor, and OTel instruments, so compatibility use through any deployment or read path records the required condition/audit/metric. Do not construct a target before handler authorization.

- [ ] **Step 5: Migrate GetResource red-green**

Run only `TestGetResource.*Stage` red, authorize the loaded Application, call gateway resolution/evidence, remove local live/desired/Event reads from that handler, and rerun green.

- [ ] **Step 6: Migrate both tree handlers red-green**

Run only tree Stage/DesiredBundle tests red, route through the gateway-owned bundle roots, remove direct status/client use, and rerun green.

- [ ] **Step 7: Migrate unary logs red-green**

Run `TestGetResourceLogs.*Stage` red, route through the selected target, remove local client use, and rerun green.

- [ ] **Step 8: Migrate streaming logs red-green**

Run streaming Stage/cancellation tests red, route the stream through the gateway without buffering, and rerun green.

- [ ] **Step 9: Migrate investigation red-green**

Run investigation Stage tests red, collect selected-target evidence through the gateway while retaining the control-plane detector registry, and rerun green.

- [ ] **Step 10: Run handler compatibility and full API tests**

Run: `rtk go test ./internal/api -run 'Test(GetResource|GetResourceTree|GetResourceLogs|StreamResourceLogs|Investigate)' -count=1`

Run: `rtk go test ./internal/api -count=1`

Expected: PASS; pre-plan clients with blank stage retain deterministic behavior.

- [ ] **Step 11: Commit the RPC migration**

```bash
rtk git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts internal/api/server.go internal/api/resource_handler.go internal/api/resource_handler_test.go internal/api/resource_tree_handler.go internal/api/resource_tree_handler_test.go internal/api/resource_logs_handler.go internal/api/resource_logs_handler_test.go internal/api/stream_resource_logs_handler.go internal/api/stream_resource_logs_handler_test.go internal/api/investigator_handler.go internal/api/investigator_handler_test.go cmd/main.go cmd/main_operator.go cmd/cloud-run/main.go
rtk git commit -m "feat(api): route application evidence by stage"
```

### Task 8: Add cheap Application overview and shared coverage-aware activity APIs

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Create: `internal/activity/model.go`
- Create: `internal/activity/normalize.go`
- Create: `internal/activity/normalize_test.go`
- Create: `internal/activity/cursor.go`
- Create: `internal/activity/cursor_test.go`
- Create: `internal/activity/query.go`
- Create: `internal/activity/query_test.go`
- Create: `internal/api/application_overview_handler.go`
- Create: `internal/api/application_overview_handler_test.go`
- Create: `internal/api/application_activity_handler.go`
- Create: `internal/api/application_activity_handler_test.go`
- Create: `internal/api/activity_handler.go`
- Create: `internal/api/activity_handler_test.go`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.js`
- Generated: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generated: `ui/src/gen/paprika/v1/api_connect.js`
- Generated: `ui/src/gen/paprika/v1/api_connect.d.ts`

- [ ] **Step 1: Write failing contract/normalization tests**

`GetApplicationOverview` tests cover summary, selected target, latest releases/rollout, gates, resource posture, provider availability state, and capabilities without eager logs/manifests/metric ranges. Use counting fakes for authorizer, Stage resolver, DesiredBundle loader, Cluster resolver, Release/Rollout readers, source resolver, and provider checker; a denial must leave every downstream count at zero. Add current-dev/non-current-prod fixtures proving prod overview never inherits dev global health, sync, resources, gates, hooks, release, or rollout and returns selected live-derived/Unknown values. Shared activity tests cover two-hour default, seven-day maximum, 100 default/500 maximum page size, stable cursor, chronological sorting, stable source/resource/reason/timestamp deduplication, and per-source complete/best-effort coverage. `QueryActivity` tests also cover Plan-1 fleet scope and unauthorized absence from items, counts, and coverage.

- [ ] **Step 2: Run and confirm missing RPC failures**

Run: `rtk go test ./internal/activity ./internal/api -run 'Test(GetApplicationOverview|ListApplicationActivity|QueryActivity)' -count=1`

Expected: compile failure for missing shared activity package, messages, and handlers.

- [ ] **Step 3: Define and generate additive contracts**

Add all three RPCs named in the spec: `GetApplicationOverview`, `ListApplicationActivity`, and global `QueryActivity`. Overview carries Plan-1 `ApplicationSummary`, selected stage/derived cluster, releases/rollout/gates/resource posture/source availability, and explicit capabilities. Both activity responses use the same normalized items, opaque cursor, and `ActivityCoverage{source,earliest,latest,completeness}`; neither calls itself an audit log. `QueryActivityRequest` embeds the Plan-1 fleet filter plus repeated resource type/outcome, start/end, page size, and cursor.

Run: `rtk make generate`

Expected: generated handlers require both new server methods.

- [ ] **Step 4: Implement normalization and cursors red-green**

Implement `internal/activity` once. Normalize retained conditions, promotion history, Pipeline timestamps/artifacts, Rollout/analysis/gate/hook transitions, and Kubernetes Events. Mark current Pipeline state and Events `best_effort`; do not manufacture records from metrics. Run package tests after model, normalization, cursor, then query changes rather than implementing them as one batch.

- [ ] **Step 5: Implement overview authorization and selected-stage synthesis red-green**

Authorize immediately after loading the Application. Only then resolve Stage/Cluster, DesiredBundle, Release/Rollout, and source availability. Build resource posture/gates/hooks/release from DesiredBundle and selected live evidence; use global Application fields only when `bundle.IsCurrent`. Run `TestGetApplicationOverview` after each dependency is added.

- [ ] **Step 6: Implement Application activity red-green**

Authorize before any source, normalize retained selected-stage records, and add bounded target Event evidence through the gateway. A gateway error yields partial Event coverage while retained delivery history remains available.

- [ ] **Step 7: Implement global activity red-green**

Compute the Plan-1 authorized-project/Application identity set first, intersect every cached list before normalization/aggregation, and calculate coverage only from authorized items. Cap Event collection at 20 Applications/concurrency four; broader scopes report incomplete coverage rather than fleet-wide live reads.

- [ ] **Step 8: Run API tests**

Run: `rtk go test ./internal/activity ./internal/api -run 'Test(GetApplicationOverview|ListApplicationActivity|QueryActivity)' -count=1`

Expected: PASS, including stable cursor behavior and an unavailable-event-source partial response.

- [ ] **Step 9: Commit overview/activity APIs**

```bash
rtk git add proto/paprika/v1/api.proto internal/activity/model.go internal/activity/normalize.go internal/activity/normalize_test.go internal/activity/cursor.go internal/activity/cursor_test.go internal/activity/query.go internal/activity/query_test.go internal/api/application_overview_handler.go internal/api/application_overview_handler_test.go internal/api/application_activity_handler.go internal/api/application_activity_handler_test.go internal/api/activity_handler.go internal/api/activity_handler_test.go internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts
rtk git commit -m "feat(api): add application overview and activity"
```

### Task 9: Refactor Application detail into a URL-driven operations workspace

**Files:**
- Modify: `ui/src/app/dashboard/application/page.tsx`
- Create: `ui/src/components/applications/workspace/application-workspace.tsx`
- Create: `ui/src/components/applications/workspace/application-workspace.test.tsx`
- Create: `ui/src/components/applications/workspace/application-header.tsx`
- Create: `ui/src/components/applications/workspace/application-tabs.tsx`
- Create: `ui/src/components/applications/workspace/overview-tab.tsx`
- Create: `ui/src/components/applications/workspace/resources-tab.tsx`
- Create: `ui/src/components/applications/workspace/diagnostics-tab.tsx`
- Create: `ui/src/components/applications/workspace/metrics-tab.tsx`
- Create: `ui/src/components/applications/workspace/releases-tab.tsx`
- Create: `ui/src/components/applications/workspace/activity-tab.tsx`
- Create: `ui/src/components/applications/workspace/configuration-tab.tsx`
- Create: `ui/src/components/applications/workspace/use-application-workspace.ts`
- Create: `ui/src/components/activity/activity-feed.tsx`
- Create: `ui/src/components/activity/activity-feed.test.tsx`
- Create: `ui/src/app/dashboard/activity/page.tsx`
- Create: `ui/src/app/dashboard/activity/__tests__/page.test.tsx`
- Modify: `ui/src/components/layout/app-shell.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`
- Create: `ui/src/lib/application-workspace-query.ts`
- Create: `ui/src/lib/application-workspace-query.test.ts`
- Modify: `ui/src/components/dashboard/resource-detail-panel.tsx`
- Modify: `ui/src/components/dashboard/resource-detail-panel.test.tsx`
- Modify: `ui/src/components/dashboard/sync-diff-workbench.tsx`
- Modify: `ui/src/components/dashboard/investigation-triage.tsx`
- Modify: `ui/src/components/dashboard/application-release-history.tsx`

- [ ] **Step 1: Write failing URL/state and accessibility tests**

Assert `tab` and `stage` round-trip without losing shell scope, invalid tab falls back to Overview, blank stage follows the server default, stage switch invalidates target-specific queries, cluster is rendered read-only, and browser back/forward restores the workspace. Cover keyboard tab semantics, focus after errors, per-tab loading/retry, connection degradation scoped to one panel, and existing deep links. Global Activity tests assert the Plan-1 sidebar link resolves, shell scope/resource/outcome/time filters reach `QueryActivity`, cursor pagination deduplicates identities, and coverage is visibly labeled complete/best effort.

- [ ] **Step 2: Run and confirm failure**

Run: `cd ui && rtk npm test -- --run src/components/applications src/components/activity src/app/dashboard/activity src/lib/application-workspace-query.test.ts`

Expected: FAIL because workspace modules do not exist.

- [ ] **Step 3: Make the route a thin parser/Suspense boundary**

Keep the current path and `namespace`/`name` query keys. Move the 792-line client component into focused workspace modules. `application-workspace-query.ts` is the only owner of `tab` and `stage`; use Plan-1's shared scope codec rather than a second parser.

- [ ] **Step 4: Build the persistent header and tabs red-green**

Add header/tab tests first, then implement Application identity, project, source revision, selected-stage health/sync, stage selector, read-only derived cluster, capability-gated safe actions, refresh, and section errors. Tabs are Overview, Resources, Diagnostics, Metrics, Releases, Activity, and Configuration.

- [ ] **Step 5: Build Overview red-green**

Test selected-stage timeline/release/posture/Unknown states, then implement timeline-first Overview with golden-signal placeholder, findings, and gates.

- [ ] **Step 6: Build Resources red-green**

Test every resource/tree/detail/diff/Event/log request carries selected stage and that one connection error degrades only its panel. Reuse existing graph/list, detail, diff, Events, and streaming logs.

- [ ] **Step 7: Build Diagnostics and Metrics red-green**

Test Diagnostics passes stage into deterministic investigation. Test Metrics distinguishes not-configured from unavailable and renders “No observability source configured” until Plan 3 supplies signals; then implement both focused tabs.

- [ ] **Step 8: Build Releases red-green**

Test selected-stage history/gates/version comparison and capability-gated rollback/rollout links before adapting the existing release component.

- [ ] **Step 9: Build Application Activity and Configuration red-green**

Test lazy cursor paging/coverage labels and effective selected-stage/source/sync configuration with declarative links, then implement both tabs.

- [ ] **Step 10: Build the global Activity page from the same feed**

Create `/dashboard/activity` inside the Plan-1 shell. Reuse `activity-feed.tsx` for item rendering, cursor loading, coverage badges, partial-source errors, and empty states. The page owns only global fleet/resource/outcome/time filters through the shared URL scope codec and calls `QueryActivity`; the Application tab passes its fixed Application/stage identity to the same feed. Do not use the raw `/events` SSE endpoint as timeline history.

Plan 1 intentionally leaves Activity disabled. First change `app-shell.test.tsx` to expect an enabled `/dashboard/activity` navigation item now that the route exists, run that test red, then update `app-shell.tsx` and rerun green.

- [ ] **Step 11: Verify workspace behavior**

Run: `cd ui && rtk npm test`

Run: `cd ui && rtk npm run lint && rtk npm run build`

Expected: all tests/lint/build pass; static export keeps the existing Application route.

- [ ] **Step 12: Commit the workspace**

```bash
rtk git add ui/src/app/dashboard/application/page.tsx ui/src/app/dashboard/activity/page.tsx ui/src/app/dashboard/activity/__tests__/page.test.tsx ui/src/components/layout/app-shell.tsx ui/src/components/layout/app-shell.test.tsx ui/src/components/applications/workspace/application-workspace.tsx ui/src/components/applications/workspace/application-workspace.test.tsx ui/src/components/applications/workspace/application-header.tsx ui/src/components/applications/workspace/application-tabs.tsx ui/src/components/applications/workspace/overview-tab.tsx ui/src/components/applications/workspace/resources-tab.tsx ui/src/components/applications/workspace/diagnostics-tab.tsx ui/src/components/applications/workspace/metrics-tab.tsx ui/src/components/applications/workspace/releases-tab.tsx ui/src/components/applications/workspace/activity-tab.tsx ui/src/components/applications/workspace/configuration-tab.tsx ui/src/components/applications/workspace/use-application-workspace.ts ui/src/components/activity/activity-feed.tsx ui/src/components/activity/activity-feed.test.tsx ui/src/components/dashboard/resource-detail-panel.tsx ui/src/components/dashboard/resource-detail-panel.test.tsx ui/src/components/dashboard/sync-diff-workbench.tsx ui/src/components/dashboard/investigation-triage.tsx ui/src/components/dashboard/application-release-history.tsx ui/src/lib/application-workspace-query.ts ui/src/lib/application-workspace-query.test.ts
rtk git commit -m "feat(ui): add stage-aware application workspace"
```

### Task 10: Enforce Stage admission and ship the one-release pre-upgrade audit

**Files:**
- Modify: `internal/webhook/pipelines/v1alpha1/stage_webhook.go`
- Modify: `internal/webhook/pipelines/v1alpha1/stage_webhook_test.go`
- Create: `internal/upgrade/clusterref_audit.go`
- Create: `internal/upgrade/clusterref_audit_test.go`
- Create: `cmd/main_upgrade.go`
- Create: `cmd/main_upgrade_test.go`
- Modify: `cmd/main.go`
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/manager/manager.yaml`
- Modify: `charts/chart/templates/manager/statefulset.yaml`
- Modify: `charts/chart/templates/api-server/deployment.yaml`
- Modify: `charts/chart/templates/hooks/pre-upgrade-crd-check.yaml`
- Modify: `charts/chart/templates/hooks/pre-upgrade-crd-check-rbac.yaml`
- Modify: `docs/operations.md`

- [ ] **Step 1: Write failing admission compatibility tests**

Assert create rejects name-empty inline and named-plus-inline references; update allows an exactly unchanged legacy ClusterRef with an admission warning; and update still forbids any ClusterRef mutation. Strict named and empty in-cluster forms remain valid.

- [ ] **Step 2: Write failing preflight matrix tests**

Scan Stages for named-plus-inline references and missing named Cluster CRs using `clusteraccess.SufficientLegacyInline`, never a second mode parser. With the flag off, either blocks. With the flag on: named-plus-inline plus a Healthy Cluster passes with “Cluster CR wins; inline ignored” warning; a missing named Cluster passes only for a sufficient direct/agent inline definition; insufficient, named in-cluster, Disabled, and Unhealthy cases block. Assert resolver and preflight table tests share the same fixtures. Output exact namespace/name, issue, and declarative remediation without Secret values.

- [ ] **Step 3: Run and confirm failures**

Run: `rtk go test ./internal/webhook/pipelines/v1alpha1 ./internal/upgrade -run 'Test(StageClusterRef|ClusterRefAudit)' -count=1`

Expected: FAIL for absent strict validation/audit package.

- [ ] **Step 4: Implement admission and preflight**

Separate structural validation from legacy-transition validation so `validateStageCreate(newObj)` does not accidentally reject unchanged existing legacy objects. Both call the shared connection validator. Add `clusters.allowLegacyNamedInlineFallback` to values and `PAPRIKA_ALLOW_LEGACY_NAMED_INLINE_FALLBACK` to controller/API pods. Add an `upgrade-check` binary mode that runs `internal/upgrade` with an in-cluster client and exits nonzero for blocking findings; invoke it as a Paprika-image init container in the existing pre-upgrade CRD-check Job. The hook must run before strict controllers and use read-only Stage/Cluster RBAC.

- [ ] **Step 5: Document migration and flag removal**

Show YAML that creates a valid Cluster CR, removes all inline fields, and preserves the Stage's immutable target by recreating it through the owning Application/controller workflow. State the flag is removed next major release and cannot make unhealthy or credential-less targets usable.

- [ ] **Step 6: Verify webhook, chart, and preflight rendering**

Run: `rtk go test ./internal/webhook/pipelines/v1alpha1 ./internal/upgrade -count=1`

Run: `rtk helm lint charts/chart`

Run: `rtk helm template paprika charts/chart --set clusters.allowLegacyNamedInlineFallback=true | rtk rg 'PAPRIKA_ALLOW_LEGACY_NAMED_INLINE_FALLBACK|stages|clusters'`

Expected: tests/lint pass; hook and workloads receive the same compatibility setting and hook RBAC is read-only.

- [ ] **Step 7: Commit the migration gate**

```bash
rtk git add internal/webhook/pipelines/v1alpha1/stage_webhook.go internal/webhook/pipelines/v1alpha1/stage_webhook_test.go internal/upgrade/clusterref_audit.go internal/upgrade/clusterref_audit_test.go cmd/main.go cmd/main_upgrade.go cmd/main_upgrade_test.go charts/chart/values.yaml charts/chart/templates/manager/manager.yaml charts/chart/templates/manager/statefulset.yaml charts/chart/templates/api-server/deployment.yaml charts/chart/templates/hooks/pre-upgrade-crd-check.yaml charts/chart/templates/hooks/pre-upgrade-crd-check-rbac.yaml docs/operations.md
rtk git commit -m "feat(upgrade): audit legacy cluster references"
```

### Task 11: Prove direct and agent routing in real multi-cluster E2E

**Files:**
- Create: `hack/kind-multicluster.sh`
- Create: `hack/kind-multicluster-config.yaml`
- Create: `config/e2e/multicluster/control-plane-values.yaml`
- Create: `config/e2e/multicluster/remote-agent-values.yaml`
- Create: `config/e2e/multicluster/direct-kubeconfig-secret.yaml`
- Create: `config/e2e/multicluster/control-plane-proxies.yaml`
- Create: `config/e2e/multicluster/applications.yaml`
- Create: `test/e2e/multicluster_suite_test.go`
- Create: `test/e2e/application_resource_gateway_test.go`
- Create: `ui/e2e/application-workspace.spec.ts`
- Modify: `Makefile`
- Modify: `.github/workflows/test-e2e.yml`
- Modify: `docs/frontend.md`

- [ ] **Step 1: Write the failing Ginkgo acceptance scenario**

Create control and remote kind clusters. Deploy a sentinel `paprika-location=CONTROL` object only in control and `paprika-location=REMOTE` workload/event/log line only in remote. Create one direct Cluster and one agent Cluster, generated Stages with correct ownership, plus deliberately mismatched/missing references.

Assert stage-only requests return REMOTE evidence for direct and agent modes, stream a remote log, include a remote Event, and produce an investigation finding from remote evidence. Assert owner/label/spec-name mismatch is refused and stopping either remote connection returns `Unavailable` without ever returning CONTROL.

- [ ] **Step 2: Add exact cross-kind network endpoints**

Attach both kind node containers to the same Docker network and inspect the remote control-plane container IP. Install the agent Service as `NodePort`, then discover its allocated application port with `kubectl --context paprika-remote -n paprika-e2e get service paprika-agent -o 'jsonpath={.spec.ports[?(@.name=="http")].nodePort}'`; do not use the probe port or hard-code a NodePort. In the control cluster create selectorless Services plus EndpointSlices: `remote-api.paprika-e2e.svc:443` targets remote-node `:6443`, and `remote-agent.paprika-e2e.svc:443` targets the discovered agent NodePort. Rewrite the direct kubeconfig to the first Service and set `tls-server-name: kubernetes`; preserve only the remote CA/client certificate/key. Set agent address to the second Service and issue its server certificate with `remote-agent.paprika-e2e.svc` DNS SAN. This avoids localhost kubeconfigs, host-only ports, and unverifiable Docker IP SANs.

- [ ] **Step 3: Add the shared CA, allowed ingress, and readiness waits**

The script creates/deletes both clusters idempotently, builds `linux/amd64`, loads the image into both, generates ephemeral keys outside the repository, issues allowed controller-client URI and remote-agent server certificates, and installs only Kubernetes Secrets. Configure the remote agent NetworkPolicy with the observed control-cluster egress/node CIDR; prove a non-allowlisted source is denied and the control-plane source succeeds. Wait for CRDs, webhooks, mTLS AgentHealth, Cluster Healthy status, generated Stages, endpoint reachability from the API pod, and successful real `agent_rbac_test.go` assertions.

- [ ] **Step 4: Run the real routing suite**

Run: `rtk make test-e2e-multicluster`

Expected: PASS for direct/agent resource, Event, log, stream, investigation, real RBAC, NetworkPolicy, mismatch, and no-control-plane-fallback cases; cleanup runs on failure.

- [ ] **Step 5: Add the real Playwright workspace flow**

Against the kind UI, navigate from fleet to the existing Application route, switch `stage`, verify derived cluster text cannot be edited, traverse all tabs by keyboard, open REMOTE manifest/Event/log evidence, preserve URL state on reload/back, and verify a disconnected cluster degrades only the evidence panel with retry.

- [ ] **Step 6: Run browser E2E**

Run: `cd ui && rtk npm run test:e2e -- application-workspace.spec.ts`

Expected: PASS in Chromium normal and reduced-motion projects using the Plan-1 Playwright server configuration.

- [ ] **Step 7: Add CI and operator documentation**

Add `test-e2e-multicluster` Make target and a manually dispatchable/required release job in `.github/workflows/test-e2e.yml`. Document stage URL state, derived cluster semantics, mTLS trust onboarding, legacy warnings, coverage labels, and troubleshooting safe error messages.

- [ ] **Step 8: Run the plan-level verification gate**

Run: `rtk make generate manifests`

Run: `rtk go test ./internal/clusteraccess ./internal/applicationgateway ./internal/agent/... ./internal/agentclient ./internal/api ./internal/governance ./internal/controller/clusters ./internal/controller/pipelines ./internal/webhook/pipelines/v1alpha1 ./internal/upgrade ./cmd/... -count=1`

Run: `cd ui && rtk npm test && rtk npm run lint && rtk npm run build`

Run: `rtk helm lint charts/chart`

Run: `rtk make lint`

Expected: all commands pass and `rtk git diff --check` prints no output.

- [ ] **Step 9: Commit plan-2 completion**

```bash
rtk git add hack/kind-multicluster.sh hack/kind-multicluster-config.yaml config/e2e/multicluster/control-plane-values.yaml config/e2e/multicluster/remote-agent-values.yaml config/e2e/multicluster/direct-kubeconfig-secret.yaml config/e2e/multicluster/control-plane-proxies.yaml config/e2e/multicluster/applications.yaml test/e2e/multicluster_suite_test.go test/e2e/application_resource_gateway_test.go ui/e2e/application-workspace.spec.ts Makefile .github/workflows/test-e2e.yml docs/frontend.md
rtk git commit -m "test: validate multicluster application workspace"
```

### Plan 2 completion criteria

- Existing Application deep links render a tabbed stage-aware workspace with stage/tab URL state and a read-only derived cluster.
- Resource manifests, topology, Events, unary/streaming logs, activity, and investigations use the selected generated Stage's authoritative target.
- Strict ClusterRef interpretation is shared by deployment, governance, health, and evidence paths; direct client creation honors Secret namespace/key and fails closed.
- Agent evidence uses mutually authenticated Paprika TLS with least-privilege RBAC and no bearer or silent plaintext fallback.
- Legacy named-inline migrations are blocked or explicitly acknowledged for one release with condition/audit/metric visibility.
- Real direct and agent kind tests prove REMOTE evidence and prove control-plane fallback cannot occur.

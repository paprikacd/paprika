# Traffic Management for Canary Rollouts

## Problem
Paprika supports canary deployments with Helm-rendered nginx-ingress annotations for traffic splitting, but lacks a pluggable traffic router abstraction. Users can only split traffic via nginx-ingress (`canary-weight` annotation). Modern deployments use Istio or Gateway API for weighted traffic routing.

## Design

### 1. TrafficRouter Interface

A single Go interface in a new `traffic/` package:

```go
type Router interface {
    SetWeight(ctx context.Context, weight int32) error
    RemoveCanary(ctx context.Context) error
    Type() string
}
```

- `SetWeight`: routes `weight%` to canary, `(100-weight)%` to stable
- `RemoveCanary`: reverts to 100% stable, cleans up canary routes
- `Type`: returns `"istio"` or `"gateway-api"`
- Namespace and service names are captured at construction time, not per-call
- Designed for extension: `SetHeaderRoute`, `SetMirrorRoute` can be added later

### 2. Package Structure

```
traffic/
  traffic.go          # Router interface + factory + mock gen
  istio/
    istio.go          # IstioRouter — SetWeight, RemoveCanary
  gatewayapi/
    gatewayapi.go     # GatewayAPIRouter — SetWeight, RemoveCanary
```

The factory function `NewRouter` in `traffic/traffic.go` accepts config types from `api/v1alpha1`. This is acceptable because the factory is only called from the controller package, which already imports CRD types.

### 3. Provider Implementations

Both providers use `dynamic.Interface` (unstructured client) to avoid hard Go-type dependencies on Istio/Gateway API CRDs:
- No import of Istio or Gateway API Go modules
- Works with any version of the CRDs installed in the cluster
- If CRDs don't exist at runtime, SetWeight returns error → canary step fails → surfaced in Release Status
- If CRD resource not found, SetWeight returns error → canary step fails → surfaced in Release Status
- Kubernetes optimistic locking (resourceVersion) handles concurrent updates; controller retries on conflict

#### IstioRouter

HTTP routes only (v1). TCP/TLS routes are not patched — the controller ignores them. If the VirtualService has only TCP/TLS routes, SetWeight returns an error (misconfiguration).

Host-based routing (v1 only — matches stable/canary hosts from VirtualService route destinations). Namespace and service names are passed at construction time.

**SetWeight:**
1. Read existing `VirtualService` via dynamic client
2. If `config.Hosts` is non-empty, filter VirtualService to only those matching `spec.hosts` entries. If the VirtualService has no matching hosts, return error.
3. Within matching host entries, collect HTTP routes to patch:
   - If `config.Routes` is non-empty: only routes with matching `name`
   - If `config.Routes` is empty and there's exactly 1 HTTP route: patch that route
   - If `config.Routes` is empty and there are multiple HTTP routes: return error (ambiguous — specify routes)
4. If no HTTP routes found after filtering, return error (no routes to patch)
5. Within each route's destinations, find stable and canary destinations by matching `destination.host` against `<stableSvc>.` or `<canarySvc>.` prefix (includes dot delimiter to avoid false matches with similarly-named services)
6. If neither stable nor canary destination is found, return error
6. Patch destination weights: `weight` on canary destinations, `100-weight` on stable destinations
7. Write patched VirtualService back via dynamic client

**RemoveCanary:**
1. Read existing VirtualService
2. Remove canary destinations from matched routes
3. Set remaining stable destinations to weight 100
4. Write patched VirtualService back

#### GatewayAPIRouter

**SetWeight:**
1. Read existing `HTTPRoute` via dynamic client
2. Find backendRefs matching stable and canary service names (match by `backendRef.name` — exact match on service name)
3. If neither backendRef is found, return error (misconfiguration — HTTPRoute has no backends targeting these services)
4. Determine desired weights:
   - Canary: `weight`
   - Stable: `100 - weight`
   - All other backends: their original weight (unchanged)
5. Patch backendRefs with the computed weights
6. Write patched HTTPRoute back via dynamic client

**RemoveCanary:**
1. Read existing HTTPRoute
2. Remove canary backendRef from backends list
3. Set stable backendRef weight to 100
4. Write patched HTTPRoute back

### 4. CRD Types

Add to `api/v1alpha1/stage_types.go`:

```go
type TrafficRouter struct {
    Provider string `json:"provider"` // "istio" or "gateway-api"
    // +optional
    Istio *IstioRouterConfig `json:"istio,omitempty"`
    // +optional
    GatewayAPI *GatewayAPIRouterConfig `json:"gatewayApi,omitempty"`
}

type IstioRouterConfig struct {
    // Name of existing VirtualService to manage
    VirtualService string `json:"virtualService,omitempty"`
    // Route names to manage (empty = manage first unnamed route)
    Routes []string `json:"routes,omitempty"`
    // Hosts to match in VirtualService spec.hosts (optional — if empty, patch all HTTP routes)
    Hosts []string `json:"hosts,omitempty"`
    // Explicit stable service name (default: <release>-stable)
    StableService string `json:"stableService,omitempty"`
    // Explicit canary service name (default: <release>-canary)
    CanaryService string `json:"canaryService,omitempty"`
}

type GatewayAPIRouterConfig struct {
    // Name of existing HTTPRoute to manage
    HTTPRoute string `json:"httpRoute,omitempty"`
    // Explicit stable service name (default: <release>-stable)
    StableService string `json:"stableService,omitempty"`
    // Explicit canary service name (default: <release>-canary)
    CanaryService string `json:"canaryService,omitempty"`
}
```

On `StageSpec`:
```go
type StageSpec struct {
    // existing fields...
    // +optional
    TrafficRouter *TrafficRouter `json:"trafficRouter,omitempty"`
}
```

Defaults (naming conventions):
- If `TrafficRouter` is nil: no managed traffic routing (current behavior — nginx canary via Helm templates still works)
- If provider is `"istio"` and VirtualService is empty: derive name from `<release-name>-vs` (e.g. `myapp-vs`)
- If provider is `"gateway-api"` and HTTPRoute is empty: derive name from `<release-name>-httproute` (e.g. `myapp-httproute`)

### 5. Controller Integration

**Wiring** (per-Reconcile creation, not at startup):
- `ReleaseReconciler` gets a new field: `DynamicClient dynamic.Interface`
- Dynamic client is created once in `cmd/main.go`: `dynamic.NewForConfig(cfg)` — same as Istio/Gateway API client
- Inside `Reconcile()`, when the release enters Canarying phase:
  1. Read the Stage to get `Spec.TrafficRouter`
  2. If `TrafficRouter` is nil, skip (no managed routing — fall back to nginx canary)
  3. Derive service names from config or release name
  4. Call `traffic.NewRouter(provider, cfg, r.DynamicClient, stableSvc, canarySvc, ns)`
  5. Store router temporarily during the reconcile loop for subsequent SetWeight/RemoveCanary calls
- The router is created and discarded per reconcile — lightweight operation (no connections, just config storage)

This avoids the singleton problem where different Releases could have different traffic router configs.

`ReleaseReconciler` gets a new field for accessing provider CRDs:

```go
type ReleaseReconciler struct {
    client.Client
    Scheme          *runtime.Scheme
    Recorder        record.EventRecorder
    ClusterMgr      controller.ClusterClientManager
    DynamicClient   dynamic.Interface // added — for reading/writing VirtualService/HTTPRoute
}
```

Canary flow changes:

```
Current:  applyCanaryWeight(ctx, weight) → sleep → analysis → repeat
New:      applyCanaryWeight(ctx, weight) → router.SetWeight(ctx, weight) → sleep → analysis → repeat
```

Promotion flow changes:

```
Current:  promoteCanary(ctx) → cleanupCanaryResources(ctx)
New:      promoteCanary(ctx) → router.RemoveCanary(ctx) → cleanupCanaryResources(ctx)
```

Service name derivation (precedence order):
1. If `TrafficRouter.Istio.StableService`/`CanaryService` or `TrafficRouter.GatewayAPI.StableService`/`CanaryService` are set, use those
2. Otherwise derive from release name: `<release>-stable`, `<release>-canary`
3. If neither yields a result, the router logs a warning and returns an error

nginx-ingress interaction:
- If `TrafficRouter` is configured, TrafficRouter takes precedence
- The Helm template parameter `features.canary.enabled` still renders canary resources (deployments/services)
- The nginx canary annotations on the Ingress are controlled by the Helm chart. They are effectively ignored when TrafficRouter is managing routing at the VirtualService/HTTPRoute level
- No Helm chart changes needed — TrafficRouter operates on a higher control plane (L4/L7 routing) that bypasses nginx Ingress annotations entirely

Error recovery:
- If `SetWeight` fails at step N, the release controller's state machine keeps the release in Canarying phase
- The next reconcile retries the current step weight
- If `RemoveCanary` fails during promotion, the controller requeues and retries. The phase stays in Canarying until RemoveCanary succeeds, then transitions to Verifying
- Idempotent by design — re-applying the same weight is safe

### 6. Factory

```go
func NewRouter(cfg *v1alpha1.TrafficRouter, client dynamic.Interface, stableSvc, canarySvc, ns string) (Router, error) {
    switch cfg.Provider {
    case "istio":
        if cfg.Istio == nil {
            return nil, fmt.Errorf("traffic router provider istio requires non-nil istio config")
        }
        return istio.NewRouter(cfg.Istio, client, stableSvc, canarySvc, ns)
    case "gateway-api":
        if cfg.GatewayAPI == nil {
            return nil, fmt.Errorf("traffic router provider gateway-api requires non-nil gateway api config")
        }
        return gatewayapi.NewRouter(cfg.GatewayAPI, client, stableSvc, canarySvc, ns)
    default:
        return nil, fmt.Errorf("unknown traffic router provider: %s", cfg.Provider)
    }
}
```

### 7. Testing Strategy

**Unit tests (per provider):**
- `traffic/istio/istio_test.go` — fake dynamic client with pre-created VirtualService, verify weight patching
- `traffic/gatewayapi/gatewayapi_test.go` — fake dynamic client with pre-created HTTPRoute, verify weight patching
- `traffic/traffic_test.go` — factory tests, interface compliance

**Integration tests (controller level):**
- Extend existing canary e2e tests in `test/e2e/e2e_test.go`
- New test: "should perform canary with Gateway API traffic routing" (no Istio in kind cluster by default)

**What we test:**
- SetWeight produces correct VirtualService/HTTPRoute weights
- RemoveCanary reverts to 100% stable
- Error handling when CRD resources don't exist (returns error)
- Multiple step progression (10 → 30 → 60 → 100)
- Conflict resolution (resourceVersion checking on updates)

### 8. RBAC

New markers on the release controller:

```go
// +kubebuilder:rbac:groups=networking.istio.io,resources=virtualservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch
```

### 9. Proto/API Updates

Add to `proto/paprika/v1/api.proto`:
```protobuf
message TrafficRouter {
    string provider = 1;
    IstioRouterConfig istio = 2;
    GatewayAPIRouterConfig gateway_api = 3;
}

message IstioRouterConfig {
    string virtual_service = 1;
    repeated string routes = 2;
    repeated string hosts = 3;
    string stable_service = 4;
    string canary_service = 5;
}

message GatewayAPIRouterConfig {
    string http_route = 1;
    string stable_service = 2;
    string canary_service = 3;
}
```

## Implementation Order

1. CRD types (`api/v1alpha1/stage_types.go`) — add `TrafficRouter` and config structs + regenerate deepcopy
2. `Router` interface + factory (`traffic/traffic.go`) — define interface, factory, mockgen
3. `IstioRouter` (`traffic/istio/istio.go`) — full implementation with unit tests
4. `GatewayAPIRouter` (`traffic/gatewayapi/gatewayapi.go`) — full implementation with unit tests
5. Controller wiring (`internal/controller/release_controller.go`, `cmd/main.go`) — DynamicClient field, per-Reconcile router creation, SetWeight/RemoveCanary calls
6. RBAC + `make manifests`
7. Proto update (proto file + codegen)
8. E2e tests

## Open Questions

1. **DestinationRule support?** Deferred to v2. Host-based routing is simpler and sufficient for most Gateway API and basic Istio setups. Subset-based routing (DestinationRule) adds complexity around pod template hashes that isn't needed yet.

2. **Create vs patch?** Controller only patches existing VirtualService/HTTPRoute. User must pre-create the resource. This avoids ownership complexity and follows Argo Rollouts' approach.

3. **nginx-ingress coexistence?** TrafficRouter takes precedence. TrafficRouter operates at the L4/L7 routing layer (VirtualService/HTTPRoute), which bypasses nginx Ingress canary annotations. No Helm chart changes needed.

## References
- Argo Rollouts traffic routing: https://github.com/argoproj/argo-rollouts/tree/master/rollout/trafficrouting
- Argo Rollouts Istio implementation: https://github.com/argoproj/argo-rollouts/blob/master/rollout/trafficrouting/istio/istio.go
- Argo Rollouts Gateway API plugin: https://github.com/argoproj-labs/rollouts-plugin-trafficrouter-gatewayapi
- Argo Rollouts interface: https://github.com/argoproj/argo-rollouts/blob/master/rollout/trafficrouting/trafficroutingutil.go

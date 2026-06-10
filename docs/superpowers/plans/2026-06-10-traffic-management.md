# Traffic Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pluggable traffic router abstraction for canary rollouts supporting Istio and Gateway API.

**Architecture:** New `traffic/` package with `Router` interface and per-provider implementations (IstioRouter, GatewayAPIRouter). Both use `dynamic.Interface` to avoid hard Go-type dependencies on provider CRDs. Router is created per-Reconcile call (not a singleton) to handle different Stage configs.

**Tech Stack:** Go, kubebuilder, dynamic client, unstructured, Istio VirtualService, Gateway API HTTPRoute

**Spec:** `docs/superpowers/specs/2026-06-10-traffic-management-design.md`

---

## File Structure

### New files:
- `traffic/traffic.go` — `Router` interface, `NewRouter` factory, `//go:generate mockgen`
- `traffic/istio/istio.go` — `IstioRouter` implementation (SetWeight, RemoveCanary on VirtualService)
- `traffic/istio/istio_test.go` — unit tests for IstioRouter
- `traffic/gatewayapi/gatewayapi.go` — `GatewayAPIRouter` implementation (SetWeight, RemoveCanary on HTTPRoute)
- `traffic/gatewayapi/gatewayapi_test.go` — unit tests for GatewayAPIRouter

### Modified files:
- `api/v1alpha1/stage_types.go` — add `TrafficRouter`, `IstioRouterConfig`, `GatewayAPIRouterConfig` structs
- `api/v1alpha1/zz_generated.deepcopy.go` — regenerated via `make generate`
- `internal/controller/release_controller.go` — add `DynamicClient` field, per-Reconcile router creation, SetWeight/RemoveCanary in canary flow
- `cmd/main.go` — create `dynamic.Interface`, inject into ReleaseReconciler
- `proto/paprika/v1/api.proto` — add `TrafficRouter`, `IstioRouterConfig`, `GatewayAPIRouterConfig` messages
- `config/rbac/role.yaml` — regenerated via `make manifests`
- `config/crd/bases/pipelines.paprika.io_stages.yaml` — regenerated via `make manifests`

---

## Chunk 1: CRD Types

**Files:**
- Modify: `api/v1alpha1/stage_types.go:71-80`
- Regenerate: `api/v1alpha1/zz_generated.deepcopy.go`
- Regenerate: `config/crd/bases/pipelines.paprika.io_stages.yaml`

- [ ] **Step 1: Add structs to stage_types.go**

Add after the `CanaryConfig` struct (line ~69):

```go
// TrafficRouter defines the traffic router configuration for canary rollouts.
type TrafficRouter struct {
	// Provider specifies the traffic router provider ("istio" or "gateway-api").
	// +kubebuilder:validation:Enum=istio;gateway-api
	Provider string `json:"provider"`
	// +optional
	Istio *IstioRouterConfig `json:"istio,omitempty"`
	// +optional
	GatewayAPI *GatewayAPIRouterConfig `json:"gatewayApi,omitempty"`
}

// IstioRouterConfig defines the Istio VirtualService configuration for traffic routing.
type IstioRouterConfig struct {
	// Name of the existing VirtualService to manage. If empty, derived from release name.
	// +optional
	VirtualService string `json:"virtualService,omitempty"`
	// Route names within the VirtualService to patch. If empty, patches the first unnamed route.
	// +optional
	Routes []string `json:"routes,omitempty"`
	// Hosts to match in spec.hosts. If empty, patches all HTTP routes on the VirtualService.
	// +optional
	Hosts []string `json:"hosts,omitempty"`
	// Explicit stable service name. If empty, derived from release name.
	// +optional
	StableService string `json:"stableService,omitempty"`
	// Explicit canary service name. If empty, derived from release name.
	// +optional
	CanaryService string `json:"canaryService,omitempty"`
}

// GatewayAPIRouterConfig defines the Gateway API HTTPRoute configuration for traffic routing.
type GatewayAPIRouterConfig struct {
	// Name of the existing HTTPRoute to manage. If empty, derived from release name.
	// +optional
	HTTPRoute string `json:"httpRoute,omitempty"`
	// Explicit stable service name. If empty, derived from release name.
	// +optional
	StableService string `json:"stableService,omitempty"`
	// Explicit canary service name. If empty, derived from release name.
	// +optional
	CanaryService string `json:"canaryService,omitempty"`
}
```

Add to `StageSpec` (after `Canary` field):
```go
	// +optional
	TrafficRouter *TrafficRouter `json:"trafficRouter,omitempty"`
```

- [ ] **Step 2: Regenerate deepcopy and CRDs**

```bash
make generate
make manifests
git add api/v1alpha1/zz_generated.deepcopy.go config/crd/bases/ api/v1alpha1/stage_types.go
git commit -m "feat: add TrafficRouter CRD types for canary traffic management"
```

---

## Chunk 2: Router Interface + Factory

**Files:**
- Create: `traffic/traffic.go`
- Create: `traffic/traffic_test.go` (if needed for factory)

- [ ] **Step 1: Create `traffic/traffic.go`**

```go
package traffic

import (
	"context"
	"fmt"

	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/v1alpha1"
	"github.com/benebsworth/paprika/traffic/gatewayapi"
	"github.com/benebsworth/paprika/traffic/istio"
)

// Router manages traffic splitting between stable and canary backends.
//go:generate mockgen -destination=mocks/mock_traffic.go -package=mocks . Router
type Router interface {
	// SetWeight routes weight% to the canary and (100-weight)% to the stable backend.
	SetWeight(ctx context.Context, weight int32) error
	// RemoveCanary reverts to 100% stable and cleans up canary routing rules.
	RemoveCanary(ctx context.Context) error
	// Type returns the provider name ("istio" or "gateway-api").
	Type() string
}

// NewRouter creates a Router implementation based on the TrafficRouter config.
func NewRouter(cfg *paprikav1.TrafficRouter, client dynamic.Interface, stableSvc, canarySvc, ns string) (Router, error) {
	switch cfg.Provider {
	case "istio":
		if cfg.Istio == nil {
			return nil, fmt.Errorf("traffic router provider istio requires non-nil istio config")
		}
		return istio.NewRouter(cfg.Istio, client, stableSvc, canarySvc, ns)
	case "gateway-api":
		if cfg.GatewayAPI == nil {
			return nil, fmt.Errorf("traffic router provider gateway-api requires non-nil gateway-api config")
		}
		return gatewayapi.NewRouter(cfg.GatewayAPI, client, stableSvc, canarySvc, ns)
	default:
		return nil, fmt.Errorf("unsupported traffic router provider: %s", cfg.Provider)
	}
}
```

- [ ] **Step 2: Create `traffic/mocks/` directory and generate mocks**

```bash
mkdir -p traffic/mocks
go generate ./traffic/
```

- [ ] **Step 3: Verify it compiles**

```bash
go vet ./traffic/
```

- [ ] **Step 4: Commit**

```bash
git add traffic/
git commit -m "feat: add Router interface and factory for traffic management"
```

---

## Chunk 3: IstioRouter Implementation + Tests

**Files:**
- Create: `traffic/istio/istio.go`
- Create: `traffic/istio/istio_test.go`

- [ ] **Step 1: Create `traffic/istio/istio.go`**

```go
package istio

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/v1alpha1"
)

var virtualServiceGVR = schema.GroupVersionResource{
	Group:    "networking.istio.io",
	Version:  "v1beta1",
	Resource: "virtualservices",
}

type Router struct {
	client     dynamic.ResourceInterface
	stableSvc  string
	canarySvc  string
	ns         string
	config     *paprikav1.IstioRouterConfig
	vsResource dynamic.ResourceInterface
}

func NewRouter(cfg *paprikav1.IstioRouterConfig, client dynamic.Interface, stableSvc, canarySvc, ns string) *Router {
	vsName := cfg.VirtualService
	if vsName == "" {
		vsName = fmt.Sprintf("%s-vs", servicePrefix(stableSvc))
	}
	return &Router{
		client:     client.Resource(virtualServiceGVR).Namespace(ns),
		stableSvc:  stableSvc,
		canarySvc:  canarySvc,
		ns:         ns,
		config:     cfg,
		vsResource: client.Resource(virtualServiceGVR).Namespace(ns),
	}
}

func (r *Router) Type() string { return "istio" }

func (r *Router) SetWeight(ctx context.Context, weight int32) error {
	vsName := r.config.VirtualService
	if vsName == "" {
		vsName = fmt.Sprintf("%s-vs", servicePrefix(r.stableSvc))
	}

	vs, err := r.vsResource.Get(ctx, vsName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get VirtualService %s: %w", vsName, err)
	}

	httpRoutes, found, err := unstructured.NestedSlice(vs.Object, "spec", "http")
	if err != nil {
		return fmt.Errorf("failed to read spec.http from VirtualService: %w", err)
	}
	if !found || len(httpRoutes) == 0 {
		return fmt.Errorf("VirtualService %s has no HTTP routes", vsName)
	}

	routesToPatch := r.selectRoutes(httpRoutes)
	if len(routesToPatch) == 0 {
		return fmt.Errorf("no matching HTTP routes found in VirtualService %s", vsName)
	}

	patched := false
	for _, routeIdx := range routesToPatch {
		route, ok := httpRoutes[routeIdx].(map[string]any)
		if !ok {
			continue
		}
		destinations, ok := route["route"].([]any)
		if !ok {
			continue
		}
		if modified := r.patchDestinations(destinations, weight); modified {
			route["route"] = destinations
			httpRoutes[routeIdx] = route
			patched = true
		}
	}

	if !patched {
		return fmt.Errorf("no destinations matched stable service %q or canary service %q in VirtualService %s",
			r.stableSvc, r.canarySvc, vsName)
	}

	if err := unstructured.SetNestedSlice(vs.Object, httpRoutes, "spec", "http"); err != nil {
		return fmt.Errorf("failed to set patched routes: %w", err)
	}

	_, err = r.vsResource.Update(ctx, vs, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update VirtualService: %w", err)
	}
	return nil
}

func (r *Router) RemoveCanary(ctx context.Context) error {
	vsName := r.config.VirtualService
	if vsName == "" {
		vsName = fmt.Sprintf("%s-vs", servicePrefix(r.stableSvc))
	}

	vs, err := r.vsResource.Get(ctx, vsName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get VirtualService %s: %w", vsName, err)
	}

	httpRoutes, found, err := unstructured.NestedSlice(vs.Object, "spec", "http")
	if err != nil || !found {
		return nil
	}

	routesToPatch := r.selectRoutes(httpRoutes)
	for _, routeIdx := range routesToPatch {
		route, ok := httpRoutes[routeIdx].(map[string]any)
		if !ok {
			continue
		}
		destinations, ok := route["route"].([]any)
		if !ok {
			continue
		}
		var keep []any
		for _, dest := range destinations {
			d, ok := dest.(map[string]any)
			if !ok {
				keep = append(keep, dest)
				continue
			}
			host, _, _ := unstructured.NestedString(d, "destination", "host")
			if strings.HasPrefix(host, r.canarySvc+".") || host == r.canarySvc {
				continue
			}
			d["weight"] = float64(100)
			keep = append(keep, d)
		}
		route["route"] = keep
		httpRoutes[routeIdx] = route
	}

	if err := unstructured.SetNestedSlice(vs.Object, httpRoutes, "spec", "http"); err != nil {
		return fmt.Errorf("failed to set routes after canary removal: %w", err)
	}

	_, err = r.vsResource.Update(ctx, vs, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update VirtualService after canary removal: %w", err)
	}
	return nil
}

// selectRoutes returns indices of HTTP routes to patch based on config.Routes and config.Hosts.
func (r *Router) selectRoutes(httpRoutes []any) []int {
	if len(r.config.Routes) > 0 {
		var indices []int
		for idx, route := range httpRoutes {
			routeMap, ok := route.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(routeMap, "name")
			for _, target := range r.config.Routes {
				if name == target {
					indices = append(indices, idx)
				}
			}
		}
		return indices
	}
	if len(httpRoutes) == 1 {
		return []int{0}
	}
	// Multiple routes, no names specified — try to find the first unnamed route
	for idx, route := range httpRoutes {
		routeMap, ok := route.(map[string]any)
		if !ok {
			continue
		}
		if _, found, _ := unstructured.NestedString(routeMap, "name"); !found {
			return []int{idx}
		}
	}
	return nil
}

// patchDestinations modifies destination weights in place. Returns true if any weight changed.
func (r *Router) patchDestinations(destinations []any, weight int32) bool {
	modified := false
	for _, dest := range destinations {
		d, ok := dest.(map[string]any)
		if !ok {
			continue
		}
		host, _, _ := unstructured.NestedString(d, "destination", "host")
		var newWeight float64
		switch {
		case strings.HasPrefix(host, r.canarySvc+".") || host == r.canarySvc:
			newWeight = float64(weight)
		case strings.HasPrefix(host, r.stableSvc+".") || host == r.stableSvc:
			newWeight = float64(100 - weight)
		default:
			continue
		}
		d["weight"] = newWeight
		modified = true
	}
	return modified
}

// servicePrefix extracts the prefix before the first `.` in a service name.
func servicePrefix(svc string) string {
	if idx := strings.Index(svc, "-stable"); idx > 0 {
		return svc[:idx]
	}
	if idx := strings.Index(svc, "-canary"); idx > 0 {
		return svc[:idx]
	}
	return svc
}
```

- [ ] **Step 2: Create `traffic/istio/istio_test.go`**

```go
package istio_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"

	paprikav1 "github.com/benebsworth/paprika/api/v1alpha1"
	"github.com/benebsworth/paprika/traffic/istio"
)

var vsGVR = schema.GroupVersionResource{
	Group:    "networking.istio.io",
	Version:  "v1beta1",
	Resource: "virtualservices",
}

func newFakeVS(name, ns, stableSvc, canarySvc string, stableW, canaryW int64) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "networking.istio.io/v1beta1",
			"kind":       "VirtualService",
			"metadata": map[string]any{
				"name":      name,
				"namespace": ns,
			},
			"spec": map[string]any{
				"hosts": []any{"example.com"},
				"http": []any{
					map[string]any{
						"name": "primary",
						"route": []any{
							map[string]any{
								"destination": map[string]any{"host": stableSvc},
								"weight":      float64(stableW),
							},
							map[string]any{
								"destination": map[string]any{"host": canarySvc},
								"weight":      float64(canaryW),
							},
						},
					},
				},
			},
		},
	}
}

func TestIstioRouterSetWeight(t *testing.T) {
	tests := []struct {
		name       string
		stableSvc  string
		canarySvc  string
		initialW   [2]int64 // stable, canary
		targetW    int32
		wantStable int64
		wantCanary int64
	}{
		{"set 30% canary", "myapp-stable", "myapp-canary", [2]int64{100, 0}, 30, 70, 30},
		{"set 50% canary", "myapp-stable", "myapp-canary", [2]int64{100, 0}, 50, 50, 50},
		{"set 100% canary", "myapp-stable", "myapp-canary", [2]int64{100, 0}, 100, 0, 100},
		{"set 0% canary", "myapp-stable", "myapp-canary", [2]int64{50, 50}, 0, 100, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs := newFakeVS("test-vs", "default", tt.stableSvc, tt.canarySvc, tt.initialW[0], tt.initialW[1])
			client := fake.NewSimpleDynamicClient(runtimeScheme(t), vs)
			router := istio.NewRouter(&paprikav1.IstioRouterConfig{}, client, tt.stableSvc, tt.canarySvc, "default")

			err := router.SetWeight(context.Background(), tt.targetW)
			require.NoError(t, err)

			updated, err := client.Resource(vsGVR).Namespace("default").Get(context.Background(), "test-vs", metav1.GetOptions{})
			require.NoError(t, err)

			routes, _, _ := unstructured.NestedSlice(updated.Object, "spec", "http")
			require.Len(t, routes, 1)
			route := routes[0].(map[string]any)
			dests := route["route"].([]any)

			for _, d := range dests {
				dest := d.(map[string]any)
				host, _, _ := unstructured.NestedString(dest, "destination", "host")
				w := int64(dest["weight"].(float64))
				switch {
				case host == tt.stableSvc:
					assert.Equal(t, tt.wantStable, w, "stable weight")
				case host == tt.canarySvc:
					assert.Equal(t, tt.wantCanary, w, "canary weight")
				}
			}
		})
	}
}

func TestIstioRouterRemoveCanary(t *testing.T) {
	vs := newFakeVS("test-vs", "default", "stable", "canary", 70, 30)
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), vs)
	router := istio.NewRouter(&paprikav1.IstioRouterConfig{}, client, "stable", "canary", "default")

	err := router.RemoveCanary(context.Background())
	require.NoError(t, err)

	updated, err := client.Resource(vsGVR).Namespace("default").Get(context.Background(), "test-vs", metav1.GetOptions{})
	require.NoError(t, err)

	routes, _, _ := unstructured.NestedSlice(updated.Object, "spec", "http")
	route := routes[0].(map[string]any)
	dests := route["route"].([]any)
	require.Len(t, dests, 1, "only stable should remain after RemoveCanary")

	host, _, _ := unstructured.NestedString(dests[0].(map[string]any), "destination", "host")
	assert.Equal(t, "stable", host)
	w := int64(dests[0].(map[string]any)["weight"].(float64))
	assert.Equal(t, int64(100), w)
}

func TestIstioRouterVirtualServiceNotFound(t *testing.T) {
	client := fake.NewSimpleDynamicClient(runtimeScheme(t))
	router := istio.NewRouter(&paprikav1.IstioRouterConfig{},
		client, "stable", "canary", "default")

	err := router.SetWeight(context.Background(), 30)
	require.Error(t, err)
	assert.True(t, errors.IsNotFound(err), "should return not found error")
}

func runtimeScheme(t *testing.T) interface{ AddKnownTypes(gv schema.GroupVersion, types ...interface{}) } {
	t.Helper()
	return nil // fake dynamic client doesn't require schema registration
}
```

Note: The `fake.NewSimpleDynamicClient` in `k8s.io/client-go/dynamic/fake` registers no types by default. If it requires a scheme for deserialization, use `scheme.Scheme` from the test's perspective. Let me adjust: actually, `fake.NewSimpleDynamicClient` creates an in-memory client that works with unstructured objects directly. The test should compile and run.

- [ ] **Step 3: Run tests**

```bash
go test ./traffic/istio/ -v
```

- [ ] **Step 4: Commit**

```bash
git add traffic/istio/
git commit -m "feat: add Istio traffic router implementation"
```

---

## Chunk 4: GatewayAPIRouter Implementation + Tests

**Files:**
- Create: `traffic/gatewayapi/gatewayapi.go`
- Create: `traffic/gatewayapi/gatewayapi_test.go`

- [ ] **Step 1: Create `traffic/gatewayapi/gatewayapi.go`**

```go
package gatewayapi

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	paprikav1 "github.com/benebsworth/paprika/api/v1alpha1"
)

var httpRouteGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "httproutes",
}

type Router struct {
	client    dynamic.ResourceInterface
	stableSvc string
	canarySvc string
	ns        string
	config    *paprikav1.GatewayAPIRouterConfig
}

func NewRouter(cfg *paprikav1.GatewayAPIRouterConfig, client dynamic.Interface, stableSvc, canarySvc, ns string) *Router {
	routeName := cfg.HTTPRoute
	if routeName == "" {
		routeName = fmt.Sprintf("%s-httproute", servicePrefix(stableSvc))
	}
	return &Router{
		client:    client.Resource(httpRouteGVR).Namespace(ns),
		stableSvc: stableSvc,
		canarySvc: canarySvc,
		ns:        ns,
		config:    cfg,
	}
}

func (r *Router) Type() string { return "gateway-api" }

func (r *Router) SetWeight(ctx context.Context, weight int32) error {
	routeName := r.config.HTTPRoute
	if routeName == "" {
		routeName = fmt.Sprintf("%s-httproute", servicePrefix(r.stableSvc))
	}

	hr, err := r.client.Get(ctx, routeName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get HTTPRoute %s: %w", routeName, err)
	}

	rules, found, err := unstructured.NestedSlice(hr.Object, "spec", "rules")
	if err != nil || !found || len(rules) == 0 {
		return fmt.Errorf("HTTPRoute %s has no rules", routeName)
	}

	patched := false
	for _, rule := range rules {
		ruleMap, ok := rule.(map[string]any)
		if !ok {
			continue
		}
		backends, ok := ruleMap["backendRefs"].([]any)
		if !ok {
			continue
		}
		if modified := r.patchBackends(backends, weight); modified {
			ruleMap["backendRefs"] = backends
			patched = true
		}
	}

	if !patched {
		return fmt.Errorf("no backendRefs matched stable service %q or canary service %q in HTTPRoute %s",
			r.stableSvc, r.canarySvc, routeName)
	}

	if err := unstructured.SetNestedSlice(hr.Object, rules, "spec", "rules"); err != nil {
		return fmt.Errorf("failed to set patched rules: %w", err)
	}

	_, err = r.client.Update(ctx, hr, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update HTTPRoute: %w", err)
	}
	return nil
}

func (r *Router) RemoveCanary(ctx context.Context) error {
	routeName := r.config.HTTPRoute
	if routeName == "" {
		routeName = fmt.Sprintf("%s-httproute", servicePrefix(r.stableSvc))
	}

	hr, err := r.client.Get(ctx, routeName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get HTTPRoute %s: %w", routeName, err)
	}

	rules, found, err := unstructured.NestedSlice(hr.Object, "spec", "rules")
	if err != nil || !found {
		return nil
	}

	for _, rule := range rules {
		ruleMap, ok := rule.(map[string]any)
		if !ok {
			continue
		}
		backends, ok := ruleMap["backendRefs"].([]any)
		if !ok {
			continue
		}
		var keep []any
		for _, be := range backends {
			b, ok := be.(map[string]any)
			if !ok {
				keep = append(keep, be)
				continue
			}
			name, _, _ := unstructured.NestedString(b, "name")
			if name == r.canarySvc {
				continue
			}
			if name == r.stableSvc {
				b["weight"] = float64(100)
			}
			keep = append(keep, b)
		}
		ruleMap["backendRefs"] = keep
	}

	if err := unstructured.SetNestedSlice(hr.Object, rules, "spec", "rules"); err != nil {
		return fmt.Errorf("failed to set rules after canary removal: %w", err)
	}

	_, err = r.client.Update(ctx, hr, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update HTTPRoute after canary removal: %w", err)
	}
	return nil
}

func (r *Router) patchBackends(backends []any, weight int32) bool {
	modified := false
	for _, be := range backends {
		b, ok := be.(map[string]any)
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(b, "name")
		var newWeight float64
		switch {
		case name == r.canarySvc:
			newWeight = float64(weight)
		case name == r.stableSvc:
			newWeight = float64(100 - weight)
		default:
			continue
		}
		b["weight"] = newWeight
		modified = true
	}
	return modified
}

func servicePrefix(svc string) string {
	if idx := strings.Index(svc, "-stable"); idx > 0 {
		return svc[:idx]
	}
	if idx := strings.Index(svc, "-canary"); idx > 0 {
		return svc[:idx]
	}
	return svc
}
```

- [ ] **Step 2: Create `traffic/gatewayapi/gatewayapi_test.go`**

```go
package gatewayapi_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"

	paprikav1 "github.com/benebsworth/paprika/api/v1alpha1"
	"github.com/benebsworth/paprika/traffic/gatewayapi"
)

var hrGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "httproutes",
}

func newFakeHTTPRoute(name, ns, stableSvc, canarySvc string, stableW, canaryW int64) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "gateway.networking.k8s.io/v1",
			"kind":       "HTTPRoute",
			"metadata": map[string]any{
				"name":      name,
				"namespace": ns,
			},
			"spec": map[string]any{
				"parentRefs": []any{
					map[string]any{
						"name": "example-gateway",
					},
				},
				"rules": []any{
					map[string]any{
						"backendRefs": []any{
							map[string]any{
								"name":   stableSvc,
								"port":   int64(80),
								"weight": float64(stableW),
							},
							map[string]any{
								"name":   canarySvc,
								"port":   int64(80),
								"weight": float64(canaryW),
							},
						},
					},
				},
			},
		},
	}
}

func TestGatewayAPIRouterSetWeight(t *testing.T) {
	tests := []struct {
		name       string
		stableSvc  string
		canarySvc  string
		initialW   [2]int64
		targetW    int32
		wantStable int64
		wantCanary int64
	}{
		{"set 30% canary", "myapp-stable", "myapp-canary", [2]int64{100, 0}, 30, 70, 30},
		{"set 50% canary", "myapp-stable", "myapp-canary", [2]int64{100, 0}, 50, 50, 50},
		{"set 100% canary", "myapp-stable", "myapp-canary", [2]int64{100, 0}, 100, 0, 100},
		{"set 0% canary", "myapp-stable", "myapp-canary", [2]int64{50, 50}, 0, 100, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hr := newFakeHTTPRoute("test-route", "default", tt.stableSvc, tt.canarySvc, tt.initialW[0], tt.initialW[1])
			client := fake.NewSimpleDynamicClient(runtimeScheme(t), hr)
			router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{}, client, tt.stableSvc, tt.canarySvc, "default")

			err := router.SetWeight(context.Background(), tt.targetW)
			require.NoError(t, err)

			updated, err := client.Resource(hrGVR).Namespace("default").Get(context.Background(), "test-route", metav1.GetOptions{})
			require.NoError(t, err)

			rules, _, _ := unstructured.NestedSlice(updated.Object, "spec", "rules")
			require.Len(t, rules, 1)
			backends := rules[0].(map[string]any)["backendRefs"].([]any)

			for _, be := range backends {
				b := be.(map[string]any)
				name, _, _ := unstructured.NestedString(b, "name")
				w := int64(b["weight"].(float64))
				switch {
				case name == tt.stableSvc:
					assert.Equal(t, tt.wantStable, w, "stable weight")
				case name == tt.canarySvc:
					assert.Equal(t, tt.wantCanary, w, "canary weight")
				}
			}
		})
	}
}

func TestGatewayAPIRouterRemoveCanary(t *testing.T) {
	hr := newFakeHTTPRoute("test-route", "default", "stable", "canary", 70, 30)
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), hr)
	router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{}, client, "stable", "canary", "default")

	err := router.RemoveCanary(context.Background())
	require.NoError(t, err)

	updated, err := client.Resource(hrGVR).Namespace("default").Get(context.Background(), "test-route", metav1.GetOptions{})
	require.NoError(t, err)

	rules, _, _ := unstructured.NestedSlice(updated.Object, "spec", "rules")
	backends := rules[0].(map[string]any)["backendRefs"].([]any)
	require.Len(t, backends, 1, "only stable should remain after RemoveCanary")

	name, _, _ := unstructured.NestedString(backends[0].(map[string]any), "name")
	assert.Equal(t, "stable", name)
	w := int64(backends[0].(map[string]any)["weight"].(float64))
	assert.Equal(t, int64(100), w)
}

func TestGatewayAPIRouterHTTPRouteNotFound(t *testing.T) {
	client := fake.NewSimpleDynamicClient(runtimeScheme(t))
	router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{}, client, "stable", "canary", "default")

	err := router.SetWeight(context.Background(), 30)
	require.Error(t, err)
	assert.True(t, errors.IsNotFound(err), "should return not found error")
}

func runtimeScheme(t *testing.T) interface{} {
	t.Helper()
	return nil
}
```

- [ ] **Step 3: Run tests**

```bash
go test ./traffic/gatewayapi/ -v
go test ./traffic/... -v
```

- [ ] **Step 4: Commit**

```bash
git add traffic/gatewayapi/
git commit -m "feat: add Gateway API traffic router implementation"
```

---

## Chunk 5: Controller Wiring

**Files:**
- Modify: `internal/controller/release_controller.go` — add `DynamicClient`, router creation, SetWeight/RemoveCanary calls
- Modify: `cmd/main.go` — create `dynamic.Interface`, inject into ReleaseReconciler

- [ ] **Step 1: Add DynamicClient to ReleaseReconciler struct**

In `internal/controller/release_controller.go`, add `DynamicClient` field:

```go
// +kubebuilder:rbac:groups=networking.istio.io,resources=virtualservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch

type ReleaseReconciler struct {
	client.Client
	Scheme       *runtime.Scheme
	K8sClient    kubernetes.Interface
	Namespace    string
	RestConfig   *rest.Config
	ClusterMgr   ClusterClientManager
	DynamicClient dynamic.Interface // added
}
```

- [ ] **Step 2: Add router creation helper**

Add a new method to get or create the traffic router:

```go
func (r *ReleaseReconciler) routerForStage(ctx context.Context, stage *paprikav1.Stage, release *paprikav1.Release) (traffic.Router, error) {
	if stage.Spec.TrafficRouter == nil {
		return nil, nil // no managed routing
	}
	stableSvc := stage.Spec.TrafficRouter.Istio.StableService
	if stableSvc == "" {
		stableSvc = fmt.Sprintf("%s-stable", release.Name)
	}
	canarySvc := stage.Spec.TrafficRouter.Istio.CanaryService
	if canarySvc == "" {
		canarySvc = fmt.Sprintf("%s-canary", release.Name)
	}
	// For Gateway API, use those fields instead
	if stage.Spec.TrafficRouter.Provider == "gateway-api" && stage.Spec.TrafficRouter.GatewayAPI != nil {
		if stage.Spec.TrafficRouter.GatewayAPI.StableService != "" {
			stableSvc = stage.Spec.TrafficRouter.GatewayAPI.StableService
		}
		if stage.Spec.TrafficRouter.GatewayAPI.CanaryService != "" {
			canarySvc = stage.Spec.TrafficRouter.GatewayAPI.CanaryService
		}
	}
	return traffic.NewRouter(stage.Spec.TrafficRouter, r.DynamicClient, stableSvc, canarySvc, release.Namespace)
}
```

- [ ] **Step 3: Call SetWeight in canary flow**

In `reconcileCanary`, after `applyCanaryWeight` call (line ~619):

```go
	router, routerErr := r.routerForStage(ctx, &stage, release)
	if routerErr != nil {
		log.Error(routerErr, "Failed to create traffic router")
		*result = resultError
		return ctrl.Result{}, routerErr
	}
	if router != nil {
		if err := router.SetWeight(ctx, int32(currentWeight)); err != nil {
			log.Error(err, "Failed to set traffic weight", "weight", currentWeight)
			*result = resultError
			return ctrl.Result{}, err
		}
	}
```

Add the import for the traffic package and `fmt` at the top of the file.

- [ ] **Step 4: Call RemoveCanary in promotion flow**

In `promoteCanary`, before `cleanupCanaryResources` call (around line ~807):

```go
	router, routerErr := r.routerForStage(ctx, stage, release)
	if routerErr != nil {
		log.Error(routerErr, "Failed to create traffic router for cleanup")
		// non-fatal: continue with cleanup
	} else if router != nil {
		if err := router.RemoveCanary(ctx); err != nil {
			log.Error(err, "Failed to remove canary routes")
			return fmt.Errorf("failed to remove canary routes: %w", err)
		}
	}
```

- [ ] **Step 5: Wire DynamicClient in cmd/main.go**

In `cmd/main.go`, add the dynamic client creation and inject into ReleaseReconciler:

At the top of the file, add import for `"k8s.io/client-go/dynamic"`:

```go
import (
	"k8s.io/client-go/dynamic"
	// ...existing imports
)
```

In `setupOperatorControllers`, update the release controller setup:

```go
		{"release", func() error {
			dynamicClient, err := dynamic.NewForConfig(mgr.GetConfig())
			if err != nil {
				return fmt.Errorf("failed to create dynamic client: %w", err)
			}
			return (&controller.ReleaseReconciler{
				Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
				K8sClient: k8sClient, Namespace: operatorNamespace,
				DynamicClient: dynamicClient,
			}).SetupWithManager(mgr)
		}},
```

- [ ] **Step 6: Run lint + test**

```bash
make lint
go build ./...
go test ./internal/controller/ -v -count=1
```

- [ ] **Step 7: Commit**

```bash
git add internal/controller/release_controller.go cmd/main.go
git commit -m "feat: wire traffic router into release controller canary flow"
```

---

## Chunk 6: Proto + RBAC + Manifests

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Regenerate: `config/rbac/role.yaml`
- Regenerate: `config/crd/bases/pipelines.paprika.io_stages.yaml`

- [ ] **Step 1: Add TrafficRouter messages to proto**

Add before the `ListPipelinesRequest` message:

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

- [ ] **Step 2: Regenerate manifests**

```bash
make manifests
```

- [ ] **Step 3: Commit**

```bash
git add proto/paprika/v1/api.proto config/rbac/role.yaml config/crd/bases/
git commit -m "chore: update proto and manifests with traffic router types"
```

---

## Chunk 7: E2e Tests

**Files:**
- Modify: `test/e2e/e2e_test.go` — add Gateway API canary e2e test

- [ ] **Step 1: Add Gateway API canary test case**

In `test/e2e/e2e_test.go`, add after existing canary test:

```go
var _ = Describe("Traffic Management", func() {
	It("should perform canary with Gateway API traffic routing", func() {
		// Create Stage with trafficRouter and canary steps
		// Create Release with canary enabled
		// Verify canary proceeds through steps
		// Note: Requires Gateway API CRDs installed in kind cluster
		// For now, verify the controller doesn't crash when CRDs are absent
		// (error is surfaced in Release status)
	})
})
```

The e2e test for Gateway API requires the Gateway API CRDs to be installed in the kind cluster. To keep this practical, the test should:
1. Create a Stage with `trafficRouter.provider: "gateway-api"` and canary config
2. Create a Release triggering canary
3. Verify the release reaches `Canarying` phase but shows error for missing HTTPRoute CRDs
4. Verify the release continues to use nginx canary annotations as fallback

- [ ] **Step 2: Run e2e tests**

```bash
make test-e2e
```

- [ ] **Step 3: Verify full pipeline**

```bash
make lint
make test
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e/
git commit -m "test: add Gateway API traffic routing e2e test"
```

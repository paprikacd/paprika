package gatewayapi_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
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
			router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{
				HTTPRoute: "test-route",
			}, client, tt.stableSvc, tt.canarySvc, "default")

			err := router.SetWeight(context.Background(), tt.targetW)
			require.NoError(t, err)

			updated, err := client.Resource(hrGVR).Namespace("default").Get(context.Background(), "test-route", metav1.GetOptions{})
			require.NoError(t, err)

			rules, _, _ := unstructured.NestedSlice(updated.Object, "spec", "rules")
			require.Len(t, rules, 1)
			rule, ok := rules[0].(map[string]any)
			require.True(t, ok)
			backends, ok := rule["backendRefs"].([]any)
			require.True(t, ok)

			for _, be := range backends {
				b, ok := be.(map[string]any)
				require.True(t, ok)
				name, _, _ := unstructured.NestedString(b, "name")
				w, ok := b["weight"].(float64)
				require.True(t, ok)
				switch name {
				case tt.stableSvc:
					assert.Equal(t, tt.wantStable, int64(w), "stable weight")
				case tt.canarySvc:
					assert.Equal(t, tt.wantCanary, int64(w), "canary weight")
				}
			}
		})
	}
}

func TestGatewayAPIRouterRemoveCanary(t *testing.T) {
	hr := newFakeHTTPRoute("test-route", "default", "stable", "canary", 70, 30)
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), hr)
	router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{
		HTTPRoute: "test-route",
	}, client, "stable", "canary", "default")

	err := router.RemoveCanary(context.Background())
	require.NoError(t, err)

	updated, err := client.Resource(hrGVR).Namespace("default").Get(context.Background(), "test-route", metav1.GetOptions{})
	require.NoError(t, err)

	rules, _, _ := unstructured.NestedSlice(updated.Object, "spec", "rules")
	rule, ok := rules[0].(map[string]any)
	require.True(t, ok)
	backends, ok := rule["backendRefs"].([]any)
	require.True(t, ok)
	require.Len(t, backends, 1, "only stable should remain after RemoveCanary")

	backend, ok := backends[0].(map[string]any)
	require.True(t, ok)
	name, _, _ := unstructured.NestedString(backend, "name")
	assert.Equal(t, "stable", name)
	w, ok := backend["weight"].(float64)
	require.True(t, ok)
	assert.Equal(t, float64(100), w)
}

func TestGatewayAPIRouterHTTPRouteNotFound(t *testing.T) {
	client := fake.NewSimpleDynamicClient(runtimeScheme(t))
	router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{}, client, "stable", "canary", "default")

	err := router.SetWeight(context.Background(), 30)
	require.Error(t, err)
	assert.True(t, errors.IsNotFound(err), "should return not found error")
}

func runtimeScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	return runtime.NewScheme()
}

func TestGatewayAPIRouterHeaderRouteNotSupported(t *testing.T) {
	hr := newFakeHTTPRoute("test-route", "default", "stable", "canary", 100, 0)
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), hr)
	router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{HTTPRoute: "test-route"}, client, "stable", "canary", "default")

	err := router.SetHeaderRoute(context.Background(), "X-Canary", "true", "canary")
	require.Error(t, err)
	assert.ErrorContains(t, err, "does not support")
}

func TestGatewayAPIRouterMirrorNotSupported(t *testing.T) {
	hr := newFakeHTTPRoute("test-route", "default", "stable", "canary", 100, 0)
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), hr)
	router := gatewayapi.NewRouter(&paprikav1.GatewayAPIRouterConfig{HTTPRoute: "test-route"}, client, "stable", "canary", "default")

	err := router.SetMirror(context.Background(), 50)
	require.Error(t, err)
	assert.ErrorContains(t, err, "does not support")
}

package istio_test

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
			vs := newFakeVS("test-vs", "default", tt.stableSvc, tt.canarySvc, tt.initialW[0], tt.initialW[1])
			client := fake.NewSimpleDynamicClient(runtimeScheme(t), vs)
			router := istio.NewRouter(&paprikav1.IstioRouterConfig{
				VirtualService: "test-vs",
			}, client, tt.stableSvc, tt.canarySvc, "default")

			err := router.SetWeight(context.Background(), tt.targetW)
			require.NoError(t, err)

			updated, err := client.Resource(vsGVR).Namespace("default").Get(context.Background(), "test-vs", metav1.GetOptions{})
			require.NoError(t, err)

			routes, _, _ := unstructured.NestedSlice(updated.Object, "spec", "http")
			require.Len(t, routes, 1)
			route, ok := routes[0].(map[string]any)
			require.True(t, ok)
			dests, ok := route["route"].([]any)
			require.True(t, ok)

			for _, d := range dests {
				dest, ok := d.(map[string]any)
				require.True(t, ok)
				host, _, _ := unstructured.NestedString(dest, "destination", "host")
				w, ok := dest["weight"].(float64)
				require.True(t, ok)
				switch host {
				case tt.stableSvc:
					assert.Equal(t, tt.wantStable, int64(w), "stable weight")
				case tt.canarySvc:
					assert.Equal(t, tt.wantCanary, int64(w), "canary weight")
				}
			}
		})
	}
}

func TestIstioRouterRemoveCanary(t *testing.T) {
	vs := newFakeVS("test-vs", "default", "stable", "canary", 70, 30)
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), vs)
	router := istio.NewRouter(&paprikav1.IstioRouterConfig{
		VirtualService: "test-vs",
	}, client, "stable", "canary", "default")

	err := router.RemoveCanary(context.Background())
	require.NoError(t, err)

	updated, err := client.Resource(vsGVR).Namespace("default").Get(context.Background(), "test-vs", metav1.GetOptions{})
	require.NoError(t, err)

	routes, _, _ := unstructured.NestedSlice(updated.Object, "spec", "http")
	route, ok := routes[0].(map[string]any)
	require.True(t, ok)
	dests, ok := route["route"].([]any)
	require.True(t, ok)
	require.Len(t, dests, 1, "only stable should remain after RemoveCanary")

	dest, ok := dests[0].(map[string]any)
	require.True(t, ok)
	host, _, _ := unstructured.NestedString(dest, "destination", "host")
	assert.Equal(t, "stable", host)
	w, ok := dest["weight"].(float64)
	require.True(t, ok)
	assert.Equal(t, float64(100), w)
}

func TestIstioRouterVirtualServiceNotFound(t *testing.T) {
	client := fake.NewSimpleDynamicClient(runtimeScheme(t))
	router := istio.NewRouter(&paprikav1.IstioRouterConfig{}, client, "stable", "canary", "default")

	err := router.SetWeight(context.Background(), 30)
	require.Error(t, err)
	assert.True(t, errors.IsNotFound(err), "should return not found error")
}

func TestIstioRouterRoutesByName(t *testing.T) {
	vs := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "networking.istio.io/v1beta1",
			"kind":       "VirtualService",
			"metadata": map[string]any{
				"name":      "test-vs",
				"namespace": "default",
			},
			"spec": map[string]any{
				"hosts": []any{"example.com"},
				"http": []any{
					map[string]any{
						"name": "v1",
						"route": []any{
							map[string]any{
								"destination": map[string]any{"host": "stable"},
								"weight":      float64(100),
							},
							map[string]any{
								"destination": map[string]any{"host": "canary"},
								"weight":      float64(0),
							},
						},
					},
					map[string]any{
						"name": "v2",
						"route": []any{
							map[string]any{
								"destination": map[string]any{"host": "stable"},
								"weight":      float64(100),
							},
							map[string]any{
								"destination": map[string]any{"host": "canary"},
								"weight":      float64(0),
							},
						},
					},
				},
			},
		},
	}
	client := fake.NewSimpleDynamicClient(runtimeScheme(t), vs)
	router := istio.NewRouter(&paprikav1.IstioRouterConfig{
		VirtualService: "test-vs",
		Routes:         []string{"v1"},
	}, client, "stable", "canary", "default")

	err := router.SetWeight(context.Background(), 30)
	require.NoError(t, err)

	updated, err := client.Resource(vsGVR).Namespace("default").Get(context.Background(), "test-vs", metav1.GetOptions{})
	require.NoError(t, err)

	routes, _, _ := unstructured.NestedSlice(updated.Object, "spec", "http")
	require.Len(t, routes, 2)

	v1Route, ok := routes[0].(map[string]any)
	require.True(t, ok)
	v1Dests, ok := v1Route["route"].([]any)
	require.True(t, ok)
	v1Dest0, ok := v1Dests[0].(map[string]any)
	require.True(t, ok)
	v1Dest1, ok := v1Dests[1].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, float64(70), v1Dest0["weight"], "v1 stable should be 70")
	assert.Equal(t, float64(30), v1Dest1["weight"], "v1 canary should be 30")

	v2Route, ok := routes[1].(map[string]any)
	require.True(t, ok)
	v2Dests, ok := v2Route["route"].([]any)
	require.True(t, ok)
	v2Dest0, ok := v2Dests[0].(map[string]any)
	require.True(t, ok)
	v2Dest1, ok := v2Dests[1].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, float64(100), v2Dest0["weight"], "v2 stable should remain 100 (not patched)")
	assert.Equal(t, float64(0), v2Dest1["weight"], "v2 canary should remain 0 (not patched)")
}

func runtimeScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	return runtime.NewScheme()
}

package engine

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery/fake"
	kTesting "k8s.io/client-go/testing"
)

func TestCachedGVRResolver_FastPath(t *testing.T) {
	t.Parallel()
	r := NewCachedGVRResolver(nil)
	gvr, err := r.Resolve(context.Background(), "", "v1", "Service")
	if err != nil {
		t.Fatal(err)
	}
	if gvr.Resource != "services" || gvr.Group != "" || gvr.Version != "v1" {
		t.Errorf("unexpected GVR: %v", gvr)
	}
}

func TestCachedGVRResolver_FastPathGroupAware(t *testing.T) {
	t.Parallel()
	r := NewCachedGVRResolver(nil)
	// Knative Service must NOT resolve to core services.
	gvr, err := r.Resolve(context.Background(), "serving.knative.dev", "v1", "Service")
	if err != nil {
		t.Fatal(err)
	}
	if gvr.Group != "serving.knative.dev" || gvr.Version != "v1" || gvr.Resource != "services" {
		t.Errorf("unexpected GVR: %v", gvr)
	}
}

func TestCachedGVRResolver_DiscoveryFallback(t *testing.T) {
	t.Parallel()

	fakeDiscovery := &fake.FakeDiscovery{Fake: &kTesting.Fake{
		Resources: []*metav1.APIResourceList{
			{
				GroupVersion: "serving.knative.dev/v1",
				APIResources: []metav1.APIResource{
					{Name: "services", Kind: "Service", Namespaced: true},
					{Name: "routes", Kind: "Route", Namespaced: true},
					{Name: "configurations", Kind: "Configuration", Namespaced: true},
				},
			},
		},
	}}

	r := NewCachedGVRResolver(fakeDiscovery)
	gvr, err := r.Resolve(context.Background(), "serving.knative.dev", "v1", "Configuration")
	if err != nil {
		t.Fatal(err)
	}
	if gvr.Resource != "configurations" {
		t.Errorf("unexpected resource: %v", gvr.Resource)
	}
}

func TestCachedGVRResolver_PluralizationFallback(t *testing.T) {
	t.Parallel()
	r := NewCachedGVRResolver(nil)
	gvr, err := r.Resolve(context.Background(), "custom.io", "v1", "Widget")
	if err != nil {
		t.Fatal(err)
	}
	if gvr.Resource != "widgets" {
		t.Errorf("unexpected resource: %v", gvr.Resource)
	}
}

// BenchmarkCachedGVRResolverParallel measures the steady-state read path: a
// warm cache resolved concurrently, which is what every apply and diff does.
// The cache holds one entry per GroupVersion and never rewrites it, so the
// only thing being measured is the cost of a concurrent lookup.
func BenchmarkCachedGVRResolverParallel(b *testing.B) {
	fakeDiscovery := &fake.FakeDiscovery{Fake: &kTesting.Fake{
		Resources: []*metav1.APIResourceList{{
			GroupVersion: "apps/v1",
			APIResources: []metav1.APIResource{
				{Name: "deployments", Kind: "Deployment", Namespaced: true},
				{Name: "statefulsets", Kind: "StatefulSet", Namespaced: true},
				{Name: "daemonsets", Kind: "DaemonSet", Namespaced: true},
			},
		}},
	}}

	r := NewCachedGVRResolver(fakeDiscovery)
	ctx := b.Context()
	// Warm the entry so the benchmark measures lookups, not discovery.
	if _, err := r.Resolve(ctx, "apps", "v1", "Deployment"); err != nil {
		b.Fatalf("warming the cache: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := r.Resolve(ctx, "apps", "v1", "StatefulSet"); err != nil {
				b.Fatalf("resolving: %v", err)
			}
		}
	})
}

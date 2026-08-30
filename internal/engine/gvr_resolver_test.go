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

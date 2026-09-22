package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

var networkPolicyGVR = schema.GroupVersionResource{
	Group:    "networking.k8s.io",
	Version:  "v1",
	Resource: "networkpolicies",
}

func networkPolicyScheme() *runtime.Scheme {
	s := runtime.NewScheme()
	s.AddKnownTypeWithName(networkPolicyGVR.GroupVersion().WithKind("NetworkPolicyList"), &unstructured.UnstructuredList{})
	s.AddKnownTypeWithName(networkPolicyGVR.GroupVersion().WithKind("NetworkPolicy"), &unstructured.Unstructured{})
	return s
}

func newTestCache(client *dynamicfake.FakeDynamicClient) *LiveResourceCache {
	c := NewLiveResourceCache(client)
	// Without this the test would sit out the production timeout to observe a
	// failure the fake client reports immediately.
	c.syncTimeout = 200 * time.Millisecond
	return c
}

// TestGetFailsWhenTheInformerCannotSync is the regression test for a silent
// wrong answer, not a crash.
//
// The informer watches every namespace, so a controller granted a resource only
// in the namespaces it deploys to cannot establish the watch. Before this, the
// sync failure was discarded and the lister answered from an empty store, so
// Get returned no items and no error. A caller diffing desired against live
// then concluded the cluster held none of that kind and reported every one of
// them missing — for a resource sitting right there in the cluster, correct and
// untouched. The application never converged, and re-sync ran on every
// reconcile, forever.
func TestGetFailsWhenTheInformerCannotSync(t *testing.T) {
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme())
	// Deny the list the informer needs, exactly as RBAC would.
	client.PrependReactor("list", "networkpolicies", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("networkpolicies is forbidden: cluster scope")
	})

	items, err := newTestCache(client).Get(context.Background(), networkPolicyGVR, "dns", labels.Everything())

	if err == nil {
		t.Fatalf("Get returned no error with %d items; an unsynced cache must not be reported as an "+
			"empty cluster, because the caller cannot tell the two apart and will treat every live "+
			"resource of this kind as missing", len(items))
	}
	if items != nil {
		t.Errorf("items = %v, want nil alongside the error", items)
	}
}

// A second caller must not pay the sync timeout again to reach a conclusion the
// cache has already reached, and must still get the error rather than silently
// succeeding against a torn-down informer.
func TestUnsyncedInformerFailsFastOnTheSecondCall(t *testing.T) {
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme())
	client.PrependReactor("list", "networkpolicies", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("networkpolicies is forbidden: cluster scope")
	})
	cache := newTestCache(client)

	if _, err := cache.Get(context.Background(), networkPolicyGVR, "dns", labels.Everything()); err == nil {
		t.Fatal("first Get should have failed")
	}

	start := time.Now()
	_, err := cache.Get(context.Background(), networkPolicyGVR, "dns", labels.Everything())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("second Get returned no error; the cache forgot that this informer cannot sync")
	}
	if elapsed >= cache.syncTimeout {
		t.Errorf("second Get took %s, at least the %s sync timeout: it waited out the sync again "+
			"instead of failing fast on what it already knew", elapsed, cache.syncTimeout)
	}
}

// The failed informer must not be left running, or a controller that touches a
// forbidden kind accumulates a goroutine and a watch attempt per reconcile.
func TestUnsyncedInformerIsTornDown(t *testing.T) {
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme())
	client.PrependReactor("list", "networkpolicies", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("networkpolicies is forbidden: cluster scope")
	})
	cache := newTestCache(client)

	if _, err := cache.Get(context.Background(), networkPolicyGVR, "dns", labels.Everything()); err == nil {
		t.Fatal("Get should have failed")
	}

	cache.mu.RLock()
	defer cache.mu.RUnlock()
	key := networkPolicyGVR.String()
	if _, ok := cache.factories[key]; ok {
		t.Error("the informer that could not sync is still registered; it will keep retrying a watch it cannot establish")
	}
	if _, ok := cache.stopChans[key]; ok {
		t.Error("the informer's stop channel is still registered, so it was never stopped")
	}
	if _, ok := cache.unsynced[key]; !ok {
		t.Error("the GVR was not recorded as unsynced, so the next call pays the timeout again")
	}
}

// The success path must still work: a cache that syncs returns what is there.
func TestGetReturnsLiveResourcesWhenTheInformerSyncs(t *testing.T) {
	existing := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "networking.k8s.io/v1",
		"kind":       "NetworkPolicy",
		"metadata":   map[string]interface{}{"name": "dns-otel-collector", "namespace": "dns"},
	}}
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme(), existing)

	items, err := newTestCache(client).Get(context.Background(), networkPolicyGVR, "dns", labels.Everything())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if got := items[0].GetName(); got != "dns-otel-collector" {
		t.Errorf("name = %q, want %q", got, "dns-otel-collector")
	}
}

var _ = metav1.NamespaceAll

package engine

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

// answerAccessReviews makes the fake API server answer every
// SelfSubjectAccessReview with allowed, and counts list calls on the resource.
func answerAccessReviews(client *dynamicfake.FakeDynamicClient, allowed bool) *atomic.Int32 {
	client.PrependReactor("create", "selfsubjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
		create, ok := action.(k8stesting.CreateAction)
		if !ok {
			return false, nil, nil
		}
		review, ok := create.GetObject().(*unstructured.Unstructured)
		if !ok {
			return false, nil, nil
		}
		review = review.DeepCopy()
		_ = unstructured.SetNestedField(review.Object, allowed, "status", "allowed")
		return true, review, nil
	})
	var lists atomic.Int32
	client.PrependReactor("list", "networkpolicies", func(k8stesting.Action) (bool, runtime.Object, error) {
		lists.Add(1)
		return false, nil, nil
	})
	return &lists
}

func TestClusterWatchDeniedByRBACSkipsTheInformer(t *testing.T) {
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme())
	lists := answerAccessReviews(client, false)
	cache := newTestCache(client)

	start := time.Now()
	items, err := cache.Get(context.Background(), networkPolicyGVR, "dns", labels.Everything())
	elapsed := time.Since(start)

	if err == nil || !strings.Contains(err.Error(), "not allowed at cluster scope") {
		t.Fatalf("Get = %d items, err %v; want the cluster-scope denial so callers fall back to namespaced reads", len(items), err)
	}
	if n := lists.Load(); n != 0 {
		t.Errorf("informer listed %d times; a denied watch must not start, because each retry logs a forbidden error", n)
	}
	if elapsed >= cache.syncTimeout {
		t.Errorf("Get took %s, at least the %s sync timeout; a denied watch must fail at once", elapsed, cache.syncTimeout)
	}
	if _, err := cache.Get(context.Background(), networkPolicyGVR, "dns", labels.Everything()); err == nil {
		t.Error("second Get succeeded; the denial must be remembered")
	}
}

func TestClusterWatchAllowedStillUsesTheInformer(t *testing.T) {
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme())
	lists := answerAccessReviews(client, true)

	if _, err := newTestCache(client).Get(context.Background(), networkPolicyGVR, "dns", labels.Everything()); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if lists.Load() == 0 {
		t.Error("an allowed watch did not start the informer")
	}
}

// The default fake client echoes a review without a status. That stands for any
// review the cache cannot read, and the informer path must decide as before.
func TestUnreadableAccessReviewKeepsTheInformerPath(t *testing.T) {
	client := dynamicfake.NewSimpleDynamicClient(networkPolicyScheme())
	if denied := newTestCache(client).clusterWatchDenied(context.Background(), networkPolicyGVR); denied {
		t.Fatal("a review without a status was treated as a denial")
	}
	if _, err := newTestCache(client).Get(context.Background(), networkPolicyGVR, "dns", labels.Everything()); err != nil {
		t.Fatalf("Get: %v", err)
	}
}

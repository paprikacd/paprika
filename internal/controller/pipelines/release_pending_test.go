package pipelines

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// TestPendingReleaseRechecksWhileAnotherReleaseIsActive pins the requeue that
// makes the concurrency guard recoverable.
//
// Nothing notifies a parked release when the release ahead of it finishes, so a
// Pending phase without a requeue waits for an unrelated event — a release that
// looks wedged for no reason an operator can see.
func TestPendingReleaseRechecksWhileAnotherReleaseIsActive(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := paprikav1.AddToScheme(scheme); err != nil {
		t.Fatalf("add scheme: %v", err)
	}

	active := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{Target: "web-eu"},
		Status:     paprikav1.ReleaseStatus{Phase: paprikav1.ReleasePromoting},
	}
	parked := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "web-2", Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{Target: "web-eu"},
		Status:     paprikav1.ReleaseStatus{Phase: paprikav1.ReleasePending},
	}

	r := &ReleaseReconciler{client: fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(active, parked).
		WithStatusSubresource(&paprikav1.Release{}).
		Build()}

	result := ""
	got, err := r.handlePendingPhase(context.Background(), parked, &result)
	if err != nil {
		t.Fatalf("handlePendingPhase: %v", err)
	}
	if got.RequeueAfter != concurrentReleaseRequeue {
		t.Fatalf("RequeueAfter = %s, want %s", got.RequeueAfter, concurrentReleaseRequeue)
	}
	if got.RequeueAfter <= 0 || got.RequeueAfter > time.Minute {
		t.Fatalf("requeue interval %s is not a sensible polling cadence", got.RequeueAfter)
	}
}

// TestPendingReleasePromotesWhenTheActiveOneIsGone is the other half: once the
// blocking release is terminal, the parked one proceeds.
func TestPendingReleasePromotesWhenTheActiveOneIsGone(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := paprikav1.AddToScheme(scheme); err != nil {
		t.Fatalf("add scheme: %v", err)
	}

	done := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{Target: "web-eu"},
		Status:     paprikav1.ReleaseStatus{Phase: paprikav1.ReleaseComplete},
	}
	parked := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "web-2", Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{Target: "web-eu"},
		Status:     paprikav1.ReleaseStatus{Phase: paprikav1.ReleasePending},
	}

	r := &ReleaseReconciler{client: fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(done, parked).
		WithStatusSubresource(&paprikav1.Release{}).
		Build()}

	result := ""
	if _, err := r.handlePendingPhase(context.Background(), parked, &result); err != nil {
		t.Fatalf("handlePendingPhase: %v", err)
	}
	if parked.Status.Phase != paprikav1.ReleasePromoting {
		t.Fatalf("phase = %s, want Promoting", parked.Status.Phase)
	}
}

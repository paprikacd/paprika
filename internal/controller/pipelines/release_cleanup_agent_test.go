package pipelines

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// TestReleaseCleanupDoesNotBlockOnAgentTargets pins the finalizer's escape
// hatch for cluster transports that cannot delete.
//
// An agent-targeted release has no dynamic client to collect its resources
// with. Returning that as an error keeps the release finalizer in place
// forever: the object cannot be deleted, and every retry fails the same way.
// The transport is documented as apply-only, so cleanup leaves the workloads
// and lets the delete finish.
func TestReleaseCleanupDoesNotBlockOnAgentTargets(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := paprikav1.AddToScheme(scheme); err != nil {
		t.Fatalf("add pipelines scheme: %v", err)
	}
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add clusters scheme: %v", err)
	}

	edge := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Satellite: &clustersv1alpha1.SatelliteSpec{}},
	}
	stage := &paprikav1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "web-sat", Namespace: "checkout"},
		Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{
			Name: "edge", Namespace: "paprika-system",
		}},
	}
	release := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{Target: "web-sat"},
	}

	r := &ReleaseReconciler{client: fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(edge, stage).Build()}

	targets, err := r.cleanupTargetClients(context.Background(), release)
	if err != nil {
		t.Fatalf("cleanupTargetClients returned an error that would hold the finalizer: %v", err)
	}
	if len(targets) != 0 {
		t.Fatalf("targets = %d, want none for an apply-only transport", len(targets))
	}
}

// TestReleaseCleanupStillFailsOnAMissingStage keeps the escape hatch narrow:
// a stage that does not exist is a real inconsistency, not an apply-only
// transport, and must still surface.
func TestReleaseCleanupStillFailsOnAMissingStage(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := paprikav1.AddToScheme(scheme); err != nil {
		t.Fatalf("add pipelines scheme: %v", err)
	}
	if err := clustersv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add clusters scheme: %v", err)
	}
	release := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{Target: "gone"},
	}
	r := &ReleaseReconciler{client: fake.NewClientBuilder().WithScheme(scheme).Build()}

	if _, err := r.cleanupTargetClients(context.Background(), release); err == nil {
		t.Fatal("a missing stage must still fail cleanup")
	}
}

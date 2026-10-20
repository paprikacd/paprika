package clusters

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// TestUpdatePhasePreservesConcurrentSatelliteStatus pins the field ownership
// split between the two status writers.
//
// The satellite reporter writes status.satellite from another process on its
// own schedule. The health check used to replace the whole status object from
// whatever it read when the reconcile started, so a report that landed in
// between was rolled back — and the reporter, seeing a stale baseline, retried
// with backoff. Once a registration carries a large application list those
// retries are measured in seconds.
func TestUpdatePhasePreservesConcurrentSatelliteStatus(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))

	stored := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "paprika-system"},
		Status: clustersv1alpha1.ClusterStatus{
			Satellite: &clustersv1alpha1.SatelliteStatus{
				SessionID: "session-current",
				Sequence:  42,
				Applications: []clustersv1alpha1.SatelliteApplication{
					{Namespace: "checkout", Name: "web", Health: "Healthy", ResourceCount: 3},
				},
			},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(stored).
		WithStatusSubresource(&clustersv1alpha1.Cluster{}).Build()
	r := &ClusterReconciler{client: c}

	// The reconcile-time snapshot predates the report: it has no satellite state.
	stale := stored.DeepCopy()
	stale.Status.Satellite = nil

	_, err := r.updatePhase(context.Background(), stale, clustersv1alpha1.ClusterPhaseHealthy, "Reachable", "healthy")
	require.NoError(t, err)

	var got clustersv1alpha1.Cluster
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Namespace: "paprika-system", Name: "edge"}, &got))
	require.NotNil(t, got.Status.Satellite, "the health check must not erase a concurrent satellite report")
	require.Equal(t, "session-current", got.Status.Satellite.SessionID)
	require.Equal(t, int64(42), got.Status.Satellite.Sequence)
	require.Len(t, got.Status.Satellite.Applications, 1)
	require.Equal(t, clustersv1alpha1.ClusterPhaseHealthy, got.Status.Phase)
	require.NotNil(t, got.Status.LastHealthCheckTime)
}

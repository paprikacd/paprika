package controller

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

type stubClusterManager struct {
	config *rest.Config
	err    error
	calls  int
}

func (s *stubClusterManager) GetRestConfig(_ context.Context, _, _ string) (*rest.Config, error) {
	s.calls++
	return s.config, s.err
}

func rolloutTargetFixture(t *testing.T, objects ...runtime.Object) (*RolloutReconciler, *stubClusterManager) {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	require.NoError(t, rolloutsv1alpha1.AddToScheme(scheme))

	manager := &stubClusterManager{config: &rest.Config{Host: "https://edge-eu.example"}}
	return &RolloutReconciler{
		Client:     fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(objects...).Build(),
		Scheme:     scheme,
		ClusterMgr: manager,
	}, manager
}

// TestForTargetWithoutAClusterStaysOnTheControlPlane covers every existing
// Rollout: no cluster field means the control plane's own cluster.
func TestForTargetWithoutAClusterStaysOnTheControlPlane(t *testing.T) {
	t.Parallel()

	r, manager := rolloutTargetFixture(t)
	ro := &rolloutsv1alpha1.Rollout{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"}}

	scoped, err := r.forTarget(context.Background(), ro)
	require.NoError(t, err)
	require.Equal(t, r.Client, scoped.workload(), "no cluster means the control plane's client")
	require.Zero(t, manager.calls, "no credential lookup should happen")
}

// TestForTargetBuildsTheClustersClients covers the multi-cluster case.
func TestForTargetBuildsTheClustersClients(t *testing.T) {
	t.Parallel()

	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-eu", Namespace: "paprika-system"},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:                clustersv1alpha1.ClusterModeDirect,
			KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "edge-eu-kubeconfig"},
		},
	}
	r, manager := rolloutTargetFixture(t, cluster)
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Cluster: &rolloutsv1alpha1.RolloutClusterRef{Name: "edge-eu", Namespace: "paprika-system"},
		},
	}

	scoped, err := r.forTarget(context.Background(), ro)
	require.NoError(t, err)
	require.Equal(t, 1, manager.calls)
	require.NotNil(t, scoped.TargetClient)
	require.NotSame(t, r.Client, scoped.workload(), "workload reads must go to the rollout's cluster")
	require.NotNil(t, scoped.workloadDynamic())

	// The shared reconciler keeps pointing at the control plane, so a second
	// concurrent rollout cannot inherit this one's connection.
	require.Nil(t, r.TargetClient)
}

// TestForTargetRefusesAnAgentCluster keeps a rollout from reporting success
// while the real workload never moved: an agent target has no API to act on.
func TestForTargetRefusesAnAgentCluster(t *testing.T) {
	t.Parallel()

	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-sat", Namespace: "paprika-system"},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:                clustersv1alpha1.ClusterModeAgent,
			KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "unused"},
		},
	}
	r, _ := rolloutTargetFixture(t, cluster)
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Cluster: &rolloutsv1alpha1.RolloutClusterRef{Name: "edge-sat", Namespace: "paprika-system"},
		},
	}

	_, err := r.forTarget(context.Background(), ro)
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "needs a direct kubeconfig"), err.Error())
}

// TestForTargetSurfacesAMissingRegistration names the cluster that was not
// found instead of silently falling back to the control plane.
func TestForTargetSurfacesAMissingRegistration(t *testing.T) {
	t.Parallel()

	r, _ := rolloutTargetFixture(t)
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Cluster: &rolloutsv1alpha1.RolloutClusterRef{Name: "gone", Namespace: "paprika-system"},
		},
	}

	_, err := r.forTarget(context.Background(), ro)
	require.Error(t, err)
	require.False(t, errors.Is(err, context.Canceled))
	require.Contains(t, err.Error(), "gone")
}

package apiserver

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func targetTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	return scheme
}

func targetTestServer(t *testing.T, objects ...runtime.Object) *PaprikaServer {
	t.Helper()
	builder := fake.NewClientBuilder().
		WithScheme(targetTestScheme(t)).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).
		WithRuntimeObjects(objects...)
	return NewPaprikaServer(builder.Build(), nil)
}

func TestApplicationTargetClusterFollowsTheActiveRelease(t *testing.T) {
	t.Parallel()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Status:     pipelinesv1alpha1.ApplicationStatus{ReleaseRef: "api-abc"},
	}
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "api-abc", Namespace: "checkout"},
		Spec:       pipelinesv1alpha1.ReleaseSpec{Target: "api-prod"},
	}
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "api-prod", Namespace: "checkout"},
		Spec: pipelinesv1alpha1.StageSpec{
			Cluster: pipelinesv1alpha1.ClusterRef{Name: "edge-eu", Namespace: "paprika-system"},
		},
	}
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-eu", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeDirect},
	}

	srv := targetTestServer(t, app, release, stage, cluster)
	target, err := srv.applicationTargetCluster(context.Background(), app)
	require.NoError(t, err)
	require.Equal(t, "paprika-system/edge-eu", target.key)
	require.False(t, target.agent, "a direct cluster can be read live")
}

func TestApplicationTargetClusterMarksAgentTargets(t *testing.T) {
	t.Parallel()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{
				Name:    "prod",
				Cluster: pipelinesv1alpha1.ClusterRef{Name: "edge-eu", Namespace: "paprika-system"},
			}},
		},
	}
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-eu", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent},
	}

	srv := targetTestServer(t, app, cluster)
	target, err := srv.applicationTargetCluster(context.Background(), app)
	require.NoError(t, err)
	require.True(t, target.agent)

	// Live reads must refuse rather than fall back to the control plane.
	_, err = srv.targetTypedClient(context.Background(), target)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrTargetUnavailable))
	require.Contains(t, err.Error(), "satellite")
}

func TestApplicationTargetClusterDefaultsToTheControlPlane(t *testing.T) {
	t.Parallel()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
		},
	}

	srv := targetTestServer(t, app)
	target, err := srv.applicationTargetCluster(context.Background(), app)
	require.NoError(t, err)
	require.Empty(t, target.key, "an empty cluster ref means this control plane's own cluster")
	require.False(t, target.agent)
}

func TestApplicationTargetClusterRefusesAnUnknownTarget(t *testing.T) {
	t.Parallel()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
				{Name: "dev", Ring: 1},
				{Name: "prod", Ring: 2},
			},
		},
	}
	srv := targetTestServer(t, app)

	// Two candidate stages and no release: there is no recorded target, and
	// guessing one would read the wrong cluster.
	_, err := srv.applicationTargetCluster(context.Background(), app)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrTargetUnavailable))
	require.Contains(t, err.Error(), "no deployment target is recorded")
}

func TestApplicationTargetClusterRefusesAnUnregisteredCluster(t *testing.T) {
	t.Parallel()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{
				Name:    "prod",
				Cluster: pipelinesv1alpha1.ClusterRef{Name: "gone", Namespace: "paprika-system"},
			}},
		},
	}
	srv := targetTestServer(t, app)

	_, err := srv.applicationTargetCluster(context.Background(), app)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrTargetUnavailable))
	require.Contains(t, err.Error(), "not registered")
}

func TestApplicationTargetClusterUsesTheReleaseCurrentStage(t *testing.T) {
	t.Parallel()

	// A release promoted through several stages records where it ended up in
	// status.currentStage when spec.target is empty.
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "checkout"},
		Status:     pipelinesv1alpha1.ApplicationStatus{ReleaseRef: "api-abc"},
	}
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "api-abc", Namespace: "checkout"},
		Status:     pipelinesv1alpha1.ReleaseStatus{CurrentStage: "api-stg"},
	}
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "api-stg", Namespace: "checkout"},
		Spec: pipelinesv1alpha1.StageSpec{
			Cluster: pipelinesv1alpha1.ClusterRef{Name: "stg", Namespace: "paprika-system"},
		},
	}
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "stg", Namespace: "paprika-system"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeDirect},
	}

	srv := targetTestServer(t, app, release, stage, cluster)
	target, err := srv.applicationTargetCluster(context.Background(), app)
	require.NoError(t, err)
	require.Equal(t, "paprika-system/stg", target.key)
}

package fleet

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestConnectionStateNormalization(t *testing.T) {
	t.Parallel()

	repository := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "source"},
		Status: corev1alpha1.RepositoryStatus{ConnectionState: &corev1alpha1.ConnectionState{
			Status: corev1alpha1.ConnectionStatusSuccessful,
		}},
	}
	repositorySummary := projectRepositorySummary(repository)
	require.Equal(t, ConnectionStateHealthy, repositorySummary.Connection)

	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "production"},
		Spec:       clustersv1alpha1.ClusterSpec{DisplayName: "Production"},
		Status:     clustersv1alpha1.ClusterStatus{Phase: clustersv1alpha1.ClusterPhaseDisabled},
	}
	clusterSummary := projectClusterSummary(cluster)
	require.Equal(t, "Production", clusterSummary.DisplayName)
	require.Equal(t, ConnectionStateDisabled, clusterSummary.Connection)
}

func TestConnectionStateNormalizationUnknownAndRecognizedValues(t *testing.T) {
	t.Parallel()

	repositoryCases := []struct {
		name       string
		connection *corev1alpha1.ConnectionState
		want       ConnectionState
	}{
		{name: "nil", want: ConnectionStateUnspecified},
		{name: "empty", connection: &corev1alpha1.ConnectionState{}, want: ConnectionStateUnspecified},
		{name: "unknown", connection: &corev1alpha1.ConnectionState{Status: corev1alpha1.ConnectionStatusUnknown}, want: ConnectionStateUnspecified},
		{name: "unrecognized", connection: &corev1alpha1.ConnectionState{Status: "Unexpected"}, want: ConnectionStateUnspecified},
		{name: "successful", connection: &corev1alpha1.ConnectionState{Status: corev1alpha1.ConnectionStatusSuccessful}, want: ConnectionStateHealthy},
		{name: "failed", connection: &corev1alpha1.ConnectionState{Status: corev1alpha1.ConnectionStatusFailed}, want: ConnectionStateUnhealthy},
	}
	for _, test := range repositoryCases {
		t.Run("repository "+test.name, func(t *testing.T) {
			repository := &corev1alpha1.Repository{
				ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "source"},
				Status:     corev1alpha1.RepositoryStatus{ConnectionState: test.connection},
			}
			require.Equal(t, test.want, projectRepositorySummary(repository).Connection)
		})
	}

	clusterCases := []struct {
		name  string
		phase clustersv1alpha1.ClusterPhase
		want  ConnectionState
	}{
		{name: "empty", want: ConnectionStateUnspecified},
		{name: "pending", phase: clustersv1alpha1.ClusterPhasePending, want: ConnectionStateUnspecified},
		{name: "unrecognized", phase: "Unexpected", want: ConnectionStateUnspecified},
		{name: "healthy", phase: clustersv1alpha1.ClusterPhaseHealthy, want: ConnectionStateHealthy},
		{name: "unhealthy", phase: clustersv1alpha1.ClusterPhaseUnhealthy, want: ConnectionStateUnhealthy},
		{name: "disabled", phase: clustersv1alpha1.ClusterPhaseDisabled, want: ConnectionStateDisabled},
	}
	for _, test := range clusterCases {
		t.Run("cluster "+test.name, func(t *testing.T) {
			candidate := cluster("apps", "production", "", test.phase)
			summary := projectClusterSummary(candidate)
			require.Equal(t, test.want, summary.Connection)
			require.Equal(t, candidate.Name, summary.DisplayName)
		})
	}

	disabledBySpec := cluster("apps", "disabled-by-spec", "", clustersv1alpha1.ClusterPhaseHealthy)
	disabledBySpec.Spec.Disabled = true
	require.Equal(t, ConnectionStateDisabled, projectClusterSummary(disabledBySpec).Connection)

	unconfigured := projectionApplication("apps", "inline-source", "inline-source-uid")
	repositoryKey, connection := projectRepositoryConnection(unconfigured, nil)
	require.Zero(t, repositoryKey)
	require.Equal(t, ConnectionStateNotConfigured, connection)
}

func TestConnectionResolutionNamespaceMissingAndInlineModes(t *testing.T) {
	t.Parallel()

	store := newFakeProjectionStore()
	app := projectionApplication("apps", "checkout", "checkout-uid")
	app.Spec.Source.RepoRef = "missing-repository"
	app.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{
		{Name: "named-explicit", Ring: 1},
		{Name: "named-missing", Ring: 2},
		{Name: "named-inline-invalid", Ring: 3},
		{Name: "control-plane", Ring: 4},
		{Name: "legacy-inline", Ring: 5},
	}
	stages := []*pipelinesv1alpha1.Stage{
		projectionStage(app, "checkout-named-explicit", "stage-1", "named-explicit", 1, pipelinesv1alpha1.ClusterRef{Name: "production", Namespace: "shared"}),
		projectionStage(app, "checkout-named-missing", "stage-2", "named-missing", 2, pipelinesv1alpha1.ClusterRef{Name: "deleted"}),
		projectionStage(app, "checkout-named-inline-invalid", "stage-3", "named-inline-invalid", 3, pipelinesv1alpha1.ClusterRef{Name: "production", Namespace: "shared", Server: "https://must-not-fallback.invalid"}),
		projectionStage(app, "checkout-control-plane", "stage-4", "control-plane", 4, pipelinesv1alpha1.ClusterRef{}),
		projectionStage(app, "checkout-legacy-inline", "stage-5", "legacy-inline", 5, pipelinesv1alpha1.ClusterRef{Mode: pipelinesv1alpha1.ClusterModeDirect, Server: "https://sensitive.invalid", KubeconfigSecret: "do-not-retain"}),
	}
	store.putApplication(app)
	for _, stage := range stages {
		store.putStage(stage)
	}
	store.putCluster(cluster("shared", "production", "Shared production", clustersv1alpha1.ClusterPhaseHealthy))

	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	result, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	require.Equal(t, uint64(1), result.ProjectionErrorCount)

	snapshot := requireSnapshot(t, index)
	summary := snapshot.Applications[clientKey(app)]
	require.Equal(t, fleetID("apps", "missing-repository"), summary.Repository)
	require.Equal(t, ConnectionStateUnhealthy, summary.RepositoryConnection)
	require.Equal(t, idSet(clientKey(app)), snapshot.ByRepository[summary.Repository])

	require.Len(t, summary.Targets, 5)
	require.Equal(t, ClusterKey{Namespace: "shared", Name: "production"}, summary.Targets[0].Cluster)
	require.Equal(t, "Shared production", summary.Targets[0].ClusterLabel)
	require.Equal(t, ConnectionStateHealthy, summary.Targets[0].ClusterConnection)
	require.False(t, summary.Targets[0].UnmanagedInlineCluster)

	require.Equal(t, ClusterKey{Namespace: "apps", Name: "deleted"}, summary.Targets[1].Cluster)
	require.Equal(t, "deleted", summary.Targets[1].ClusterLabel)
	require.Equal(t, ConnectionStateUnhealthy, summary.Targets[1].ClusterConnection)
	require.Equal(t, idSet(clientKey(app)), snapshot.ByCluster[summary.Targets[1].Cluster])

	require.Equal(t, ClusterKey{Namespace: "shared", Name: "production"}, summary.Targets[2].Cluster)
	require.Equal(t, "production", summary.Targets[2].ClusterLabel)
	require.Equal(t, ConnectionStateUnhealthy, summary.Targets[2].ClusterConnection)
	require.False(t, summary.Targets[2].UnmanagedInlineCluster)
	require.Equal(t, idSet(clientKey(app)), snapshot.ByCluster[summary.Targets[2].Cluster])

	require.Zero(t, summary.Targets[3].Cluster)
	require.Equal(t, inlineClusterLabel, summary.Targets[3].ClusterLabel)
	require.Equal(t, ConnectionStateNotConfigured, summary.Targets[3].ClusterConnection)
	require.False(t, summary.Targets[3].UnmanagedInlineCluster)

	require.Zero(t, summary.Targets[4].Cluster)
	require.Equal(t, inlineClusterLabel, summary.Targets[4].ClusterLabel)
	require.Equal(t, ConnectionStateNotConfigured, summary.Targets[4].ClusterConnection)
	require.True(t, summary.Targets[4].UnmanagedInlineCluster)

	for _, retained := range snapshot.Clusters {
		require.NotContains(t, retained.DisplayName, "sensitive")
		require.NotContains(t, retained.DisplayName, "do-not-retain")
	}
}

func TestConnectionUpdateDeleteRecreateIsTargetedAndCopyOnWrite(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	unrelated := projectionApplication("apps", "unrelated", "unrelated-uid")
	unrelated.Spec.Project = "other"
	store.putApplication(unrelated)

	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	before := requireSnapshot(t, index)
	repositoryKey := fleetID("apps", "source")
	clusterKey := fleetID("apps", "prod")
	require.Equal(t, ConnectionStateHealthy, before.Applications[appID].RepositoryConnection)
	require.Equal(t, ConnectionStateHealthy, before.Applications[appID].Targets[0].ClusterConnection)

	store.mutateRepository(repositoryKey, func(repository *corev1alpha1.Repository) {
		repository.Status.ConnectionState.Status = corev1alpha1.ConnectionStatusFailed
	})
	store.setApplicationGetError(clientKey(unrelated), context.Canceled)
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRepository,
		Key:  repositoryKey,
		AffectedApplications: []types.NamespacedName{
			clientKey(unrelated),
		},
	})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterRepository := requireSnapshot(t, index)
	require.Equal(t, before.Generation+1, afterRepository.Generation)
	require.Equal(t, ConnectionStateHealthy, before.Applications[appID].RepositoryConnection)
	require.Equal(t, ConnectionStateUnhealthy, afterRepository.Applications[appID].RepositoryConnection)
	require.Equal(t, ConnectionStateUnhealthy, afterRepository.Repositories[repositoryKey].Connection)
	require.Equal(t, mapIdentity(before.ByProject), mapIdentity(afterRepository.ByProject))
	require.Equal(t, mapIdentity(before.ByRepository), mapIdentity(afterRepository.ByRepository))
	store.setApplicationGetError(clientKey(unrelated), nil)

	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceRepository, Key: repositoryKey})
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.Same(t, afterRepository, requireSnapshot(t, index))

	store.deleteRepository(repositoryKey)
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceRepository, Key: repositoryKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterRepositoryDelete := requireSnapshot(t, index)
	require.NotContains(t, afterRepositoryDelete.Repositories, repositoryKey)
	require.Equal(t, repositoryKey, afterRepositoryDelete.Applications[appID].Repository)
	require.Equal(t, ConnectionStateUnhealthy, afterRepositoryDelete.Applications[appID].RepositoryConnection)
	require.Equal(t, idSet(appID), afterRepositoryDelete.ByRepository[repositoryKey])

	store.putRepository(&corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Namespace: repositoryKey.Namespace, Name: repositoryKey.Name},
		Status: corev1alpha1.RepositoryStatus{ConnectionState: &corev1alpha1.ConnectionState{
			Status: corev1alpha1.ConnectionStatusSuccessful,
		}},
	})
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceRepository, Key: repositoryKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	require.Equal(t, ConnectionStateHealthy, requireSnapshot(t, index).Applications[appID].RepositoryConnection)

	store.deleteCluster(clusterKey)
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceCluster, Key: clusterKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterClusterDelete := requireSnapshot(t, index)
	require.NotContains(t, afterClusterDelete.Clusters, clusterKey)
	require.Equal(t, clusterKey, afterClusterDelete.Applications[appID].Targets[0].Cluster)
	require.Equal(t, "prod", afterClusterDelete.Applications[appID].Targets[0].ClusterLabel)
	require.Equal(t, ConnectionStateUnhealthy, afterClusterDelete.Applications[appID].Targets[0].ClusterConnection)
	require.Equal(t, idSet(appID), afterClusterDelete.ByCluster[clusterKey])

	store.putCluster(cluster("apps", "prod", "Production restored", clustersv1alpha1.ClusterPhaseHealthy))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceCluster, Key: clusterKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	restored := requireSnapshot(t, index)
	require.Equal(t, "Production restored", restored.Applications[appID].Targets[0].ClusterLabel)
	require.Equal(t, ConnectionStateHealthy, restored.Applications[appID].Targets[0].ClusterConnection)
}

func TestConnectionApplicationAndStageBindingMovesUpdateReverseSets(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	store.putRepository(&corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Namespace: appID.Namespace, Name: "source-next"},
		Status: corev1alpha1.RepositoryStatus{ConnectionState: &corev1alpha1.ConnectionState{
			Status: corev1alpha1.ConnectionStatusSuccessful,
		}},
	})
	store.putCluster(cluster(appID.Namespace, "prod-next", "Production next", clustersv1alpha1.ClusterPhaseHealthy))
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)

	oldRepository := fleetID(appID.Namespace, "source")
	newRepository := fleetID(appID.Namespace, "source-next")
	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Spec.Source.RepoRef = newRepository.Name
	})
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.True(t, result.Changed)
	snapshot := requireSnapshot(t, index)
	require.NotContains(t, snapshot.ByRepository, oldRepository)
	require.Equal(t, idSet(appID), snapshot.ByRepository[newRepository])

	stageKey := fleetID(appID.Namespace, "checkout-prod-runtime")
	oldCluster := fleetID(appID.Namespace, "prod")
	newCluster := fleetID(appID.Namespace, "prod-next")
	store.mutateStage(stageKey, func(stage *pipelinesv1alpha1.Stage) {
		stage.Spec.Cluster = pipelinesv1alpha1.ClusterRef{Name: newCluster.Name}
	})
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceStage, Key: stageKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	snapshot = requireSnapshot(t, index)
	require.NotContains(t, snapshot.ByCluster, oldCluster)
	require.Equal(t, idSet(appID), snapshot.ByCluster[newCluster])
	require.Equal(t, "Production next", snapshot.Applications[appID].Targets[0].ClusterLabel)
}

func (s *fakeProjectionStore) mutateRepository(
	key types.NamespacedName,
	mutate func(*corev1alpha1.Repository),
) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutate(s.repositories[key])
}

func (s *fakeProjectionStore) deleteRepository(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.repositories, key)
}

func (s *fakeProjectionStore) deleteCluster(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clusters, key)
}

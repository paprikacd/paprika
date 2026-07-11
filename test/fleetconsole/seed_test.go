package main

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/stretchr/testify/require"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestSeedFixtureRejectsUnsafeApplicationCounts(t *testing.T) {
	t.Parallel()

	for _, count := range []int{-1, 0, 100_001} {
		_, err := seedFixture(context.Background(), count)
		require.Error(t, err, "count %d", count)
	}
}

func TestSeedFixtureHonorsCanceledContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := seedFixture(ctx, 5)
	require.ErrorIs(t, err, context.Canceled)
}

func TestSeedFixturePublishesDeterministicRealObjectStates(t *testing.T) {
	t.Parallel()

	fixture, err := seedFixture(context.Background(), 5)
	require.NoError(t, err)
	require.NotNil(t, fixture)
	require.NotNil(t, fixture.client)
	require.NotNil(t, fixture.index)
	require.NotNil(t, fixture.scheme)

	coreObject, err := fixture.scheme.New(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"})
	require.NoError(t, err, "the fixture scheme must include client-go types")
	require.IsType(t, &corev1.Pod{}, coreObject)

	snapshot, err := fixture.index.LoadSnapshot()
	require.NoError(t, err)
	require.Equal(t, uint64(1), snapshot.Generation)
	require.Len(t, snapshot.Applications, 5)

	assertFixtureSummary(t, snapshot, types.NamespacedName{Namespace: "team-00", Name: "checkout-service"}, expectedFixtureSummary{
		project:              "payments",
		health:               fleet.HealthHealthy,
		sync:                 fleet.SyncStateSynced,
		release:              fleet.ReleaseStateComplete,
		rollout:              fleet.RolloutStateHealthy,
		repositoryConnection: fleet.ConnectionStateHealthy,
		clusterConnection:    fleet.ConnectionStateHealthy,
		sourceType:           fleet.SourceTypeGit,
	})
	assertFixtureSummary(t, snapshot, types.NamespacedName{Namespace: "team-01", Name: "application-00001"}, expectedFixtureSummary{
		project:              "commerce",
		health:               fleet.HealthDegraded,
		sync:                 fleet.SyncStateUnknown,
		release:              fleet.ReleaseStateFailed,
		rollout:              fleet.RolloutStateDegraded,
		repositoryConnection: fleet.ConnectionStateUnhealthy,
		clusterConnection:    fleet.ConnectionStateUnhealthy,
		sourceType:           fleet.SourceTypeHelm,
	})
	assertFixtureSummary(t, snapshot, types.NamespacedName{Namespace: "team-02", Name: "application-00002"}, expectedFixtureSummary{
		project:              "fulfillment",
		health:               fleet.HealthHealthy,
		sync:                 fleet.SyncStateOutOfSync,
		release:              fleet.ReleaseStateComplete,
		rollout:              fleet.RolloutStateHealthy,
		repositoryConnection: fleet.ConnectionStateHealthy,
		clusterConnection:    fleet.ConnectionStateHealthy,
		sourceType:           fleet.SourceTypeKustomize,
		driftCount:           3,
	})
	assertFixtureSummary(t, snapshot, types.NamespacedName{Namespace: "team-03", Name: "application-00003"}, expectedFixtureSummary{
		project:              "platform",
		health:               fleet.HealthProgressing,
		sync:                 fleet.SyncStateSynced,
		release:              fleet.ReleaseStatePromoting,
		rollout:              fleet.RolloutStateProgressing,
		repositoryConnection: fleet.ConnectionStateHealthy,
		clusterConnection:    fleet.ConnectionStateHealthy,
		sourceType:           fleet.SourceTypeOCI,
	})
	assertFixtureSummary(t, snapshot, types.NamespacedName{Namespace: "team-04", Name: "application-00004"}, expectedFixtureSummary{
		project:              "payments",
		health:               fleet.HealthProgressing,
		sync:                 fleet.SyncStateSynced,
		release:              fleet.ReleaseStateAwaitingApproval,
		rollout:              fleet.RolloutStatePaused,
		repositoryConnection: fleet.ConnectionStateHealthy,
		clusterConnection:    fleet.ConnectionStateHealthy,
		sourceType:           fleet.SourceTypeS3,
		blockedGateCount:     1,
	})

	assertRealFixtureAssociations(t, fixture.client)
}

func TestSeedFixtureSharesConnectionObjectsAndIsRepeatable(t *testing.T) {
	t.Parallel()

	first, err := seedFixture(context.Background(), 25)
	require.NoError(t, err)
	second, err := seedFixture(context.Background(), 25)
	require.NoError(t, err)

	firstSnapshot, err := first.index.LoadSnapshot()
	require.NoError(t, err)
	secondSnapshot, err := second.index.LoadSnapshot()
	require.NoError(t, err)
	require.Equal(t, firstSnapshot.Applications, secondSnapshot.Applications)
	require.Equal(t, firstSnapshot.Projects, secondSnapshot.Projects)
	require.Equal(t, firstSnapshot.Repositories, secondSnapshot.Repositories)
	require.Equal(t, firstSnapshot.Clusters, secondSnapshot.Clusters)

	var applications pipelinesv1alpha1.ApplicationList
	require.NoError(t, first.client.List(context.Background(), &applications))
	require.Len(t, applications.Items, 25)
	var stages pipelinesv1alpha1.StageList
	require.NoError(t, first.client.List(context.Background(), &stages))
	require.Len(t, stages.Items, 25)
	var releases pipelinesv1alpha1.ReleaseList
	require.NoError(t, first.client.List(context.Background(), &releases))
	require.Len(t, releases.Items, 25)
	var rollouts rolloutsv1alpha1.RolloutList
	require.NoError(t, first.client.List(context.Background(), &rollouts))
	require.Len(t, rollouts.Items, 25)

	var repositories corev1alpha1.RepositoryList
	require.NoError(t, first.client.List(context.Background(), &repositories))
	require.LessOrEqual(t, len(repositories.Items), 24, "repositories should be shared by namespace")
	var clusters clustersv1alpha1.ClusterList
	require.NoError(t, first.client.List(context.Background(), &clusters))
	require.LessOrEqual(t, len(clusters.Items), 24, "clusters should be shared by namespace")
	var projects corev1alpha1.AppProjectList
	require.NoError(t, first.client.List(context.Background(), &projects))
	require.LessOrEqual(t, len(projects.Items), 48, "projects should be shared by namespace and project")
}

type expectedFixtureSummary struct {
	project              string
	health               fleet.Health
	sync                 fleet.SyncState
	release              fleet.ReleaseState
	rollout              fleet.RolloutState
	repositoryConnection fleet.ConnectionState
	clusterConnection    fleet.ConnectionState
	sourceType           fleet.SourceType
	driftCount           uint32
	blockedGateCount     uint32
}

func assertFixtureSummary(
	t *testing.T,
	snapshot *fleet.Snapshot,
	key types.NamespacedName,
	want expectedFixtureSummary,
) {
	t.Helper()

	summary, ok := snapshot.Applications[key]
	require.True(t, ok, "missing fixture application %s", key)
	require.Equal(t, types.NamespacedName{Namespace: key.Namespace, Name: want.project}, summary.Project)
	require.Equal(t, want.health, summary.Health)
	require.Equal(t, want.sync, summary.Sync)
	require.Equal(t, want.release, summary.ReleaseState)
	require.Equal(t, want.rollout, summary.RolloutState)
	require.Equal(t, want.repositoryConnection, summary.RepositoryConnection)
	require.Equal(t, want.sourceType, summary.SourceType)
	require.Equal(t, want.driftCount, summary.DriftCount)
	require.Equal(t, want.blockedGateCount, summary.BlockedGateCount)
	require.Equal(t, "production", summary.CurrentStage)
	require.Len(t, summary.Targets, 1)
	require.Equal(t, want.clusterConnection, summary.Targets[0].ClusterConnection)
	require.NotZero(t, summary.LastTransitionUnixMS)
}

func assertRealFixtureAssociations(t *testing.T, reader client.Reader) {
	t.Helper()

	ctx := context.Background()
	appKey := types.NamespacedName{Namespace: "team-04", Name: "application-00004"}
	app := &pipelinesv1alpha1.Application{}
	require.NoError(t, reader.Get(ctx, appKey, app))
	require.NotEmpty(t, app.UID)

	stage := &pipelinesv1alpha1.Stage{}
	require.NoError(t, reader.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Name + "-production"}, stage))
	require.Equal(t, app.Name, stage.Labels["app.paprika.io/name"])
	assertControllerOwner(t, stage.OwnerReferences, "Application", app.Name, app.UID)

	release := &pipelinesv1alpha1.Release{}
	require.NoError(t, reader.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}, release))
	require.Equal(t, app.Name, release.Labels["app.paprika.io/name"])
	assertControllerOwner(t, release.OwnerReferences, "Application", app.Name, app.UID)
	require.Equal(t, pipelinesv1alpha1.ReleaseAwaitingApproval, release.Status.Phase)

	rollout := &rolloutsv1alpha1.Rollout{}
	require.NoError(t, reader.Get(ctx, types.NamespacedName{Namespace: release.Namespace, Name: release.Status.RolloutRef}, rollout))
	require.Equal(t, app.Name, rollout.Labels["app.paprika.io/name"])
	assertControllerOwner(t, rollout.OwnerReferences, "Release", release.Name, release.UID)
	require.Equal(t, rolloutsv1alpha1.RolloutPhasePaused, rollout.Status.Phase)
}

func assertControllerOwner(
	t *testing.T,
	owners []metav1.OwnerReference,
	kind, name string,
	uid types.UID,
) {
	t.Helper()
	require.Len(t, owners, 1)
	require.NotNil(t, owners[0].Controller)
	require.True(t, *owners[0].Controller)
	require.Equal(t, pipelinesv1alpha1.GroupVersion.String(), owners[0].APIVersion)
	require.Equal(t, kind, owners[0].Kind)
	require.Equal(t, name, owners[0].Name)
	require.Equal(t, uid, owners[0].UID)
}

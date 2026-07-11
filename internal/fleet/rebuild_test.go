package fleet

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

func TestRebuildInitialBuildListsAllResourcesAndPublishesGenerationOne(t *testing.T) {
	t.Parallel()

	store, appID, projectID := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)

	result, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	require.True(t, result.Changed)
	require.Zero(t, result.ProjectionErrorCount)
	require.NoError(t, index.CheckReady())

	snapshot := requireSnapshot(t, index)
	require.Equal(t, uint64(1), snapshot.Generation)
	require.Contains(t, snapshot.Projects, projectID)
	require.Equal(t, idSet(appID), snapshot.ByProject[projectID])
	require.Equal(t, "resolved-1", snapshot.Applications[appID].SourceRevision)
	require.Equal(t, ReleaseStatePromoting, snapshot.Applications[appID].ReleaseState)
	require.Equal(t, RolloutStateProgressing, snapshot.Applications[appID].RolloutState)
	require.Len(t, snapshot.Applications[appID].Targets, 1)
	require.Equal(t, ConnectionStateUnspecified, snapshot.Applications[appID].RepositoryConnection)
	require.Equal(t, ConnectionStateUnspecified, snapshot.Applications[appID].Targets[0].ClusterConnection)

	store.mu.Lock()
	defer store.mu.Unlock()
	for _, kind := range allResourceKinds() {
		require.Equalf(t, 1, store.listCalls[kind], "list call count for %v", kind)
	}
}

func TestDeltaUpdatesAndDeletesPublishExactlyOncePerVisibleChange(t *testing.T) {
	t.Parallel()

	store, appID, projectID := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)

	assertDeltaGeneration := func(want uint64, delta ResourceDelta, mutate func()) ProjectionResult {
		t.Helper()
		mutate()
		result, deltaErr := rebuilder.ApplyDelta(context.Background(), delta)
		require.NoError(t, deltaErr)
		require.Equal(t, want, requireSnapshot(t, index).Generation)
		return result
	}

	result := assertDeltaGeneration(2, ResourceDelta{Kind: ResourceApplication, Key: appID}, func() {
		store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
			app.Status.SourceRevision = "resolved-2"
		})
	})
	require.True(t, result.Changed)
	require.Equal(t, "resolved-2", requireSnapshot(t, index).Applications[appID].SourceRevision)

	stageID := fleetID(appID.Namespace, "checkout-prod-runtime")
	result = assertDeltaGeneration(3, ResourceDelta{
		Kind: ResourceStage, Key: stageID, AffectedApplications: []types.NamespacedName{appID, appID},
	}, func() {
		store.mutateStage(stageID, func(stage *pipelinesv1alpha1.Stage) {
			stage.Spec.Cluster.Name = "prod-2"
		})
		store.putCluster(cluster(appID.Namespace, "prod-2", "Production 2", clustersv1alpha1.ClusterPhaseHealthy))
	})
	require.True(t, result.Changed)
	require.Equal(t, "prod-2", requireSnapshot(t, index).Applications[appID].Targets[0].ClusterLabel)

	releaseID := fleetID(appID.Namespace, "release-current")
	result = assertDeltaGeneration(4, ResourceDelta{Kind: ResourceRelease, Key: releaseID, AffectedApplications: []types.NamespacedName{appID}}, func() {
		store.mutateRelease(releaseID, func(release *pipelinesv1alpha1.Release) {
			release.Status.Phase = pipelinesv1alpha1.ReleaseVerifying
		})
	})
	require.True(t, result.Changed)
	require.Equal(t, ReleaseStateVerifying, requireSnapshot(t, index).Applications[appID].ReleaseState)

	rolloutID := fleetID(appID.Namespace, "rollout-current")
	result = assertDeltaGeneration(5, ResourceDelta{Kind: ResourceRollout, Key: rolloutID, AffectedApplications: []types.NamespacedName{appID}}, func() {
		store.mutateRollout(rolloutID, func(rollout *rolloutsv1alpha1.Rollout) {
			rollout.Status.Phase = rolloutsv1alpha1.RolloutPhaseHealthy
		})
	})
	require.True(t, result.Changed)
	require.Equal(t, RolloutStateHealthy, requireSnapshot(t, index).Applications[appID].RolloutState)

	// AppProject spec is intentionally absent from ProjectSummary, so an update
	// is a real delta event but a projection no-op and does not bump generation.
	result = assertDeltaGeneration(5, ResourceDelta{Kind: ResourceAppProject, Key: projectID}, func() {
		store.mutateProject(projectID, func(project *corev1alpha1.AppProject) {
			project.Spec.Description = "updated but not projected"
		})
	})
	require.False(t, result.Changed)

	result = assertDeltaGeneration(6, ResourceDelta{Kind: ResourceRollout, Key: rolloutID, AffectedApplications: []types.NamespacedName{appID}}, func() {
		store.deleteRollout(rolloutID)
	})
	require.True(t, result.Changed)
	require.Equal(t, RolloutStateUnspecified, requireSnapshot(t, index).Applications[appID].RolloutState)

	result = assertDeltaGeneration(7, ResourceDelta{Kind: ResourceRelease, Key: releaseID, AffectedApplications: []types.NamespacedName{appID}}, func() {
		store.deleteRelease(releaseID)
	})
	require.True(t, result.Changed)
	require.Equal(t, ReleaseStateUnspecified, requireSnapshot(t, index).Applications[appID].ReleaseState)

	result = assertDeltaGeneration(8, ResourceDelta{Kind: ResourceStage, Key: stageID, AffectedApplications: []types.NamespacedName{appID}}, func() {
		store.deleteStage(stageID)
	})
	require.True(t, result.Changed)
	require.Empty(t, requireSnapshot(t, index).Applications[appID].Targets)

	result = assertDeltaGeneration(9, ResourceDelta{Kind: ResourceAppProject, Key: projectID}, func() {
		store.deleteProject(projectID)
	})
	require.True(t, result.Changed)
	snapshot := requireSnapshot(t, index)
	require.NotContains(t, snapshot.Projects, projectID)
	require.Equal(t, projectID, snapshot.Applications[appID].Project)
	require.Equal(t, idSet(appID), snapshot.ByProject[projectID])

	result = assertDeltaGeneration(10, ResourceDelta{Kind: ResourceApplication, Key: appID}, func() {
		store.deleteApplication(appID)
	})
	require.True(t, result.Changed)
	require.NotContains(t, requireSnapshot(t, index).Applications, appID)

	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.Equal(t, uint64(10), requireSnapshot(t, index).Generation)
}

func TestDeltaInvalidAssociationAndStoreFailureDoNotPublish(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)

	stageID := fleetID(appID.Namespace, "checkout-prod-runtime")
	store.mutateStage(stageID, func(stage *pipelinesv1alpha1.Stage) {
		stage.OwnerReferences = append(stage.OwnerReferences, stage.OwnerReferences[0])
	})
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceStage, Key: stageID, AffectedApplications: []types.NamespacedName{appID},
	})
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.Equal(t, uint64(1), result.ProjectionErrorCount)
	require.Same(t, prior, requireSnapshot(t, index))
	require.Len(t, prior.Applications[appID].Targets, 1)

	store.setGetError(ResourceApplication, errors.New("https://user:password@example.invalid/private"))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "password")
	require.False(t, result.Changed)
	require.Same(t, prior, requireSnapshot(t, index))
}

func TestDeltaInvalidNewCurrentRolloutCountsOneErrorWithoutPublishing(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	rolloutID := fleetID(appID.Namespace, "rollout-current")
	store.mutateRollout(rolloutID, func(rollout *rolloutsv1alpha1.Rollout) {
		rollout.OwnerReferences[0].APIVersion = "pipelines.paprika.io/v2"
	})
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	buildResult, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	require.Equal(t, uint64(1), buildResult.ProjectionErrorCount)
	prior := requireSnapshot(t, index)

	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRollout, Key: rolloutID, AffectedApplications: []types.NamespacedName{appID},
	})
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.Equal(t, uint64(1), result.ProjectionErrorCount)
	require.Same(t, prior, requireSnapshot(t, index))
}

func TestDeltaAssociationValidationStoreErrorIsFatalAndSanitized(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	releaseID := fleetID(appID.Namespace, "release-current")
	store.deleteRelease(releaseID)
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)

	app := store.application(appID)
	invalid := projectionRelease(app, releaseID.Name, "invalid-release-uid", pipelinesv1alpha1.ReleasePending)
	invalid.OwnerReferences[0].APIVersion = "pipelines.paprika.io/v2"
	store.putRelease(invalid)
	store.setGetError(ResourceApplication, errors.New("https://user:secret@example.invalid/private"))
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRelease, Key: releaseID, AffectedApplications: []types.NamespacedName{appID},
	})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret")
	require.False(t, result.Changed)
	require.Same(t, prior, requireSnapshot(t, index))
}

func TestDeltaAssociationMoveReprojectsOldAndNewApplicationsOnce(t *testing.T) {
	t.Parallel()

	store, oldID, _ := populatedProjectionStore()
	newApp := projectionApplication(oldID.Namespace, "payments", "payments-uid")
	newApp.Spec.Project = "retail"
	newApp.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}}
	newApp.Status.Health = pipelinesv1alpha1.HealthHealthy
	newApp.Status.Synced = true
	store.putApplication(newApp)

	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	stageID := fleetID(oldID.Namespace, "checkout-prod-runtime")
	store.mutateStage(stageID, func(stage *pipelinesv1alpha1.Stage) {
		stage.Labels[applicationNameLabel] = newApp.Name
		stage.OwnerReferences[0].Name = newApp.Name
		stage.OwnerReferences[0].UID = newApp.UID
	})

	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceStage,
		Key:  stageID,
		AffectedApplications: []types.NamespacedName{
			{Namespace: newApp.Namespace, Name: newApp.Name}, oldID, oldID,
		},
	})
	require.NoError(t, err)
	require.True(t, result.Changed)
	snapshot := requireSnapshot(t, index)
	require.Equal(t, uint64(2), snapshot.Generation)
	require.Empty(t, snapshot.Applications[oldID].Targets)
	require.Len(t, snapshot.Applications[clientKey(newApp)].Targets, 1)
}

func TestDeltaApplicationRefMoveRefreshesDependenciesForHintlessChildDelete(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	app := store.application(appID)
	oldReleaseID := fleetID(app.Namespace, app.Status.ReleaseRef)
	newRelease := projectionRelease(app, "release-next", "release-next-uid", pipelinesv1alpha1.ReleaseComplete)
	store.putRelease(newRelease)
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)

	store.mutateApplication(appID, func(current *pipelinesv1alpha1.Application) {
		current.Status.ReleaseRef = newRelease.Name
	})
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.True(t, result.Changed)
	require.Equal(t, ReleaseStateComplete, requireSnapshot(t, index).Applications[appID].ReleaseState)
	require.NotContains(t, rebuilder.deps.releaseOwners, oldReleaseID)
	require.Equal(t, appID, rebuilder.deps.releaseOwners[clientKey(newRelease)])

	store.deleteRelease(clientKey(newRelease))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRelease,
		Key:  clientKey(newRelease),
	})
	require.NoError(t, err)
	require.True(t, result.Changed)
	snapshot := requireSnapshot(t, index)
	require.Equal(t, uint64(3), snapshot.Generation)
	require.Equal(t, ReleaseStateUnspecified, snapshot.Applications[appID].ReleaseState)
}

func TestDeltaApplicationRefMovePersistsDependenciesWithoutPublication(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	oldReleaseID := fleetID(appID.Namespace, "release-current")
	store.mutateRelease(oldReleaseID, func(release *pipelinesv1alpha1.Release) {
		release.Status.RolloutRef = ""
	})
	store.deleteRollout(fleetID(appID.Namespace, "rollout-current"))
	app := store.application(appID)
	newRelease := projectionRelease(app, "release-same-state", "release-same-state-uid", pipelinesv1alpha1.ReleasePromoting)
	store.putRelease(newRelease)
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)

	store.mutateApplication(appID, func(current *pipelinesv1alpha1.Application) {
		current.Status.ReleaseRef = newRelease.Name
	})
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.Same(t, prior, requireSnapshot(t, index))
	require.NotContains(t, rebuilder.deps.releaseOwners, oldReleaseID)
	require.Equal(t, appID, rebuilder.deps.releaseOwners[clientKey(newRelease)])

	store.deleteRelease(clientKey(newRelease))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceRelease, Key: clientKey(newRelease)})
	require.NoError(t, err)
	require.True(t, result.Changed)
	require.Equal(t, ReleaseStateUnspecified, requireSnapshot(t, index).Applications[appID].ReleaseState)
}

func TestDeltaReleaseRolloutRefMovePersistsDependencyWithoutPublication(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	releaseID := fleetID(appID.Namespace, "release-current")
	oldRolloutID := fleetID(appID.Namespace, "rollout-current")
	app := store.application(appID)
	release := store.release(releaseID)
	newRollout := projectionRollout(
		app,
		release,
		"rollout-next",
		"rollout-next-uid",
		rolloutsv1alpha1.RolloutPhaseProgressing,
	)
	store.putRollout(newRollout)
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)
	priorReleaseOwners := rebuilder.deps.releaseOwners
	priorRolloutOwners := rebuilder.deps.rolloutOwners

	store.mutateRelease(releaseID, func(current *pipelinesv1alpha1.Release) {
		current.Status.RolloutRef = newRollout.Name
	})
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRelease,
		Key:  releaseID,
	})
	require.NoError(t, err)
	require.False(t, result.Changed, "same-state rollout ref move must not publish")
	require.Same(t, prior, requireSnapshot(t, index))
	require.Equal(t, uint64(1), prior.Generation)
	require.Equal(t, mapIdentity(priorReleaseOwners), mapIdentity(rebuilder.deps.releaseOwners))
	require.NotEqual(t, mapIdentity(priorRolloutOwners), mapIdentity(rebuilder.deps.rolloutOwners))
	require.NotContains(t, rebuilder.deps.rolloutOwners, oldRolloutID)
	require.Equal(t, appID, rebuilder.deps.rolloutOwners[clientKey(newRollout)])

	store.deleteRollout(clientKey(newRollout))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRollout,
		Key:  clientKey(newRollout),
	})
	require.NoError(t, err)
	require.True(t, result.Changed, "hintless current-rollout delete must reproject its application")
	snapshot := requireSnapshot(t, index)
	require.Equal(t, uint64(2), snapshot.Generation)
	require.Equal(t, RolloutStateUnspecified, snapshot.Applications[appID].RolloutState)
}

func TestDeltaReleaseRolloutRefClearAndDeleteCleanDependencies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*fakeProjectionStore, types.NamespacedName)
	}{
		{
			name: "clear rollout ref",
			mutate: func(store *fakeProjectionStore, releaseID types.NamespacedName) {
				store.mutateRelease(releaseID, func(release *pipelinesv1alpha1.Release) {
					release.Status.RolloutRef = ""
				})
			},
		},
		{
			name: "delete release",
			mutate: func(store *fakeProjectionStore, releaseID types.NamespacedName) {
				store.deleteRelease(releaseID)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, appID, _ := populatedProjectionStore()
			releaseID := fleetID(appID.Namespace, "release-current")
			rolloutID := fleetID(appID.Namespace, "rollout-current")
			index := NewIndex()
			rebuilder := NewRebuilder(index, store)
			_, err := rebuilder.Rebuild(context.Background())
			require.NoError(t, err)
			require.Equal(t, appID, rebuilder.deps.rolloutOwners[rolloutID])

			test.mutate(store, releaseID)
			result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
				Kind: ResourceRelease,
				Key:  releaseID,
			})
			require.NoError(t, err)
			require.True(t, result.Changed)
			require.NotContains(t, rebuilder.deps.rolloutOwners, rolloutID)
			require.Equal(t, RolloutStateUnspecified, requireSnapshot(t, index).Applications[appID].RolloutState)
		})
	}
}

func TestDeltaReleaseAssociationMoveCleansOldOwnerRolloutDependencies(t *testing.T) {
	t.Parallel()

	store, oldAppID, _ := populatedProjectionStore()
	releaseID := fleetID(oldAppID.Namespace, "release-current")
	oldRolloutID := fleetID(oldAppID.Namespace, "rollout-current")
	newApp := projectionApplication(oldAppID.Namespace, "payments", "payments-uid")
	newApp.Spec.Project = "retail"
	newApp.Status.Health = pipelinesv1alpha1.HealthHealthy
	newApp.Status.Synced = true
	newApp.Status.ReleaseRef = releaseID.Name
	store.putApplication(newApp)

	release := store.release(releaseID)
	newRollout := projectionRollout(
		newApp,
		release,
		"rollout-payments",
		"rollout-payments-uid",
		rolloutsv1alpha1.RolloutPhaseProgressing,
	)
	store.putRollout(newRollout)
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	require.Equal(t, oldAppID, rebuilder.deps.rolloutOwners[oldRolloutID])

	store.mutateApplication(oldAppID, func(app *pipelinesv1alpha1.Application) {
		app.Status.ReleaseRef = ""
	})
	store.mutateRelease(releaseID, func(current *pipelinesv1alpha1.Release) {
		current.Labels[applicationNameLabel] = newApp.Name
		current.OwnerReferences[0].Name = newApp.Name
		current.OwnerReferences[0].UID = newApp.UID
		current.Status.RolloutRef = newRollout.Name
	})
	store.mutateRollout(clientKey(newRollout), func(current *rolloutsv1alpha1.Rollout) {
		current.Labels[applicationNameLabel] = newApp.Name
	})

	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceRelease,
		Key:  releaseID,
	})
	require.NoError(t, err)
	require.True(t, result.Changed)
	newAppID := clientKey(newApp)
	require.Equal(t, newAppID, rebuilder.deps.releaseOwners[releaseID])
	require.NotContains(t, rebuilder.deps.rolloutOwners, oldRolloutID)
	require.Equal(t, newAppID, rebuilder.deps.rolloutOwners[clientKey(newRollout)])
	snapshot := requireSnapshot(t, index)
	require.Equal(t, RolloutStateUnspecified, snapshot.Applications[oldAppID].RolloutState)
	require.Equal(t, RolloutStateProgressing, snapshot.Applications[newAppID].RolloutState)
}

func TestDeltaApplicationDeleteCleansChildDependencies(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	store.deleteApplication(appID)
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.True(t, result.Changed)
	require.NotContains(t, rebuilder.deps.stageOwners, fleetID(appID.Namespace, "checkout-prod-runtime"))
	require.NotContains(t, rebuilder.deps.releaseOwners, fleetID(appID.Namespace, "release-current"))
	require.NotContains(t, rebuilder.deps.rolloutOwners, fleetID(appID.Namespace, "rollout-current"))

	prior := requireSnapshot(t, index)
	store.deleteStage(fleetID(appID.Namespace, "checkout-prod-runtime"))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceStage,
		Key:  fleetID(appID.Namespace, "checkout-prod-runtime"),
	})
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.Same(t, prior, requireSnapshot(t, index))
}

func TestSnapshotEditorOwnedSealRequiredForPublication(t *testing.T) {
	t.Parallel()

	base := NewSnapshot(1)
	base.rebuildSearchIndex()
	index := NewIndex()
	require.Error(t, index.installOwned(ownedSnapshot{snapshot: base}))

	editor := newSnapshotEditor(base)
	app := application("apps", "sealed")
	require.True(t, editor.upsertApplication(&app))
	owned, err := editor.seal(2)
	require.NoError(t, err)
	require.NoError(t, index.installOwned(owned))
	require.Equal(t, uint64(2), requireSnapshot(t, index).Generation)
}

func TestSnapshotEditorDeltaUsesOwnedCopyOnWriteAndPreservesOldSnapshots(t *testing.T) {
	store, appID, _ := populatedProjectionStore()
	for i := 0; i < 250; i++ {
		app := projectionApplication("cohort", fmt.Sprintf("cohort-%03d", i), fmt.Sprintf("cohort-uid-%03d", i))
		app.Spec.Project = "bulk"
		app.Spec.Source.Type = pipelinesv1alpha1.SourceTypeGit
		app.Status.Health = pipelinesv1alpha1.HealthHealthy
		app.Status.Synced = true
		store.putApplication(app)
	}

	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	old := requireSnapshot(t, index)
	oldCohortNamespace := old.ByNamespace["cohort"]
	oldCohortPosting := old.Trigrams["coh"]
	oldCheckoutPosting := old.Trigrams["che"]
	oldHealthy := old.ByHealth[HealthHealthy]
	oldTargets := old.Applications[appID].Targets
	oldSearchDocuments := old.searchDocuments
	oldStageDependencies := rebuilder.deps.stageOwners

	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "copy-on-write"
		app.Status.Health = pipelinesv1alpha1.HealthDegraded
	})
	_, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	updated := requireSnapshot(t, index)
	require.NotSame(t, old, updated)
	require.Equal(t, "resolved-1", old.Applications[appID].SourceRevision)
	require.Equal(t, "copy-on-write", updated.Applications[appID].SourceRevision)
	require.Equal(t, HealthHealthy, old.Applications[appID].Health)
	require.Equal(t, HealthDegraded, updated.Applications[appID].Health)
	require.Equal(t, oldTargets, old.Applications[appID].Targets)
	require.NotEqual(t, sliceDataPointer(oldTargets), sliceDataPointer(updated.Applications[appID].Targets))

	// Unchanged nested sets and postings are shared; exact health sets touched by
	// the application diff are replaced. Neither snapshot is mutated.
	require.Equal(t, mapIdentity(oldCohortNamespace), mapIdentity(updated.ByNamespace["cohort"]))
	require.Equal(t, mapIdentity(oldCohortPosting), mapIdentity(updated.Trigrams["coh"]))
	require.Equal(t, mapIdentity(oldCheckoutPosting), mapIdentity(updated.Trigrams["che"]))
	require.Equal(t, mapIdentity(oldSearchDocuments), mapIdentity(updated.searchDocuments))
	require.Equal(t, mapIdentity(oldStageDependencies), mapIdentity(rebuilder.deps.stageOwners))
	require.NotEqual(t, mapIdentity(oldHealthy), mapIdentity(updated.ByHealth[HealthHealthy]))
	require.Contains(t, oldHealthy, appID)
	require.NotContains(t, updated.ByHealth[HealthHealthy], appID)

	newApp := projectionApplication("cohort", "cohort-new", "cohort-new-uid")
	newApp.Spec.Project = "bulk"
	newApp.Status.Health = pipelinesv1alpha1.HealthHealthy
	newApp.Status.Synced = true
	newID := clientKey(newApp)
	store.putApplication(newApp)
	_, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: newID})
	require.NoError(t, err)
	afterAdd := requireSnapshot(t, index)
	require.NotEqual(t, mapIdentity(updated.Trigrams["coh"]), mapIdentity(afterAdd.Trigrams["coh"]))
	require.NotContains(t, updated.Trigrams["coh"], newID)
	require.Contains(t, afterAdd.Trigrams["coh"], newID)
}

func TestDeltaPreservesDegradedHealthUntilSuccessfulFullRebuild(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	require.NoError(t, index.SetHealth(HealthState{Degraded: true, Reason: "last rebuild failed"}))

	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "delta-while-degraded"
	})
	_, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.ErrorContains(t, index.CheckReady(), "last rebuild failed")
	require.Equal(t, "delta-while-degraded", requireSnapshot(t, index).Applications[appID].SourceRevision)

	_, err = rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	require.NoError(t, index.CheckReady())
}

func TestRebuildReplaysOrderedDeltasCapturedDuringBuildAndPublishesOnce(t *testing.T) {
	store, appID, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)

	started, proceed := store.blockNextApplicationList()
	done := make(chan error, 1)
	go func() {
		_, rebuildErr := rebuilder.Rebuild(context.Background())
		done <- rebuildErr
	}()
	<-started
	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "arrived-during-build"
	})
	queued, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	require.False(t, queued.Changed)
	close(proceed)
	require.NoError(t, <-done)

	snapshot := requireSnapshot(t, index)
	require.Equal(t, uint64(2), snapshot.Generation)
	require.Equal(t, "arrived-during-build", snapshot.Applications[appID].SourceRevision)
}

func TestRebuildFailureRetainsSnapshotAndLedgerForLaterSuccessfulRebuild(t *testing.T) {
	store, appID, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)

	started, proceed := store.blockNextApplicationList()
	store.setListError(ResourceStage, errors.New("https://user:secret@example.invalid/source"))
	done := make(chan error, 1)
	go func() {
		_, rebuildErr := rebuilder.Rebuild(context.Background())
		done <- rebuildErr
	}()
	<-started
	store.mutateApplication(appID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "retained-ledger-change"
	})
	_, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceApplication, Key: appID})
	require.NoError(t, err)
	close(proceed)
	err = <-done
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret")
	require.Same(t, prior, requireSnapshot(t, index))
	require.Equal(t, uint64(1), prior.Generation)
	require.ErrorContains(t, index.CheckReady(), "rebuild")

	store.setListError(ResourceStage, nil)
	_, err = rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	recovered := requireSnapshot(t, index)
	require.Equal(t, uint64(2), recovered.Generation)
	require.Equal(t, "retained-ledger-change", recovered.Applications[appID].SourceRevision)
	require.NoError(t, index.CheckReady())
}

func TestRebuildCancellationReturnsWithoutPublishing(t *testing.T) {
	store, _, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)

	started, _ := store.blockNextApplicationList()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, rebuildErr := rebuilder.Rebuild(ctx)
		done <- rebuildErr
	}()
	<-started
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	require.Same(t, prior, requireSnapshot(t, index))
}

func populatedProjectionStore() (*fakeProjectionStore, types.NamespacedName, ProjectKey) {
	store := newFakeProjectionStore()
	app := projectionApplication("apps", "checkout", "checkout-app-uid")
	app.Spec.Project = "retail"
	app.Spec.Source.Type = pipelinesv1alpha1.SourceTypeGit
	app.Spec.Source.RepoRef = "source"
	app.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}}
	app.Status.SourceRevision = "resolved-1"
	app.Status.Health = pipelinesv1alpha1.HealthHealthy
	app.Status.Synced = true
	app.Status.Stages = []pipelinesv1alpha1.ApplicationStageStatus{{Name: "prod", Phase: "Healthy"}}
	app.Status.CurrentStage = "prod"
	app.Status.ReleaseRef = "release-current"
	stage := projectionStage(app, "checkout-prod-runtime", "checkout-stage-uid", "prod", 1,
		pipelinesv1alpha1.ClusterRef{Name: "prod"})
	release := projectionRelease(app, "release-current", "release-current-uid", pipelinesv1alpha1.ReleasePromoting)
	release.Status.RolloutRef = "rollout-current"
	rollout := projectionRollout(app, release, "rollout-current", "rollout-current-uid", rolloutsv1alpha1.RolloutPhaseProgressing)
	project := &corev1alpha1.AppProject{ObjectMeta: metav1.ObjectMeta{Namespace: app.Namespace, Name: app.Spec.Project}}
	repository := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Namespace: app.Namespace, Name: app.Spec.Source.RepoRef},
		Status: corev1alpha1.RepositoryStatus{ConnectionState: &corev1alpha1.ConnectionState{
			Status: corev1alpha1.ConnectionStatusSuccessful,
		}},
	}
	store.putApplication(app)
	store.putStage(stage)
	store.putRelease(release)
	store.putRollout(rollout)
	store.putProject(project)
	store.putRepository(repository)
	store.putCluster(cluster(app.Namespace, "prod", "Production", clustersv1alpha1.ClusterPhaseHealthy))
	return store, clientKey(app), clientKey(project)
}

func clientKey(object metav1.Object) types.NamespacedName {
	return types.NamespacedName{Namespace: object.GetNamespace(), Name: object.GetName()}
}

func requireSnapshot(t *testing.T, index *Index) *Snapshot {
	t.Helper()
	snapshot, err := index.LoadSnapshot()
	require.NoError(t, err)
	return snapshot
}

func mapIdentity[K comparable, V any](value map[K]V) uintptr {
	return reflect.ValueOf(value).Pointer()
}

func sliceDataPointer[T any](value []T) uintptr {
	return reflect.ValueOf(value).Pointer()
}

type fakeProjectionStore struct {
	mu sync.Mutex

	applications map[types.NamespacedName]*pipelinesv1alpha1.Application
	stages       map[types.NamespacedName]*pipelinesv1alpha1.Stage
	releases     map[types.NamespacedName]*pipelinesv1alpha1.Release
	rollouts     map[types.NamespacedName]*rolloutsv1alpha1.Rollout
	projects     map[types.NamespacedName]*corev1alpha1.AppProject
	repositories map[types.NamespacedName]*corev1alpha1.Repository
	clusters     map[types.NamespacedName]*clustersv1alpha1.Cluster

	listCalls  map[ResourceKind]int
	listErrors map[ResourceKind]error
	getErrors  map[ResourceKind]error
	listBlock  *projectionListBlock
}

type projectionListBlock struct {
	started chan struct{}
	proceed chan struct{}
}

func newFakeProjectionStore() *fakeProjectionStore {
	return &fakeProjectionStore{
		applications: make(map[types.NamespacedName]*pipelinesv1alpha1.Application),
		stages:       make(map[types.NamespacedName]*pipelinesv1alpha1.Stage),
		releases:     make(map[types.NamespacedName]*pipelinesv1alpha1.Release),
		rollouts:     make(map[types.NamespacedName]*rolloutsv1alpha1.Rollout),
		projects:     make(map[types.NamespacedName]*corev1alpha1.AppProject),
		repositories: make(map[types.NamespacedName]*corev1alpha1.Repository),
		clusters:     make(map[types.NamespacedName]*clustersv1alpha1.Cluster),
		listCalls:    make(map[ResourceKind]int),
		listErrors:   make(map[ResourceKind]error),
		getErrors:    make(map[ResourceKind]error),
	}
}

func (s *fakeProjectionStore) ListApplications(ctx context.Context) ([]*pipelinesv1alpha1.Application, error) {
	s.mu.Lock()
	s.listCalls[ResourceApplication]++
	items := clonePointerMap(s.applications, func(value *pipelinesv1alpha1.Application) *pipelinesv1alpha1.Application { return value.DeepCopy() })
	err := s.listErrors[ResourceApplication]
	block := s.listBlock
	s.listBlock = nil
	s.mu.Unlock()
	if block != nil {
		close(block.started)
		select {
		case <-block.proceed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return items, err
}

func (s *fakeProjectionStore) GetApplication(_ context.Context, key types.NamespacedName) (*pipelinesv1alpha1.Application, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceApplication]; err != nil {
		return nil, false, err
	}
	value, ok := s.applications[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func (s *fakeProjectionStore) ListStages(_ context.Context) ([]*pipelinesv1alpha1.Stage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listCalls[ResourceStage]++
	return clonePointerMap(s.stages, func(value *pipelinesv1alpha1.Stage) *pipelinesv1alpha1.Stage { return value.DeepCopy() }), s.listErrors[ResourceStage]
}

func (s *fakeProjectionStore) GetStage(_ context.Context, key types.NamespacedName) (*pipelinesv1alpha1.Stage, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceStage]; err != nil {
		return nil, false, err
	}
	value, ok := s.stages[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func (s *fakeProjectionStore) ListReleases(_ context.Context) ([]*pipelinesv1alpha1.Release, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listCalls[ResourceRelease]++
	return clonePointerMap(s.releases, func(value *pipelinesv1alpha1.Release) *pipelinesv1alpha1.Release { return value.DeepCopy() }), s.listErrors[ResourceRelease]
}

func (s *fakeProjectionStore) GetRelease(_ context.Context, key types.NamespacedName) (*pipelinesv1alpha1.Release, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceRelease]; err != nil {
		return nil, false, err
	}
	value, ok := s.releases[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func (s *fakeProjectionStore) ListRollouts(_ context.Context) ([]*rolloutsv1alpha1.Rollout, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listCalls[ResourceRollout]++
	return clonePointerMap(s.rollouts, func(value *rolloutsv1alpha1.Rollout) *rolloutsv1alpha1.Rollout { return value.DeepCopy() }), s.listErrors[ResourceRollout]
}

func (s *fakeProjectionStore) GetRollout(_ context.Context, key types.NamespacedName) (*rolloutsv1alpha1.Rollout, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceRollout]; err != nil {
		return nil, false, err
	}
	value, ok := s.rollouts[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func (s *fakeProjectionStore) ListAppProjects(_ context.Context) ([]*corev1alpha1.AppProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listCalls[ResourceAppProject]++
	return clonePointerMap(s.projects, func(value *corev1alpha1.AppProject) *corev1alpha1.AppProject { return value.DeepCopy() }), s.listErrors[ResourceAppProject]
}

func (s *fakeProjectionStore) GetAppProject(_ context.Context, key types.NamespacedName) (*corev1alpha1.AppProject, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceAppProject]; err != nil {
		return nil, false, err
	}
	value, ok := s.projects[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func (s *fakeProjectionStore) ListRepositories(_ context.Context) ([]*corev1alpha1.Repository, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listCalls[ResourceRepository]++
	return clonePointerMap(s.repositories, func(value *corev1alpha1.Repository) *corev1alpha1.Repository { return value.DeepCopy() }), s.listErrors[ResourceRepository]
}

func (s *fakeProjectionStore) GetRepository(_ context.Context, key types.NamespacedName) (*corev1alpha1.Repository, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceRepository]; err != nil {
		return nil, false, err
	}
	value, ok := s.repositories[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func (s *fakeProjectionStore) ListClusters(_ context.Context) ([]*clustersv1alpha1.Cluster, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listCalls[ResourceCluster]++
	return clonePointerMap(s.clusters, func(value *clustersv1alpha1.Cluster) *clustersv1alpha1.Cluster { return value.DeepCopy() }), s.listErrors[ResourceCluster]
}

func (s *fakeProjectionStore) GetCluster(_ context.Context, key types.NamespacedName) (*clustersv1alpha1.Cluster, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.getErrors[ResourceCluster]; err != nil {
		return nil, false, err
	}
	value, ok := s.clusters[key]
	if !ok {
		return nil, false, nil
	}
	return value.DeepCopy(), true, nil
}

func clonePointerMap[K comparable, V any](source map[K]*V, clone func(*V) *V) []*V {
	items := make([]*V, 0, len(source))
	for _, value := range source {
		items = append(items, clone(value))
	}
	return items
}

func (s *fakeProjectionStore) putApplication(value *pipelinesv1alpha1.Application) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applications[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) putStage(value *pipelinesv1alpha1.Stage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stages[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) putRelease(value *pipelinesv1alpha1.Release) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releases[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) putRollout(value *rolloutsv1alpha1.Rollout) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollouts[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) putProject(value *corev1alpha1.AppProject) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.projects[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) putRepository(value *corev1alpha1.Repository) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.repositories[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) putCluster(value *clustersv1alpha1.Cluster) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clusters[clientKey(value)] = value.DeepCopy()
}

func (s *fakeProjectionStore) mutateApplication(key types.NamespacedName, mutate func(*pipelinesv1alpha1.Application)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutate(s.applications[key])
}

func (s *fakeProjectionStore) application(key types.NamespacedName) *pipelinesv1alpha1.Application {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applications[key].DeepCopy()
}

func (s *fakeProjectionStore) release(key types.NamespacedName) *pipelinesv1alpha1.Release {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.releases[key].DeepCopy()
}

func (s *fakeProjectionStore) mutateStage(key types.NamespacedName, mutate func(*pipelinesv1alpha1.Stage)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutate(s.stages[key])
}

func (s *fakeProjectionStore) mutateRelease(key types.NamespacedName, mutate func(*pipelinesv1alpha1.Release)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutate(s.releases[key])
}

func (s *fakeProjectionStore) mutateRollout(key types.NamespacedName, mutate func(*rolloutsv1alpha1.Rollout)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutate(s.rollouts[key])
}

func (s *fakeProjectionStore) mutateProject(key types.NamespacedName, mutate func(*corev1alpha1.AppProject)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutate(s.projects[key])
}

func (s *fakeProjectionStore) deleteApplication(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.applications, key)
}
func (s *fakeProjectionStore) deleteStage(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.stages, key)
}
func (s *fakeProjectionStore) deleteRelease(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.releases, key)
}
func (s *fakeProjectionStore) deleteRollout(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rollouts, key)
}
func (s *fakeProjectionStore) deleteProject(key types.NamespacedName) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.projects, key)
}

func (s *fakeProjectionStore) setGetError(kind ResourceKind, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getErrors[kind] = err
}

func (s *fakeProjectionStore) setListError(kind ResourceKind, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listErrors[kind] = err
}

func (s *fakeProjectionStore) blockNextApplicationList() (<-chan struct{}, chan<- struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	block := &projectionListBlock{started: make(chan struct{}), proceed: make(chan struct{})}
	s.listBlock = block
	return block.started, block.proceed
}

func allResourceKinds() []ResourceKind {
	return []ResourceKind{
		ResourceApplication,
		ResourceStage,
		ResourceRelease,
		ResourceRollout,
		ResourceAppProject,
		ResourceRepository,
		ResourceCluster,
	}
}

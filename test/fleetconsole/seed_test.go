package main

import (
	"context"
	"fmt"
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
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestFixtureSchemeRegistersPolicyList(t *testing.T) {
	t.Parallel()

	scheme, err := newFixtureScheme()
	require.NoError(t, err)

	object, err := scheme.New(policyv1alpha1.SchemeGroupVersion.WithKind("PolicyList"))
	require.NoError(t, err)
	require.IsType(t, &policyv1alpha1.PolicyList{}, object)
}

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
		currentStage:         "production",
		currentCluster:       "delivery-primary",
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
		currentStage:         "production",
		currentCluster:       "delivery-unhealthy",
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
		currentStage:         "production",
		currentCluster:       "delivery-primary",
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
		currentStage:         "production",
		currentCluster:       "delivery-primary",
		health:               fleet.HealthProgressing,
		sync:                 fleet.SyncStateSynced,
		release:              fleet.ReleaseStatePromoting,
		rollout:              fleet.RolloutStateProgressing,
		repositoryConnection: fleet.ConnectionStateHealthy,
		clusterConnection:    fleet.ConnectionStateHealthy,
		sourceType:           fleet.SourceTypeOCI,
	})
	assertFixtureSummary(t, snapshot, types.NamespacedName{Namespace: "team-04", Name: "application-00004"}, expectedFixtureSummary{
		project:              "governance",
		currentStage:         "staging",
		currentCluster:       "delivery-unhealthy",
		health:               fleet.HealthProgressing,
		sync:                 fleet.SyncStateSynced,
		release:              fleet.ReleaseStateAwaitingApproval,
		rollout:              fleet.RolloutStatePaused,
		repositoryConnection: fleet.ConnectionStateHealthy,
		clusterConnection:    fleet.ConnectionStateUnhealthy,
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

func TestDefaultFixtureBuildIsCompleteAssociatedAndRepeatable(t *testing.T) {
	t.Parallel()

	defaults, err := parseConfig(nil)
	require.NoError(t, err)
	require.Equal(t, 250, defaults.applications)

	first, err := seedFixture(context.Background(), defaults.applications)
	require.NoError(t, err)
	second, err := seedFixture(context.Background(), defaults.applications)
	require.NoError(t, err)

	firstInventory := readFixtureInventory(t, first.client)
	secondInventory := readFixtureInventory(t, second.client)
	require.Equal(t, firstInventory, secondInventory,
		"two default builds must preserve every generated object field and list order")
	require.Equal(t, firstInventory.fingerprint(), secondInventory.fingerprint(),
		"two default builds must preserve resource order, UIDs, and timestamps")
	firstGenerated := fixtureObjects(defaults.applications)
	secondGenerated := fixtureObjects(defaults.applications)
	require.Equal(t, orderedFixtureObjectFingerprint(firstGenerated),
		orderedFixtureObjectFingerprint(secondGenerated),
		"fixture generation order must be repeatable")

	require.Len(t, firstInventory.applications, defaults.applications)
	require.Len(t, firstInventory.applicationSets, fixtureNamespaceCount)
	require.Len(t, firstInventory.pipelines, defaults.applications)
	require.Len(t, firstInventory.stages, defaults.applications)
	require.Len(t, firstInventory.releases, defaults.applications)
	require.Len(t, firstInventory.rollouts, defaults.applications)
	require.Len(t, uniqueApplicationNamespaces(firstInventory.applications), fixtureNamespaceCount)
	require.GreaterOrEqual(t, len(firstInventory.projects), 4)
	require.GreaterOrEqual(t, len(uniqueProjectNames(firstInventory.projects)), 4)
	require.NotEmpty(t, firstInventory.repositories)
	require.NotEmpty(t, firstInventory.clusters)

	snapshot, err := first.index.LoadSnapshot()
	require.NoError(t, err)
	require.Len(t, snapshot.Applications, defaults.applications)
	require.GreaterOrEqual(t, len(actualFixtureClusters(snapshot)), 2,
		"fixture needs multiple projected current clusters")
	require.GreaterOrEqual(t, len(actualFixtureStages(snapshot)), 2,
		"fixture needs multiple projected current stages")
	require.Contains(t, projectedFixtureHealth(snapshot), fleet.HealthHealthy)
	require.Contains(t, projectedFixtureHealth(snapshot), fleet.HealthProgressing)
	require.Contains(t, projectedFixtureHealth(snapshot), fleet.HealthDegraded)
	require.Contains(t, projectedFixtureHealth(snapshot), fleet.HealthFailed)
	require.Contains(t, projectedFixtureHealth(snapshot), fleet.HealthUnknown)
	require.True(t, fixtureHasMissingHealthCandidate(snapshot),
		"a baseline health state with missing resources must project as Missing in QueryFleetMap")

	assertFixtureReleaseAndRolloutCoverage(t, firstInventory)
	stableUIDs := make(map[types.UID]string)
	assertSharedFixtureMetadata(t, firstInventory, stableUIDs)
	assertFixtureRecordAssociations(t, firstInventory, stableUIDs)
	t.Run("application build owns the materialized pipeline", func(t *testing.T) {
		assertFixtureApplicationBuilds(t, firstInventory)
	})
	t.Run("approval gates and rollout strategies are controller reachable", func(t *testing.T) {
		assertFixturePromotionPrerequisites(t, firstInventory)
	})
	assertRealFleetQueries(t, apiserver.NewPaprikaServer(
		first.client, nil, apiserver.WithFleetIndex(first.index),
	), defaults.applications)
}

type fixtureInventory struct {
	applications    []pipelinesv1alpha1.Application
	applicationSets []pipelinesv1alpha1.ApplicationSet
	pipelines       []pipelinesv1alpha1.Pipeline
	stages          []pipelinesv1alpha1.Stage
	releases        []pipelinesv1alpha1.Release
	rollouts        []rolloutsv1alpha1.Rollout
	projects        []corev1alpha1.AppProject
	repositories    []corev1alpha1.Repository
	clusters        []clustersv1alpha1.Cluster
}

func readFixtureInventory(t *testing.T, reader client.Reader) fixtureInventory {
	t.Helper()
	ctx := context.Background()

	var applications pipelinesv1alpha1.ApplicationList
	require.NoError(t, reader.List(ctx, &applications))
	var applicationSets pipelinesv1alpha1.ApplicationSetList
	require.NoError(t, reader.List(ctx, &applicationSets))
	var pipelines pipelinesv1alpha1.PipelineList
	require.NoError(t, reader.List(ctx, &pipelines))
	var stages pipelinesv1alpha1.StageList
	require.NoError(t, reader.List(ctx, &stages))
	var releases pipelinesv1alpha1.ReleaseList
	require.NoError(t, reader.List(ctx, &releases))
	var rollouts rolloutsv1alpha1.RolloutList
	require.NoError(t, reader.List(ctx, &rollouts))
	var projects corev1alpha1.AppProjectList
	require.NoError(t, reader.List(ctx, &projects))
	var repositories corev1alpha1.RepositoryList
	require.NoError(t, reader.List(ctx, &repositories))
	var clusters clustersv1alpha1.ClusterList
	require.NoError(t, reader.List(ctx, &clusters))

	return fixtureInventory{
		applications:    applications.Items,
		applicationSets: applicationSets.Items,
		pipelines:       pipelines.Items,
		stages:          stages.Items,
		releases:        releases.Items,
		rollouts:        rollouts.Items,
		projects:        projects.Items,
		repositories:    repositories.Items,
		clusters:        clusters.Items,
	}
}

func (inventory fixtureInventory) fingerprint() []string {
	result := make([]string, 0,
		len(inventory.applications)+len(inventory.applicationSets)+len(inventory.pipelines)+len(inventory.stages)+
			len(inventory.releases)+len(inventory.rollouts)+len(inventory.projects)+
			len(inventory.repositories)+len(inventory.clusters))
	for index := range inventory.applications {
		result = append(result, objectFingerprint("Application", &inventory.applications[index]))
	}
	for index := range inventory.applicationSets {
		result = append(result, objectFingerprint("ApplicationSet", &inventory.applicationSets[index]))
	}
	for index := range inventory.pipelines {
		result = append(result, objectFingerprint("Pipeline", &inventory.pipelines[index]))
	}
	for index := range inventory.stages {
		result = append(result, objectFingerprint("Stage", &inventory.stages[index]))
	}
	for index := range inventory.releases {
		result = append(result, objectFingerprint("Release", &inventory.releases[index]))
	}
	for index := range inventory.rollouts {
		result = append(result, objectFingerprint("Rollout", &inventory.rollouts[index]))
	}
	for index := range inventory.projects {
		result = append(result, objectFingerprint("AppProject", &inventory.projects[index]))
	}
	for index := range inventory.repositories {
		result = append(result, objectFingerprint("Repository", &inventory.repositories[index]))
	}
	for index := range inventory.clusters {
		result = append(result, objectFingerprint("Cluster", &inventory.clusters[index]))
	}
	return result
}

func orderedFixtureObjectFingerprint(objects []client.Object) []string {
	result := make([]string, 0, len(objects))
	for _, object := range objects {
		result = append(result, objectFingerprint(object.GetObjectKind().GroupVersionKind().Kind, object))
	}
	return result
}

func objectFingerprint(kind string, object client.Object) string {
	return fmt.Sprintf("%s:%s/%s:%s:%d", kind, object.GetNamespace(), object.GetName(),
		object.GetUID(), object.GetCreationTimestamp().Unix())
}

func uniqueApplicationNamespaces(applications []pipelinesv1alpha1.Application) map[string]struct{} {
	result := make(map[string]struct{})
	for index := range applications {
		result[applications[index].Namespace] = struct{}{}
	}
	return result
}

func uniqueProjectNames(projects []corev1alpha1.AppProject) map[string]struct{} {
	result := make(map[string]struct{})
	for index := range projects {
		result[projects[index].Name] = struct{}{}
	}
	return result
}

func actualFixtureClusters(snapshot *fleet.Snapshot) map[types.NamespacedName]struct{} {
	result := make(map[types.NamespacedName]struct{})
	for _, application := range snapshot.Applications {
		if application.CurrentCluster != (types.NamespacedName{}) {
			result[application.CurrentCluster] = struct{}{}
		}
	}
	return result
}

func actualFixtureStages(snapshot *fleet.Snapshot) map[string]struct{} {
	result := make(map[string]struct{})
	for _, application := range snapshot.Applications {
		if application.CurrentStage != "" {
			result[application.CurrentStage] = struct{}{}
		}
	}
	return result
}

func projectedFixtureHealth(snapshot *fleet.Snapshot) map[fleet.Health]struct{} {
	result := make(map[fleet.Health]struct{})
	for _, application := range snapshot.Applications {
		result[application.Health] = struct{}{}
	}
	return result
}

func fixtureHasMissingHealthCandidate(snapshot *fleet.Snapshot) bool {
	for _, application := range snapshot.Applications {
		if application.MissingResourceCount > 0 &&
			(application.Health == fleet.HealthHealthy || application.Health == fleet.HealthUnknown) {
			return true
		}
	}
	return false
}

func assertFixtureReleaseAndRolloutCoverage(t *testing.T, inventory fixtureInventory) {
	t.Helper()
	releasePhases := make(map[pipelinesv1alpha1.ReleasePhase]struct{})
	for index := range inventory.releases {
		releasePhases[inventory.releases[index].Status.Phase] = struct{}{}
	}
	require.Contains(t, releasePhases, pipelinesv1alpha1.ReleaseComplete)
	require.Contains(t, releasePhases, pipelinesv1alpha1.ReleasePromoting)
	require.Contains(t, releasePhases, pipelinesv1alpha1.ReleaseFailed)
	require.Contains(t, releasePhases, pipelinesv1alpha1.ReleaseAwaitingApproval)

	rolloutPhases := make(map[rolloutsv1alpha1.RolloutPhase]struct{})
	for index := range inventory.rollouts {
		rolloutPhases[inventory.rollouts[index].Status.Phase] = struct{}{}
	}
	require.Contains(t, rolloutPhases, rolloutsv1alpha1.RolloutPhaseHealthy)
	require.Contains(t, rolloutPhases, rolloutsv1alpha1.RolloutPhaseProgressing)
	require.Contains(t, rolloutPhases, rolloutsv1alpha1.RolloutPhaseFailed)
	require.Contains(t, rolloutPhases, rolloutsv1alpha1.RolloutPhasePaused)
}

func assertFixtureRecordAssociations(
	t *testing.T,
	inventory fixtureInventory,
	stableUIDs map[types.UID]string,
) {
	t.Helper()

	pipelines := fixturePipelinesByKey(inventory.pipelines)
	stages := fixtureStagesByKey(inventory.stages)
	releases := fixtureReleasesByKey(inventory.releases)
	rollouts := fixtureRolloutsByKey(inventory.rollouts)
	for index := range inventory.applications {
		application := &inventory.applications[index]
		project := application.Spec.Project
		require.NotEmpty(t, project)
		require.Equal(t, project, application.Labels["app.paprika.io/project"])
		assertStableFixtureMetadata(t, "Application", application, stableUIDs)

		require.NotEmpty(t, application.Status.PipelineRef)
		pipeline := pipelines[types.NamespacedName{Namespace: application.Namespace, Name: application.Status.PipelineRef}]
		require.NotNil(t, pipeline, "missing Pipeline for %s/%s", application.Namespace, application.Name)
		require.Equal(t, application.Name, pipeline.Labels[fixtureApplicationLabel])
		require.Equal(t, project, pipeline.Labels["app.paprika.io/project"])
		require.NotEmpty(t, pipeline.Spec.Steps)
		assertControllerOwner(t, pipeline.OwnerReferences, "Application", application.Name, application.UID)
		assertStableFixtureMetadata(t, "Pipeline", pipeline, stableUIDs)

		require.Len(t, application.Status.StageRefs, 1)
		stage := stages[types.NamespacedName{Namespace: application.Namespace, Name: application.Status.StageRefs[0]}]
		require.NotNil(t, stage, "missing Stage for %s/%s", application.Namespace, application.Name)
		require.Equal(t, project, stage.Labels["app.paprika.io/project"])
		require.Equal(t, application.Status.CurrentStage, stage.Spec.Name)
		require.NotEmpty(t, stage.Spec.Templates)
		assertControllerOwner(t, stage.OwnerReferences, "Application", application.Name, application.UID)
		assertStableFixtureMetadata(t, "Stage", stage, stableUIDs)

		release := releases[types.NamespacedName{Namespace: application.Namespace, Name: application.Status.ReleaseRef}]
		require.NotNil(t, release, "missing Release for %s/%s", application.Namespace, application.Name)
		require.Equal(t, project, release.Labels["app.paprika.io/project"])
		require.Equal(t, pipeline.Name, release.Spec.Pipeline)
		require.Equal(t, stage.Name, release.Spec.Target)
		assertControllerOwner(t, release.OwnerReferences, "Application", application.Name, application.UID)
		assertStableFixtureMetadata(t, "Release", release, stableUIDs)

		rollout := rollouts[types.NamespacedName{Namespace: application.Namespace, Name: release.Status.RolloutRef}]
		require.NotNil(t, rollout, "missing Rollout for %s/%s", application.Namespace, application.Name)
		require.Equal(t, project, rollout.Labels["app.paprika.io/project"])
		if release.Status.Phase == pipelinesv1alpha1.ReleaseAwaitingApproval {
			require.NotEmpty(t, application.Status.Gates)
			require.True(t, rollout.Spec.Paused)
		}
		assertControllerOwner(t, rollout.OwnerReferences, "Release", release.Name, release.UID)
		assertStableFixtureMetadata(t, "Rollout", rollout, stableUIDs)
	}
}

func assertSharedFixtureMetadata(
	t *testing.T,
	inventory fixtureInventory,
	stableUIDs map[types.UID]string,
) {
	t.Helper()
	for index := range inventory.applicationSets {
		assertStableFixtureMetadata(t, "ApplicationSet", &inventory.applicationSets[index], stableUIDs)
	}
	for index := range inventory.projects {
		assertStableFixtureMetadata(t, "AppProject", &inventory.projects[index], stableUIDs)
	}
	for index := range inventory.repositories {
		assertStableFixtureMetadata(t, "Repository", &inventory.repositories[index], stableUIDs)
	}
	for index := range inventory.clusters {
		assertStableFixtureMetadata(t, "Cluster", &inventory.clusters[index], stableUIDs)
	}
}

func assertFixtureApplicationBuilds(t *testing.T, inventory fixtureInventory) {
	t.Helper()
	pipelines := fixturePipelinesByKey(inventory.pipelines)
	for index := range inventory.applications {
		application := &inventory.applications[index]
		pipeline := pipelines[types.NamespacedName{
			Namespace: application.Namespace,
			Name:      application.Status.PipelineRef,
		}]
		require.NotNil(t, pipeline)
		require.NotNil(t, application.Spec.Build,
			"%s/%s would have PipelineRef cleared by reconcileAppPipeline", application.Namespace, application.Name)
		build := application.Spec.Build
		require.Equal(t, build.MaxParallel, pipeline.Spec.MaxParallel)
		require.Equal(t, build.Sources, pipeline.Spec.Sources)
		require.Equal(t, build.Artifacts, pipeline.Spec.Artifacts)
		require.Len(t, pipeline.Spec.Steps, len(build.Steps))
		for stepIndex := range build.Steps {
			applicationStep := &build.Steps[stepIndex]
			pipelineStep := &pipeline.Spec.Steps[stepIndex]
			require.Equal(t, applicationStep.Name, pipelineStep.Name)
			require.Equal(t, applicationStep.Image, pipelineStep.Image)
			require.Equal(t, applicationStep.Script, pipelineStep.Script)
			require.Equal(t, applicationStep.Depends, pipelineStep.Depends)
			require.Equal(t, applicationStep.Timeout, pipelineStep.Timeout)
			require.Equal(t, applicationStep.Retry, pipelineStep.Retry)
		}
	}
}

func assertFixturePromotionPrerequisites(t *testing.T, inventory fixtureInventory) {
	t.Helper()
	stages := fixtureStagesByKey(inventory.stages)
	releases := fixtureReleasesByKey(inventory.releases)
	rollouts := fixtureRolloutsByKey(inventory.rollouts)
	for index := range inventory.applications {
		application := &inventory.applications[index]
		require.Len(t, application.Spec.Stages, 1)
		promotionStage := &application.Spec.Stages[0]
		stage := stages[types.NamespacedName{Namespace: application.Namespace, Name: application.Status.StageRefs[0]}]
		require.NotNil(t, stage)
		release := releases[types.NamespacedName{Namespace: application.Namespace, Name: application.Status.ReleaseRef}]
		require.NotNil(t, release)
		rollout := rollouts[types.NamespacedName{Namespace: release.Namespace, Name: release.Status.RolloutRef}]
		require.NotNil(t, rollout)

		require.NotNil(t, promotionStage.RolloutStrategy,
			"Application stage %s/%s lacks the rollout strategy that creates %s", application.Namespace, promotionStage.Name, rollout.Name)
		require.NotNil(t, stage.Spec.RolloutStrategy,
			"Stage %s/%s cannot drive Release %s to its Rollout", stage.Namespace, stage.Name, release.Name)
		require.Equal(t, promotionStage.RolloutStrategy, stage.Spec.RolloutStrategy)
		require.Equal(t, *stage.Spec.RolloutStrategy, rollout.Spec.Strategy)

		if release.Status.Phase != pipelinesv1alpha1.ReleaseAwaitingApproval {
			continue
		}
		require.Len(t, promotionStage.ApprovalGates, 1,
			"AwaitingApproval Application stage must declare its required gate")
		require.Equal(t, promotionStage.ApprovalGates, stage.Spec.ApprovalGates,
			"Application reconciliation must materialize the same gate on Stage")
		gate := &promotionStage.ApprovalGates[0]
		require.True(t, gate.Required)
		require.Equal(t, pipelinesv1alpha1.ApprovalGateTypeManual, gate.Type)
		require.Equal(t, promotionStage.Name, gate.Stage)
		require.Len(t, application.Status.Gates, 1)
		require.Equal(t, gate.Name, application.Status.Gates[0].Name)
		require.Equal(t, gate.Stage, application.Status.Gates[0].Stage)
		require.Equal(t, gate.Type, application.Status.Gates[0].Type)
		require.Equal(t, pipelinesv1alpha1.GateStatusPending, application.Status.Gates[0].Status)
		require.True(t, rollout.Spec.Paused)
	}
}

func assertStableFixtureMetadata(
	t *testing.T,
	kind string,
	object client.Object,
	seen map[types.UID]string,
) {
	t.Helper()
	require.NotEmpty(t, object.GetUID(), "%s %s/%s needs a stable UID", kind, object.GetNamespace(), object.GetName())
	require.False(t, object.GetCreationTimestamp().Time.IsZero(),
		"%s %s/%s needs a stable creation timestamp", kind, object.GetNamespace(), object.GetName())
	identity := kind + ":" + object.GetNamespace() + "/" + object.GetName()
	if prior, exists := seen[object.GetUID()]; exists {
		t.Fatalf("duplicate stable UID %q for %s and %s", object.GetUID(), prior, identity)
	}
	seen[object.GetUID()] = identity
}

func fixturePipelinesByKey(items []pipelinesv1alpha1.Pipeline) map[types.NamespacedName]*pipelinesv1alpha1.Pipeline {
	result := make(map[types.NamespacedName]*pipelinesv1alpha1.Pipeline, len(items))
	for index := range items {
		item := &items[index]
		result[types.NamespacedName{Namespace: item.Namespace, Name: item.Name}] = item
	}
	return result
}

func fixtureStagesByKey(items []pipelinesv1alpha1.Stage) map[types.NamespacedName]*pipelinesv1alpha1.Stage {
	result := make(map[types.NamespacedName]*pipelinesv1alpha1.Stage, len(items))
	for index := range items {
		item := &items[index]
		result[types.NamespacedName{Namespace: item.Namespace, Name: item.Name}] = item
	}
	return result
}

func fixtureReleasesByKey(items []pipelinesv1alpha1.Release) map[types.NamespacedName]*pipelinesv1alpha1.Release {
	result := make(map[types.NamespacedName]*pipelinesv1alpha1.Release, len(items))
	for index := range items {
		item := &items[index]
		result[types.NamespacedName{Namespace: item.Namespace, Name: item.Name}] = item
	}
	return result
}

func fixtureRolloutsByKey(items []rolloutsv1alpha1.Rollout) map[types.NamespacedName]*rolloutsv1alpha1.Rollout {
	result := make(map[types.NamespacedName]*rolloutsv1alpha1.Rollout, len(items))
	for index := range items {
		item := &items[index]
		result[types.NamespacedName{Namespace: item.Namespace, Name: item.Name}] = item
	}
	return result
}

type expectedFixtureSummary struct {
	project              string
	currentStage         string
	currentCluster       string
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
	require.Equal(t, want.currentStage, summary.CurrentStage)
	require.Len(t, summary.Targets, 1)
	require.Equal(t, types.NamespacedName{
		Namespace: key.Namespace,
		Name:      want.currentCluster,
	}, summary.Targets[0].Cluster)
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
	require.NoError(t, reader.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Name + "-staging"}, stage))
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

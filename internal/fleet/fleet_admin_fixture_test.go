package fleet

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

const fleetAdminFixtureNamespace = "paprika-fleet-e2e-fixture-run"

type typedFleetAdminFixtures struct {
	applications []*pipelinesv1alpha1.Application
	stages       []*pipelinesv1alpha1.Stage
	releases     []*pipelinesv1alpha1.Release
	rollouts     []*rolloutsv1alpha1.Rollout
	projects     []*corev1alpha1.AppProject
	clusters     []*clustersv1alpha1.Cluster
}

func TestFleetAdminCommittedFixturesProjectIntoProductionHealthMap(t *testing.T) {
	fixtures := loadTypedFleetAdminFixtures(t)
	materializeFleetAdminFixtureRuntimeGraph(t, &fixtures)

	projects := make(map[ProjectKey]*corev1alpha1.AppProject, len(fixtures.projects))
	clusters := make(map[ClusterKey]ClusterSummary, len(fixtures.clusters))
	editor := newSnapshotEditor(NewSnapshot(0))
	scope := QueryScope{Projects: make(ProjectSet, len(fixtures.projects))}
	for _, project := range fixtures.projects {
		key := ProjectKey{Namespace: project.Namespace, Name: project.Name}
		projects[key] = project
		scope.Projects[key] = struct{}{}
		editor.upsertProject(ProjectSummary{Identity: key})
	}
	for _, cluster := range fixtures.clusters {
		summary := projectClusterSummary(cluster)
		clusters[summary.Identity] = summary
		editor.upsertCluster(summary)
	}

	var projectionErrors uint64
	for _, application := range fixtures.applications {
		project := ProjectKey{Namespace: application.Namespace, Name: application.Spec.Project}
		summary, result := projectApplication(&projectionInput{
			application: application,
			project:     projects[project],
			stages:      stagesForFleetAdminApplication(fixtures.stages, application.Name),
			releases:    fixtures.releases,
			rollouts:    fixtures.rollouts,
			clusters:    clusters,
		})
		projectionErrors += result.ProjectionErrorCount
		editor.upsertApplication(&summary)
	}
	require.Zero(t, projectionErrors, "committed fixtures must survive the production projector")

	owned, err := editor.seal(42)
	require.NoError(t, err)
	fleetMap, err := owned.snapshot.QueryMap(
		scope,
		FleetMapQuery{Group: GroupDimensionHealth},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, uint64(6), fleetMap.Total)
	require.Equal(t, uint64(42), fleetMap.Generation)

	healthBuckets := make(map[Health]uint64, len(fleetMap.Roots))
	for _, root := range fleetMap.Roots {
		require.Len(t, root.Health, 1)
		healthBuckets[root.Health[0].Health] += root.Health[0].Count
	}
	require.Equal(t, map[Health]uint64{
		HealthHealthy:     1,
		HealthProgressing: 1,
		HealthDegraded:    2,
		HealthUnknown:     1,
		HealthMissing:     1,
	}, healthBuckets)

	expectedTargets := map[string]ClusterKey{
		"billing":       {Namespace: fleetAdminFixtureNamespace, Name: "cluster-west"},
		"catalog":       {Namespace: fleetAdminFixtureNamespace, Name: "cluster-east"},
		"checkout":      {Namespace: fleetAdminFixtureNamespace, Name: "cluster-east"},
		"ledger":        {Namespace: fleetAdminFixtureNamespace, Name: "cluster-west"},
		"notifications": {Namespace: fleetAdminFixtureNamespace, Name: "cluster-west"},
		"search":        {Namespace: fleetAdminFixtureNamespace, Name: "cluster-east"},
	}
	for application, cluster := range expectedTargets {
		summary := owned.snapshot.Applications[types.NamespacedName{
			Namespace: fleetAdminFixtureNamespace,
			Name:      application,
		}]
		require.Len(t, summary.Targets, 1)
		require.Equal(t, cluster, summary.Targets[0].Cluster)
		require.Equal(t, cluster, summary.CurrentCluster)
		require.Equal(t, ConnectionStateHealthy, summary.Targets[0].ClusterConnection)
	}

	requireDeliveryState(
		t,
		owned.snapshot,
		"catalog",
		ReleaseStateFailed,
		RolloutStateProgressing,
	)
	requireDeliveryState(
		t,
		owned.snapshot,
		"checkout",
		ReleaseStateComplete,
		RolloutStateHealthy,
	)
	requireDeliveryState(
		t,
		owned.snapshot,
		"ledger",
		ReleaseStateFailed,
		RolloutStateFailed,
	)
	requireDeliveryState(
		t,
		owned.snapshot,
		"billing",
		ReleaseStateAwaitingApproval,
		RolloutStatePaused,
	)
}

func loadTypedFleetAdminFixtures(t *testing.T) typedFleetAdminFixtures {
	t.Helper()
	fixtures := typedFleetAdminFixtures{}
	for _, name := range []string{
		"projects.yaml",
		"clusters.yaml",
		"applications.yaml",
		"stages.yaml",
		"releases.yaml",
		"rollouts.yaml",
	} {
		path := filepath.Join("..", "..", "config", "e2e", "fleet-admin", "base", name)
		// #nosec G304 -- the path is assembled exclusively from fixed test-fixture components.
		file, err := os.Open(path)
		require.NoError(t, err)
		decoder := utilyaml.NewYAMLOrJSONDecoder(file, 4096)
		for {
			object := &unstructured.Unstructured{}
			err = decoder.Decode(object)
			if errors.Is(err, io.EOF) {
				break
			}
			require.NoError(t, err)
			if len(object.Object) == 0 {
				continue
			}
			appendTypedFleetAdminFixture(t, &fixtures, object)
		}
		require.NoError(t, file.Close())
	}
	return fixtures
}

func appendTypedFleetAdminFixture(
	t *testing.T,
	fixtures *typedFleetAdminFixtures,
	object *unstructured.Unstructured,
) {
	t.Helper()
	switch object.GetKind() {
	case "Application":
		typed := &pipelinesv1alpha1.Application{}
		require.NoError(t, runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, typed))
		fixtures.applications = append(fixtures.applications, typed)
	case "Stage":
		typed := &pipelinesv1alpha1.Stage{}
		require.NoError(t, runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, typed))
		fixtures.stages = append(fixtures.stages, typed)
	case "Release":
		typed := &pipelinesv1alpha1.Release{}
		require.NoError(t, runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, typed))
		fixtures.releases = append(fixtures.releases, typed)
	case "Rollout":
		typed := &rolloutsv1alpha1.Rollout{}
		require.NoError(t, runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, typed))
		fixtures.rollouts = append(fixtures.rollouts, typed)
	case "AppProject":
		typed := &corev1alpha1.AppProject{}
		require.NoError(t, runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, typed))
		fixtures.projects = append(fixtures.projects, typed)
	case "Cluster":
		typed := &clustersv1alpha1.Cluster{}
		require.NoError(t, runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, typed))
		fixtures.clusters = append(fixtures.clusters, typed)
	default:
		t.Fatalf("unexpected fleet-admin fixture kind %q", object.GetKind())
	}
}

func materializeFleetAdminFixtureRuntimeGraph(t *testing.T, fixtures *typedFleetAdminFixtures) {
	t.Helper()
	applications := make(map[string]*pipelinesv1alpha1.Application, len(fixtures.applications))
	releases := make(map[string]*pipelinesv1alpha1.Release, len(fixtures.releases))
	for _, project := range fixtures.projects {
		project.Namespace = fleetAdminFixtureNamespace
		project.UID = types.UID("project-" + project.Name)
	}
	for _, cluster := range fixtures.clusters {
		cluster.Namespace = fleetAdminFixtureNamespace
		cluster.UID = types.UID("cluster-" + cluster.Name)
	}
	for _, application := range fixtures.applications {
		application.Namespace = fleetAdminFixtureNamespace
		application.UID = types.UID("application-" + application.Name)
		applications[application.Name] = application
	}
	for _, stage := range fixtures.stages {
		stage.Namespace = fleetAdminFixtureNamespace
		stage.UID = types.UID("stage-" + stage.Name)
		parent := applications[stage.Labels[projectionAppNameLabel]]
		require.NotNil(t, parent, "Stage %q must reference a committed Application", stage.Name)
		promotionStage := fleetAdminPromotionStage(t, parent, stage.Name)
		stage.Spec = pipelinesv1alpha1.StageSpec{
			Name:          promotionStage.Name,
			Ring:          promotionStage.Ring,
			Cluster:       promotionStage.Cluster,
			Gates:         promotionStage.Gates,
			ApprovalGates: promotionStage.ApprovalGates,
			Canary:        promotionStage.Canary,
		}
		stage.OwnerReferences = []metav1.OwnerReference{
			fleetAdminControllerOwner(parent.APIVersion, "Application", parent.Name, parent.UID),
		}
	}
	for _, release := range fixtures.releases {
		release.Namespace = fleetAdminFixtureNamespace
		release.UID = types.UID("release-" + release.Name)
		parent := applications[release.Labels[projectionAppNameLabel]]
		require.NotNil(t, parent, "Release %q must reference a committed Application", release.Name)
		release.OwnerReferences = []metav1.OwnerReference{
			fleetAdminControllerOwner(parent.APIVersion, "Application", parent.Name, parent.UID),
		}
		releases[release.Name] = release
	}
	for _, rollout := range fixtures.rollouts {
		rollout.Namespace = fleetAdminFixtureNamespace
		rollout.UID = types.UID("rollout-" + rollout.Name)
		parent := releases[rollout.Labels["app.paprika.io/release"]]
		require.NotNil(t, parent, "Rollout %q must reference a committed Release", rollout.Name)
		rollout.OwnerReferences = []metav1.OwnerReference{
			fleetAdminControllerOwner(parent.APIVersion, "Release", parent.Name, parent.UID),
		}
	}
}

func fleetAdminPromotionStage(
	t *testing.T,
	application *pipelinesv1alpha1.Application,
	stageName string,
) *pipelinesv1alpha1.ApplicationPromotionStage {
	t.Helper()
	for index := range application.Spec.Stages {
		promotionStage := &application.Spec.Stages[index]
		if application.Name+"-"+promotionStage.Name == stageName {
			return promotionStage
		}
	}
	t.Fatalf(
		"Stage %q must be declared by Application %q",
		stageName,
		application.Name,
	)
	return nil
}

func fleetAdminControllerOwner(
	apiVersion, kind, name string,
	uid types.UID,
) metav1.OwnerReference {
	controller := true
	blockOwnerDeletion := true
	return metav1.OwnerReference{
		APIVersion:         apiVersion,
		Kind:               kind,
		Name:               name,
		UID:                uid,
		Controller:         &controller,
		BlockOwnerDeletion: &blockOwnerDeletion,
	}
}

func stagesForFleetAdminApplication(
	stages []*pipelinesv1alpha1.Stage,
	application string,
) []*pipelinesv1alpha1.Stage {
	result := make([]*pipelinesv1alpha1.Stage, 0, 1)
	for _, stage := range stages {
		if stage.Labels[projectionAppNameLabel] == application {
			result = append(result, stage)
		}
	}
	return result
}

func requireDeliveryState(
	t *testing.T,
	snapshot *Snapshot,
	application string,
	release ReleaseState,
	rollout RolloutState,
) {
	t.Helper()
	summary := snapshot.Applications[types.NamespacedName{
		Namespace: fleetAdminFixtureNamespace,
		Name:      application,
	}]
	require.Equal(t, release, summary.ReleaseState)
	require.Equal(t, rollout, summary.RolloutState)
}

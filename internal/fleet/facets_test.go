package fleet

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFacetsExcludeOnlyTheirOwnDimensionAfterAuthorizationAndSearch(t *testing.T) {
	t.Parallel()

	projectA := fleetID("team-a", "shared")
	projectB := fleetID("team-b", "shared")
	privateProject := fleetID("private", "hidden")
	prodCluster := fleetID("clusters", "prod")
	canaryCluster := fleetID("clusters", "canary")
	baseline := facetApplication("apps-a", "alpha-baseline", projectA, prodCluster, "prod")
	// Repeated targets must not make one Application count twice in a bucket.
	baseline.Targets = append(baseline.Targets, baseline.Targets[0])

	projectAlternative := facetApplication("apps-a", "alpha-project", projectB, prodCluster, "prod")
	namespaceAlternative := facetApplication("apps-b", "alpha-namespace", projectA, prodCluster, "prod")
	clusterAlternative := facetApplication("apps-a", "alpha-cluster", projectA, canaryCluster, "prod")
	stageAlternative := facetApplication("apps-a", "alpha-stage", projectA, prodCluster, "qa")
	healthAlternative := facetApplication("apps-a", "alpha-health", projectA, prodCluster, "prod")
	healthAlternative.Health = HealthHealthy
	syncAlternative := facetApplication("apps-a", "alpha-sync", projectA, prodCluster, "prod")
	syncAlternative.Sync = SyncStateSynced
	releaseAlternative := facetApplication("apps-a", "alpha-release", projectA, prodCluster, "prod")
	releaseAlternative.ReleaseState = ReleaseStateComplete
	rolloutAlternative := facetApplication("apps-a", "alpha-rollout", projectA, prodCluster, "prod")
	rolloutAlternative.RolloutState = RolloutStateHealthy
	sourceAlternative := facetApplication("apps-a", "alpha-source", projectA, prodCluster, "prod")
	sourceAlternative.SourceType = SourceTypeHelm
	private := facetApplication("apps-a", "alpha-private", privateProject, prodCluster, "prod")

	snapshot := newQuerySnapshot(t,
		baseline,
		projectAlternative,
		namespaceAlternative,
		clusterAlternative,
		stageAlternative,
		healthAlternative,
		syncAlternative,
		releaseAlternative,
		rolloutAlternative,
		sourceAlternative,
		private,
	)
	snapshot.Clusters[prodCluster] = ClusterSummary{Identity: prodCluster, DisplayName: "Production"}
	snapshot.Clusters[canaryCluster] = ClusterSummary{Identity: canaryCluster, DisplayName: "Canary East"}

	filter := ApplicationFilter{
		Projects:      []ProjectKey{projectA},
		Namespaces:    []string{"apps-a"},
		Clusters:      []ClusterKey{prodCluster},
		Stages:        []string{"prod"},
		Health:        []Health{HealthDegraded},
		Sync:          []SyncState{SyncStateOutOfSync},
		ReleaseStates: []ReleaseState{ReleaseStateVerifying},
		RolloutStates: []RolloutState{RolloutStateProgressing},
		SourceTypes:   []SourceType{SourceTypeGit},
	}
	scope := QueryScope{Projects: ProjectSet{projectA: {}, projectB: {}}}

	buckets, err := snapshot.Facets(scope, filter, "alpha")
	require.NoError(t, err)
	require.Equal(t, []FacetBucket{
		{Dimension: FacetDimensionProject, Object: projectA, Label: "shared", Count: 1},
		{Dimension: FacetDimensionProject, Object: projectB, Label: "shared", Count: 1},
		{Dimension: FacetDimensionNamespace, Value: "apps-a", Label: "apps-a", Count: 1},
		{Dimension: FacetDimensionNamespace, Value: "apps-b", Label: "apps-b", Count: 1},
		{Dimension: FacetDimensionCluster, Object: canaryCluster, Label: "Canary East", Count: 1},
		{Dimension: FacetDimensionCluster, Object: prodCluster, Label: "Production", Count: 1},
		{Dimension: FacetDimensionStage, Value: "prod", Label: "prod", Count: 1},
		{Dimension: FacetDimensionStage, Value: "qa", Label: "qa", Count: 1},
		{Dimension: FacetDimensionHealth, Value: "degraded", Label: "degraded", Count: 1},
		{Dimension: FacetDimensionHealth, Value: "healthy", Label: "healthy", Count: 1},
		{Dimension: FacetDimensionSync, Value: "out_of_sync", Label: "out_of_sync", Count: 1},
		{Dimension: FacetDimensionSync, Value: "synced", Label: "synced", Count: 1},
		{Dimension: FacetDimensionRelease, Value: "complete", Label: "complete", Count: 1},
		{Dimension: FacetDimensionRelease, Value: "verifying", Label: "verifying", Count: 1},
		{Dimension: FacetDimensionRollout, Value: "healthy", Label: "healthy", Count: 1},
		{Dimension: FacetDimensionRollout, Value: "progressing", Label: "progressing", Count: 1},
		{Dimension: FacetDimensionSourceType, Value: "git", Label: "git", Count: 1},
		{Dimension: FacetDimensionSourceType, Value: "helm", Label: "helm", Count: 1},
	}, buckets)

	for _, bucket := range buckets {
		require.NotEqual(t, privateProject, bucket.Object)
		require.Equal(t, uint64(1), bucket.Count, "unauthorized records must not affect counts")
	}
}

func TestFacetsFailClosedAndOmitUnspecifiedScalarValues(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "project")
	app := ApplicationSummary{Identity: fleetID("apps", "alpha"), Project: project}
	snapshot := newQuerySnapshot(t, app)

	buckets, err := snapshot.Facets(QueryScope{}, ApplicationFilter{}, "")
	require.NoError(t, err)
	require.Empty(t, buckets)

	buckets, err = snapshot.Facets(
		QueryScope{Projects: ProjectSet{project: {}}},
		ApplicationFilter{},
		"",
	)
	require.NoError(t, err)
	require.Equal(t, []FacetBucket{
		{Dimension: FacetDimensionProject, Object: project, Label: "project", Count: 1},
		{Dimension: FacetDimensionNamespace, Value: "apps", Label: "apps", Count: 1},
	}, buckets)
}

func facetApplication(
	namespace string,
	name string,
	project ProjectKey,
	cluster ClusterKey,
	stage string,
) ApplicationSummary {
	return ApplicationSummary{
		Identity:      fleetID(namespace, name),
		Project:       project,
		Targets:       []StageTargetSummary{{Stage: stage, Cluster: cluster}},
		Health:        HealthDegraded,
		Sync:          SyncStateOutOfSync,
		ReleaseState:  ReleaseStateVerifying,
		RolloutState:  RolloutStateProgressing,
		SourceType:    SourceTypeGit,
		ResourceCount: 1,
	}
}

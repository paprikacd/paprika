package fleet

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFleetMapDefaultsAuthorizeAndAggregateDeterministically(t *testing.T) {
	t.Parallel()

	projectA := fleetID("team-a", "payments")
	projectB := fleetID("team-b", "payments")
	unauthorizedProject := fleetID("private", "payments")
	api := ApplicationSummary{
		Identity:       fleetID("apps", "api"),
		Project:        projectA,
		Targets:        []StageTargetSummary{{StableID: "api-prod", Stage: "prod", Cluster: fleetID("clusters", "west")}},
		CurrentStage:   "prod",
		CurrentCluster: fleetID("clusters", "west"),
		Health:         HealthHealthy,
		ResourceCount:  7,
	}
	worker := ApplicationSummary{
		Identity:       fleetID("apps", "worker"),
		Project:        projectA,
		Targets:        []StageTargetSummary{{StableID: "worker-prod", Stage: "prod", Cluster: fleetID("clusters", "east")}},
		CurrentStage:   "prod",
		CurrentCluster: fleetID("clusters", "east"),
		Health:         HealthDegraded,
		ResourceCount:  3,
	}
	other := ApplicationSummary{
		Identity:      fleetID("apps", "other"),
		Project:       projectB,
		Health:        HealthProgressing,
		ResourceCount: 5,
	}
	secret := ApplicationSummary{
		Identity:      fleetID("private", "secret"),
		Project:       unauthorizedProject,
		Health:        HealthFailed,
		ResourceCount: 100,
	}
	snapshot := newQuerySnapshot(t, worker, secret, other, api)
	snapshot.Generation = 42

	result, err := snapshot.QueryMap(QueryScope{Projects: ProjectSet{projectA: {}, projectB: {}}}, FleetMapQuery{}, nil)
	require.NoError(t, err)
	require.Equal(t, uint64(3), result.Total)
	require.Equal(t, uint64(42), result.Generation)
	require.Len(t, result.Roots, 2)

	require.Equal(t, "g:project:team-a/payments", result.Roots[0].StableID)
	require.Equal(t, projectA, result.Roots[0].GroupObject)
	require.Equal(t, uint64(2), result.Roots[0].ApplicationCount)
	require.Equal(t, uint64(2), result.Roots[0].TargetCount)
	require.Equal(t, uint64(10), result.Roots[0].ResourceWeight)
	require.Equal(t, float64(10), result.Roots[0].EffectiveWeight)
	require.Equal(t, []HealthBucket{{Health: HealthHealthy, Count: 1}, {Health: HealthDegraded, Count: 1}}, result.Roots[0].Health)
	require.Equal(t, []string{"a:apps/api", "a:apps/worker"}, mapNodeIDs(result.Roots[0].Children))
	require.Equal(t, uint64(1), result.Roots[0].Children[0].TargetCount)
	require.Equal(t, uint64(7), result.Roots[0].Children[0].ResourceWeight)

	require.Equal(t, "g:project:team-b/payments", result.Roots[1].StableID)
	require.Equal(t, uint64(1), result.Roots[1].ApplicationCount)
	require.NotContains(t, mapNodeIDs(result.Roots), "g:project:private/payments")
}

func TestFleetMapCarriesAuthorizedSelfExcludingFacetsForItsSearch(t *testing.T) {
	t.Parallel()

	snapshot, scope, filter, privateProject := aggregationFacetFixture(t)
	want, err := snapshot.Facets(scope, filter, "alpha")
	require.NoError(t, err)

	result, err := snapshot.QueryMap(scope, FleetMapQuery{
		Filter: filter,
		Search: "alpha",
	}, nil)
	require.NoError(t, err)
	require.Equal(t, want, result.Facets)
	require.Contains(t, result.Facets, FacetBucket{
		Dimension: FacetDimensionHealth,
		Value:     "healthy",
		Label:     "healthy",
		Count:     1,
	})
	for _, bucket := range result.Facets {
		require.NotEqual(t, privateProject, bucket.Object)
	}
}

func aggregationFacetFixture(
	t *testing.T,
) (*Snapshot, QueryScope, ApplicationFilter, ProjectKey) {
	t.Helper()

	project := fleetID("team", "payments")
	privateProject := fleetID("private", "payments")
	cluster := fleetID("clusters", "prod")
	baseline := facetApplication("apps", "alpha-api", project, cluster, "prod")
	alternative := facetApplication("apps", "alpha-worker", project, cluster, "prod")
	alternative.Health = HealthHealthy
	searchMiss := facetApplication("apps", "beta-api", project, cluster, "prod")
	unauthorized := facetApplication("private", "alpha-secret", privateProject, cluster, "prod")
	snapshot := newQuerySnapshot(t, baseline, alternative, searchMiss, unauthorized)
	filter := ApplicationFilter{Health: []Health{HealthDegraded}}
	scope := QueryScope{Projects: ProjectSet{project: {}}}
	return snapshot, scope, filter, privateProject
}

func TestFleetMapStageAndClusterUseOneCurrentActualTargetPerApplication(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	namedCluster := fleetID("clusters", "in-cluster")
	app := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: project,
		Targets: []StageTargetSummary{
			{StableID: "dev", Stage: "dev", ClusterLabel: "in-cluster", Health: HealthHealthy},
			{StableID: "prod", Stage: "prod", Cluster: namedCluster, ClusterLabel: "Named", Health: HealthDegraded},
			// A duplicate target record must not inflate target counts.
			{StableID: "prod", Stage: "prod", Cluster: namedCluster, ClusterLabel: "Named", Health: HealthDegraded},
		},
		CurrentStage: "prod", CurrentCluster: namedCluster,
		Health: HealthDegraded, ResourceCount: 9,
	}
	snapshot := newQuerySnapshot(t, app)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	byStage, err := snapshot.QueryMap(scope, FleetMapQuery{Group: GroupDimensionStage}, nil)
	require.NoError(t, err)
	require.Equal(t, []string{"g:stage:value:prod"}, mapNodeIDs(byStage.Roots))
	require.Equal(t, uint64(1), byStage.Roots[0].TargetCount)
	require.Equal(t, "a:apps/checkout", byStage.Roots[0].Children[0].StableID)

	byCluster, err := snapshot.QueryMap(scope, FleetMapQuery{Group: GroupDimensionCluster}, nil)
	require.NoError(t, err)
	require.Equal(t, []string{"g:cluster:clusters/in-cluster"}, mapNodeIDs(byCluster.Roots))
	require.Equal(t, namedCluster, byCluster.Roots[0].GroupObject)

	inlineCurrent := app
	inlineCurrent.Identity = fleetID("apps", "inline")
	inlineCurrent.CurrentStage = "dev"
	inlineCurrent.CurrentCluster = ClusterKey{}
	unmanagedCurrent := inlineCurrent
	unmanagedCurrent.Identity = fleetID("apps", "unmanaged")
	unmanagedCurrent.Targets = append([]StageTargetSummary(nil), inlineCurrent.Targets...)
	unmanagedCurrent.Targets[0].UnmanagedInlineCluster = true
	snapshot = newQuerySnapshot(t, app, inlineCurrent, unmanagedCurrent)
	byCluster, err = snapshot.QueryMap(scope, FleetMapQuery{Group: GroupDimensionCluster}, nil)
	require.NoError(t, err)
	require.Equal(t,
		[]string{
			"g:cluster:clusters/in-cluster",
			"g:cluster:in-cluster",
			"g:cluster:unmanaged-inline",
		},
		mapNodeIDs(byCluster.Roots),
	)
	require.Equal(t, "in-cluster", byCluster.Roots[1].GroupValue)
	require.Empty(t, byCluster.Roots[1].GroupObject)
	require.Equal(t, "unmanaged-inline", byCluster.Roots[2].GroupValue)
}

func TestFleetMapClusterAggregationIgnoresDivergentTargetLabels(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	cluster := fleetID("clusters", "west")
	first := ApplicationSummary{
		Identity: fleetID("apps", "first"), Project: project,
		Targets: []StageTargetSummary{{
			StableID: "first-prod", Stage: "prod", Cluster: cluster, ClusterLabel: "Stale west label",
		}},
		CurrentStage: "prod", CurrentCluster: cluster, Health: HealthHealthy, ResourceCount: 2,
	}
	second := ApplicationSummary{
		Identity: fleetID("apps", "second"), Project: project,
		Targets: []StageTargetSummary{{
			StableID: "second-prod", Stage: "prod", Cluster: cluster, ClusterLabel: "Other stale label",
		}},
		CurrentStage: "prod", CurrentCluster: cluster, Health: HealthDegraded, ResourceCount: 3,
	}
	snapshot := newQuerySnapshot(t, first, second)
	snapshot.Clusters[cluster] = ClusterSummary{Identity: cluster, DisplayName: "US West"}

	result, err := snapshot.QueryMap(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{Group: GroupDimensionCluster},
		nil,
	)
	require.NoError(t, err)
	require.Len(t, result.Roots, 1)
	require.Equal(t, "g:cluster:clusters/west", result.Roots[0].StableID)
	require.Equal(t, "US West", result.Roots[0].Label)
	require.Equal(t, uint64(2), result.Roots[0].ApplicationCount)
	require.Equal(t, uint64(2), result.Roots[0].TargetCount)
	require.Equal(t, []string{"a:apps/first", "a:apps/second"}, mapNodeIDs(result.Roots[0].Children))
}

func TestFleetMapInlineClusterLabelsFollowManagementSemantics(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	managed := ApplicationSummary{
		Identity: fleetID("apps", "managed"), Project: project,
		Targets: []StageTargetSummary{{
			StableID: "managed", Stage: "prod", ClusterLabel: "Projected wrong label",
		}},
		CurrentStage: "prod", Health: HealthHealthy,
	}
	unmanaged := ApplicationSummary{
		Identity: fleetID("apps", "unmanaged"), Project: project,
		Targets: []StageTargetSummary{{
			StableID: "unmanaged", Stage: "prod", ClusterLabel: "In-cluster", UnmanagedInlineCluster: true,
		}},
		CurrentStage: "prod", Health: HealthHealthy,
	}
	snapshot := newQuerySnapshot(t, managed, unmanaged)

	result, err := snapshot.QueryMap(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{Group: GroupDimensionCluster},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, []string{"g:cluster:in-cluster", "g:cluster:unmanaged-inline"}, mapNodeIDs(result.Roots))
	require.Equal(t, "In-cluster", result.Roots[0].Label)
	require.Equal(t, "Unmanaged inline", result.Roots[1].Label)
}

func TestFleetMapMissingStageCannotAliasRealUnspecifiedStage(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	missing := ApplicationSummary{
		Identity: fleetID("apps", "missing"), Project: project, Health: HealthUnknown,
		Targets: []StageTargetSummary{{StableID: "dev", Stage: "dev"}},
	}
	literalStage := ApplicationSummary{
		Identity: fleetID("apps", "real"), Project: project, Health: HealthHealthy,
		Targets:      []StageTargetSummary{{StableID: "literal", Stage: "unspecified"}},
		CurrentStage: "unspecified",
	}
	snapshot := newQuerySnapshot(t, missing, literalStage)

	result, err := snapshot.QueryMap(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{Group: GroupDimensionStage},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t,
		[]string{"g:stage:sentinel:unspecified", "g:stage:value:unspecified"},
		mapNodeIDs(result.Roots),
	)
	require.Equal(t, []string{"Unspecified", "unspecified"}, []string{result.Roots[0].Label, result.Roots[1].Label})
}

func TestFleetMapRequestRateFallsBackAtomicallyPerLeaf(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	app := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: project,
		Targets: []StageTargetSummary{
			{StableID: "dev-west", Stage: "dev", Cluster: fleetID("clusters", "west")},
			{StableID: "dev-east", Stage: "dev", Cluster: fleetID("clusters", "east")},
			{StableID: "prod", Stage: "prod", Cluster: fleetID("clusters", "west")},
		},
		CurrentStage: "prod", CurrentCluster: fleetID("clusters", "west"),
		Health: HealthHealthy, ResourceCount: 12,
	}
	snapshot := newQuerySnapshot(t, app)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	missing, err := snapshot.QueryMap(scope, FleetMapQuery{SizeMetric: SizeMetricRequestRate}, nil)
	require.NoError(t, err)
	leaf := missing.Roots[0].Children[0]
	require.True(t, leaf.UsedResourceFallback)
	require.Equal(t, float64(12), leaf.EffectiveWeight)
	require.Zero(t, leaf.RequestRateWeight)
	require.True(t, missing.Roots[0].UsedResourceFallback)

	weights := fakeWeightReader{
		weightKey(app, app.Targets[0]): 2.5,
		weightKey(app, app.Targets[1]): 3.5,
		weightKey(app, app.Targets[2]): 11,
	}
	current, err := snapshot.QueryMap(scope, FleetMapQuery{SizeMetric: SizeMetricRequestRate}, weights)
	require.NoError(t, err)
	leaf = current.Roots[0].Children[0]
	require.False(t, leaf.UsedResourceFallback)
	require.Equal(t, float64(11), leaf.RequestRateWeight)
	require.Equal(t, float64(11), leaf.EffectiveWeight)
	require.Equal(t, uint64(1), leaf.TargetCount)

	filtered, err := snapshot.QueryMap(scope, FleetMapQuery{
		Filter:     ApplicationFilter{Stages: []string{"dev"}},
		SizeMetric: SizeMetricRequestRate,
	}, weights)
	require.NoError(t, err)
	leaf = filtered.Roots[0].Children[0]
	require.Equal(t, float64(6), leaf.RequestRateWeight)
	require.Equal(t, float64(6), leaf.EffectiveWeight)
	require.Equal(t, uint64(2), leaf.TargetCount)

	delete(weights, weightKey(app, app.Targets[1]))
	filtered, err = snapshot.QueryMap(scope, FleetMapQuery{
		Filter:     ApplicationFilter{Stages: []string{"dev"}},
		SizeMetric: SizeMetricRequestRate,
	}, weights)
	require.NoError(t, err)
	leaf = filtered.Roots[0].Children[0]
	require.True(t, leaf.UsedResourceFallback)
	require.Equal(t, float64(12), leaf.EffectiveWeight)
	require.Equal(t, float64(2.5), leaf.RequestRateWeight)

	weights[weightKey(app, app.Targets[0])] = math.NaN()
	filtered, err = snapshot.QueryMap(scope, FleetMapQuery{
		Filter:     ApplicationFilter{Stages: []string{"dev"}},
		SizeMetric: SizeMetricRequestRate,
	}, weights)
	require.NoError(t, err)
	require.True(t, filtered.Roots[0].Children[0].UsedResourceFallback)
}

func TestFleetMapRequestRateLeafOverflowFallsBackWithFiniteWeights(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	app := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: project,
		Targets: []StageTargetSummary{
			{StableID: "dev-east", Stage: "dev", Cluster: fleetID("clusters", "east")},
			{StableID: "dev-west", Stage: "dev", Cluster: fleetID("clusters", "west")},
		},
		CurrentStage: "dev", CurrentCluster: fleetID("clusters", "east"),
		Health: HealthHealthy, ResourceCount: 8,
	}
	snapshot := newQuerySnapshot(t, app)
	weights := fakeWeightReader{
		weightKey(app, app.Targets[0]): math.MaxFloat64,
		weightKey(app, app.Targets[1]): 1,
	}

	result, err := snapshot.QueryMap(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{
			Filter: ApplicationFilter{Stages: []string{"dev"}}, SizeMetric: SizeMetricRequestRate,
		},
		weights,
	)
	require.NoError(t, err)
	leaf := result.Roots[0].Children[0]
	require.True(t, leaf.UsedResourceFallback)
	require.Equal(t, float64(8), leaf.EffectiveWeight)
	requireFiniteWeight(t, leaf.RequestRateWeight)
	requireFiniteWeight(t, leaf.EffectiveWeight)
}

func TestFleetMapRequestRateGroupOverflowFallsBackAtomically(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	first := ApplicationSummary{
		Identity: fleetID("apps", "first"), Project: project,
		Targets:      []StageTargetSummary{{StableID: "first", Stage: "prod"}},
		CurrentStage: "prod", Health: HealthHealthy, ResourceCount: 3,
	}
	second := ApplicationSummary{
		Identity: fleetID("apps", "second"), Project: project,
		Targets:      []StageTargetSummary{{StableID: "second", Stage: "prod"}},
		CurrentStage: "prod", Health: HealthHealthy, ResourceCount: 4,
	}
	snapshot := newQuerySnapshot(t, first, second)
	weights := fakeWeightReader{
		weightKey(first, first.Targets[0]):   math.MaxFloat64,
		weightKey(second, second.Targets[0]): math.MaxFloat64,
	}

	result, err := snapshot.QueryMap(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{SizeMetric: SizeMetricRequestRate},
		weights,
	)
	require.NoError(t, err)
	require.False(t, result.Roots[0].Children[0].UsedResourceFallback)
	require.False(t, result.Roots[0].Children[1].UsedResourceFallback)
	require.True(t, result.Roots[0].UsedResourceFallback)
	require.Zero(t, result.Roots[0].RequestRateWeight)
	require.Equal(t, float64(7), result.Roots[0].EffectiveWeight)
	requireFiniteWeight(t, result.Roots[0].RequestRateWeight)
	requireFiniteWeight(t, result.Roots[0].EffectiveWeight)
}

func TestFleetMapTargetFilterSelectorUsesMembershipSets(t *testing.T) {
	t.Parallel()

	filter := ApplicationFilter{
		Stages:   make([]string, 0, 1_000),
		Clusters: make([]ClusterKey, 0, 1_000),
	}
	for index := range 1_000 {
		filter.Stages = append(filter.Stages, fmt.Sprintf("stage-%04d", index))
		filter.Clusters = append(filter.Clusters, fleetID("clusters", fmt.Sprintf("cluster-%04d", index)))
	}
	filter = filter.Normalized()
	selector := newTargetFilterSelector(&filter)
	require.Len(t, selector.stages, 1_000)
	require.Len(t, selector.clusters, 1_000)
	target := StageTargetSummary{Stage: "stage-0999", Cluster: fleetID("clusters", "cluster-0999")}
	require.True(t, selector.matches(&target))
	target.Cluster = fleetID("clusters", "absent")
	require.False(t, selector.matches(&target))

	project := fleetID("projects", "payments")
	app := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: project,
		Targets: []StageTargetSummary{{
			StableID: "last", Stage: "stage-0999", Cluster: fleetID("clusters", "cluster-0999"),
		}},
		CurrentStage: "stage-0999", CurrentCluster: fleetID("clusters", "cluster-0999"),
		Health: HealthHealthy, ResourceCount: 1,
	}
	result, err := newQuerySnapshot(t, app).QueryMap(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{Filter: filter},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, uint64(1), result.Total)
	require.Equal(t, uint64(1), result.Roots[0].TargetCount)
}

func TestFleetMapDoesNotInventCurrentTarget(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	app := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: project,
		Targets:      []StageTargetSummary{{StableID: "dev", Stage: "dev", Cluster: fleetID("clusters", "east")}},
		CurrentStage: "prod", CurrentCluster: fleetID("clusters", "west"),
		Health: HealthHealthy, ResourceCount: 4,
	}
	snapshot := newQuerySnapshot(t, app)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	byStage, err := snapshot.QueryMap(scope, FleetMapQuery{Group: GroupDimensionStage}, nil)
	require.NoError(t, err)
	require.Equal(t, []string{"g:stage:sentinel:unspecified"}, mapNodeIDs(byStage.Roots))
	require.Zero(t, byStage.Roots[0].TargetCount)

	weighted, err := snapshot.QueryMap(scope, FleetMapQuery{SizeMetric: SizeMetricRequestRate}, fakeWeightReader{
		weightKey(app, app.Targets[0]): 99,
	})
	require.NoError(t, err)
	require.True(t, weighted.Roots[0].Children[0].UsedResourceFallback)
	require.Zero(t, weighted.Roots[0].Children[0].RequestRateWeight)
	require.Equal(t, float64(4), weighted.Roots[0].Children[0].EffectiveWeight)
}

func TestFleetMapReaderUsesInstalledSnapshotWithoutReadinessGate(t *testing.T) {
	t.Parallel()

	index := NewIndex()
	_, err := index.ProjectKeys(context.Background(), nil)
	require.ErrorAs(t, err, new(*ErrUnavailable))

	indexedProject := fleetID("team-b", "indexed")
	declaredProject := fleetID("team-a", "declared")
	application := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: indexedProject,
		Health: HealthHealthy, ResourceCount: 2,
	}
	builder := NewSnapshot(9)
	addApplicationMutable(builder, &application)
	builder.Projects[declaredProject] = ProjectSummary{Identity: declaredProject}
	require.NoError(t, index.Install(builder))
	require.NoError(t, index.SetHealth(HealthState{Ready: true, Degraded: true, Reason: "resync failed"}))

	projects, err := index.ProjectKeys(context.Background(), nil)
	require.NoError(t, err)
	require.Equal(t, []ProjectKey{declaredProject, indexedProject}, projects)
	projects, err = index.ProjectKeys(context.Background(), []string{"team-b", "team-b"})
	require.NoError(t, err)
	require.Equal(t, []ProjectKey{indexedProject}, projects)

	result, err := index.QueryMap(
		context.Background(),
		QueryScope{Projects: ProjectSet{indexedProject: {}}},
		FleetMapQuery{},
	)
	require.NoError(t, err, "degraded readiness must not discard a serving snapshot")
	require.Equal(t, uint64(9), result.Generation)
	require.Equal(t, uint64(1), result.Total)
}

type fakeWeightReader map[TargetWeightKey]float64

func (f fakeWeightReader) RequestRate(key TargetWeightKey) (float64, bool) {
	value, ok := f[key]
	return value, ok
}

func weightKey(app ApplicationSummary, target StageTargetSummary) TargetWeightKey {
	return TargetWeightKey{
		Project: app.Project, Application: app.Identity,
		Stage: target.Stage, Cluster: target.Cluster,
	}
}

func mapNodeIDs(nodes []FleetMapNode) []string {
	ids := make([]string, 0, len(nodes))
	for i := range nodes {
		ids = append(ids, nodes[i].StableID)
	}
	return ids
}

func requireFiniteWeight(t *testing.T, value float64) {
	t.Helper()
	require.False(t, math.IsNaN(value))
	require.False(t, math.IsInf(value, 0))
}

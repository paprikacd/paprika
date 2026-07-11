package fleet

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFleetMatrixProjectByHealthContributesOncePerApplication(t *testing.T) {
	t.Parallel()

	projectA := fleetID("team-a", "shared")
	projectB := fleetID("team-b", "shared")
	degraded := ApplicationSummary{
		Identity:      fleetID("apps", "degraded"),
		Project:       projectA,
		Health:        HealthDegraded,
		ResourceCount: 5,
		Targets: []StageTargetSummary{
			{StableID: "degraded-dev", Stage: "dev", Cluster: fleetID("clusters", "east")},
			{StableID: "degraded-prod", Stage: "prod", Cluster: fleetID("clusters", "west")},
		},
	}
	healthyA := ApplicationSummary{
		Identity:      fleetID("apps", "healthy-a"),
		Project:       projectA,
		Health:        HealthHealthy,
		ResourceCount: 3,
		Targets: []StageTargetSummary{
			{StableID: "healthy-a", Stage: "prod", Cluster: fleetID("clusters", "west")},
		},
	}
	healthyB := ApplicationSummary{
		Identity:      fleetID("apps", "healthy-b"),
		Project:       projectB,
		Health:        HealthHealthy,
		ResourceCount: 2,
	}
	snapshot := newQuerySnapshot(t, healthyB, healthyA, degraded)
	scope := QueryScope{Projects: ProjectSet{projectA: {}, projectB: {}}}

	result, err := snapshot.QueryMatrix(scope, FleetMatrixQuery{
		RowGroup:    GroupDimensionProject,
		ColumnGroup: GroupDimensionHealth,
	}, nil)
	require.NoError(t, err)
	require.Equal(t, uint64(3), result.Total)
	require.Equal(t, snapshot.Generation, result.Generation)
	require.Equal(t, []FleetMatrixHeader{
		{StableID: "g:project:team-a/shared", Label: "shared", Object: projectA},
		{StableID: "g:project:team-b/shared", Label: "shared", Object: projectB},
	}, result.Rows)
	require.Equal(t, []FleetMatrixHeader{
		{StableID: "g:health:healthy", Label: "healthy", Value: "healthy"},
		{StableID: "g:health:degraded", Label: "degraded", Value: "degraded"},
	}, result.Columns)
	require.Equal(t, []FleetMatrixCell{
		{
			RowID: "g:project:team-a/shared", ColumnID: "g:health:healthy",
			ApplicationCount: 1, TargetCount: 1,
			Health: []HealthBucket{{Health: HealthHealthy, Count: 1}}, ResourceWeight: 3,
		},
		{
			RowID: "g:project:team-a/shared", ColumnID: "g:health:degraded",
			ApplicationCount: 1, TargetCount: 2,
			Health: []HealthBucket{{Health: HealthDegraded, Count: 1}}, ResourceWeight: 5,
		},
		{
			RowID: "g:project:team-b/shared", ColumnID: "g:health:healthy",
			ApplicationCount: 1, TargetCount: 0,
			Health: []HealthBucket{{Health: HealthHealthy, Count: 1}}, ResourceWeight: 2,
		},
	}, result.Cells)
}

func TestFleetMatrixStageByClusterUsesOnlyActualTargets(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "payments")
	east := fleetID("clusters", "east")
	west := fleetID("clusters", "west")
	app := ApplicationSummary{
		Identity:      fleetID("apps", "checkout"),
		Project:       project,
		Health:        HealthFailed,
		ResourceCount: 7,
		Targets: []StageTargetSummary{
			{StableID: "prod-west", Stage: "prod", Cluster: west, Health: HealthDegraded},
			{StableID: "dev-east", Stage: "dev", Cluster: east, Health: HealthHealthy},
		},
	}
	snapshot := newQuerySnapshot(t, app)
	snapshot.Clusters[east] = ClusterSummary{Identity: east, DisplayName: "East"}
	snapshot.Clusters[west] = ClusterSummary{Identity: west, DisplayName: "West"}

	result, err := snapshot.QueryMatrix(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMatrixQuery{RowGroup: GroupDimensionStage, ColumnGroup: GroupDimensionCluster},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, []FleetMatrixHeader{
		{StableID: "g:stage:value:dev", Label: "dev", Value: "dev"},
		{StableID: "g:stage:value:prod", Label: "prod", Value: "prod"},
	}, result.Rows)
	require.Equal(t, []FleetMatrixHeader{
		{StableID: "g:cluster:clusters/east", Label: "East", Object: east},
		{StableID: "g:cluster:clusters/west", Label: "West", Object: west},
	}, result.Columns)
	require.Equal(t, []FleetMatrixCell{
		{
			RowID: "g:stage:value:dev", ColumnID: "g:cluster:clusters/east",
			ApplicationCount: 1, TargetCount: 1,
			Health: []HealthBucket{{Health: HealthHealthy, Count: 1}}, ResourceWeight: 7,
		},
		{
			RowID: "g:stage:value:prod", ColumnID: "g:cluster:clusters/west",
			ApplicationCount: 1, TargetCount: 1,
			Health: []HealthBucket{{Health: HealthDegraded, Count: 1}}, ResourceWeight: 7,
		},
	}, result.Cells, "two targets must never expand into a four-cell Cartesian product")
}

func TestFleetMatrixTargetModeUsesStageHealthAndUniqueApplications(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "payments")
	east := fleetID("clusters", "east")
	app := ApplicationSummary{
		Identity:      fleetID("apps", "checkout"),
		Project:       project,
		Health:        HealthHealthy,
		ResourceCount: 4,
		Targets: []StageTargetSummary{
			{StableID: "prod-east-1", Stage: "prod", Cluster: east, Health: HealthFailed},
			{StableID: "prod-east-2", Stage: "prod", Cluster: east, Health: HealthFailed},
		},
	}
	snapshot := newQuerySnapshot(t, app)

	result, err := snapshot.QueryMatrix(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMatrixQuery{RowGroup: GroupDimensionCluster, ColumnGroup: GroupDimensionHealth},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, []FleetMatrixCell{{
		RowID: "g:cluster:clusters/east", ColumnID: "g:health:failed",
		ApplicationCount: 1, TargetCount: 2,
		Health: []HealthBucket{{Health: HealthFailed, Count: 2}}, ResourceWeight: 8,
	}}, result.Cells)
}

func TestFleetMatrixTargetFiltersApplyToTheSameActualTarget(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "payments")
	east := fleetID("clusters", "east")
	west := fleetID("clusters", "west")
	crossMatchOnly := ApplicationSummary{
		Identity: fleetID("apps", "cross-match"), Project: project, Health: HealthHealthy, ResourceCount: 2,
		Targets: []StageTargetSummary{
			{StableID: "dev-east", Stage: "dev", Cluster: east, Health: HealthHealthy},
			{StableID: "prod-west", Stage: "prod", Cluster: west, Health: HealthHealthy},
		},
	}
	exactMatch := ApplicationSummary{
		Identity: fleetID("apps", "exact-match"), Project: project, Health: HealthHealthy, ResourceCount: 3,
		Targets: []StageTargetSummary{
			{StableID: "dev-west", Stage: "dev", Cluster: west, Health: HealthDegraded},
			{StableID: "prod-east", Stage: "prod", Cluster: east, Health: HealthHealthy},
		},
	}
	snapshot := newQuerySnapshot(t, crossMatchOnly, exactMatch)

	result, err := snapshot.QueryMatrix(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMatrixQuery{
			Filter:   ApplicationFilter{Stages: []string{"dev"}, Clusters: []ClusterKey{west}},
			RowGroup: GroupDimensionStage, ColumnGroup: GroupDimensionCluster,
		},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, uint64(2), result.Total, "total retains the application-level filter semantics")
	require.Equal(t, []FleetMatrixCell{{
		RowID: "g:stage:value:dev", ColumnID: "g:cluster:clusters/west",
		ApplicationCount: 1, TargetCount: 1,
		Health: []HealthBucket{{Health: HealthDegraded, Count: 1}}, ResourceWeight: 3,
	}}, result.Cells)
}

func TestFleetMatrixInlineClusterHasDistinctDeterministicHeader(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "payments")
	named := fleetID("clusters", "in-cluster")
	app := ApplicationSummary{
		Identity: fleetID("apps", "checkout"), Project: project, Health: HealthHealthy, ResourceCount: 1,
		Targets: []StageTargetSummary{
			{StableID: "named", Stage: "dev", Cluster: named, ClusterLabel: "Named", Health: HealthHealthy},
			{StableID: "inline", Stage: "prod", ClusterLabel: "In-cluster", Health: HealthUnknown},
			{
				StableID: "unmanaged", Stage: "qa", ClusterLabel: "In-cluster",
				Health: HealthUnknown, UnmanagedInlineCluster: true,
			},
		},
	}
	snapshot := newQuerySnapshot(t, app)
	snapshot.Clusters[named] = ClusterSummary{Identity: named, DisplayName: "Named"}

	result, err := snapshot.QueryMatrix(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMatrixQuery{RowGroup: GroupDimensionCluster, ColumnGroup: GroupDimensionStage},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, []FleetMatrixHeader{
		{StableID: "g:cluster:clusters/in-cluster", Label: "Named", Object: named},
		{StableID: "g:cluster:in-cluster", Label: "In-cluster", Value: "in-cluster"},
		{StableID: "g:cluster:unmanaged-inline", Label: "Unmanaged inline", Value: "unmanaged-inline"},
	}, result.Rows)
	require.NotEqual(t, result.Rows[0].StableID, result.Rows[1].StableID)
}

func TestFleetMatrixRequestRateUsesExactTargetsAndAtomicCellFallback(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "payments")
	east := fleetID("clusters", "east")
	west := fleetID("clusters", "west")
	first := ApplicationSummary{
		Identity: fleetID("apps", "first"), Project: project, Health: HealthHealthy, ResourceCount: 3,
		Targets: []StageTargetSummary{{StableID: "first-dev", Stage: "dev", Cluster: east, Health: HealthHealthy}},
	}
	second := ApplicationSummary{
		Identity: fleetID("apps", "second"), Project: project, Health: HealthHealthy, ResourceCount: 4,
		Targets: []StageTargetSummary{{StableID: "second-dev", Stage: "dev", Cluster: east, Health: HealthHealthy}},
	}
	third := ApplicationSummary{
		Identity: fleetID("apps", "third"), Project: project, Health: HealthHealthy, ResourceCount: 5,
		Targets: []StageTargetSummary{{StableID: "third-prod", Stage: "prod", Cluster: west, Health: HealthHealthy}},
	}
	snapshot := newQuerySnapshot(t, first, second, third)
	query := FleetMatrixQuery{
		RowGroup: GroupDimensionStage, ColumnGroup: GroupDimensionCluster,
		SizeMetric: SizeMetricRequestRate,
	}
	scope := QueryScope{Projects: ProjectSet{project: {}}}
	partial := matrixWeightReader{
		matrixTargetKey(first, first.Targets[0]): 11.5,
		matrixTargetKey(third, third.Targets[0]): 7.25,
	}

	result, err := snapshot.QueryMatrix(scope, query, partial)
	require.NoError(t, err)
	require.Equal(t, []FleetMatrixCell{
		{
			RowID: "g:stage:value:dev", ColumnID: "g:cluster:clusters/east",
			ApplicationCount: 2, TargetCount: 2,
			Health: []HealthBucket{{Health: HealthHealthy, Count: 2}}, ResourceWeight: 7,
			UsedResourceFallback: true,
		},
		{
			RowID: "g:stage:value:prod", ColumnID: "g:cluster:clusters/west",
			ApplicationCount: 1, TargetCount: 1,
			Health: []HealthBucket{{Health: HealthHealthy, Count: 1}}, ResourceWeight: 5,
			RequestRateWeight: 7.25,
		},
	}, result.Cells, "a partially weighted cell must fall back atomically instead of mixing units")

	complete := matrixWeightReader{
		matrixTargetKey(first, first.Targets[0]):   11.5,
		matrixTargetKey(second, second.Targets[0]): 3.5,
		matrixTargetKey(third, third.Targets[0]):   7.25,
	}
	result, err = snapshot.QueryMatrix(scope, query, complete)
	require.NoError(t, err)
	require.Equal(t, 15.0, result.Cells[0].RequestRateWeight)
	require.False(t, result.Cells[0].UsedResourceFallback)

	result, err = snapshot.QueryMatrix(scope, query, nil)
	require.NoError(t, err)
	require.Zero(t, result.Cells[0].RequestRateWeight)
	require.True(t, result.Cells[0].UsedResourceFallback)
}

func TestFleetMatrixRequestRateFallsBackWhenCellSumOverflows(t *testing.T) {
	t.Parallel()

	project := fleetID("team", "payments")
	cluster := fleetID("clusters", "east")
	first := ApplicationSummary{
		Identity: fleetID("apps", "first"), Project: project, Health: HealthHealthy, ResourceCount: 3,
		Targets: []StageTargetSummary{{StableID: "first", Stage: "dev", Cluster: cluster, Health: HealthHealthy}},
	}
	second := ApplicationSummary{
		Identity: fleetID("apps", "second"), Project: project, Health: HealthHealthy, ResourceCount: 4,
		Targets: []StageTargetSummary{{StableID: "second", Stage: "dev", Cluster: cluster, Health: HealthHealthy}},
	}
	snapshot := newQuerySnapshot(t, first, second)
	weights := matrixWeightReader{
		matrixTargetKey(first, first.Targets[0]):   math.MaxFloat64,
		matrixTargetKey(second, second.Targets[0]): math.MaxFloat64,
	}

	result, err := snapshot.QueryMatrix(
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMatrixQuery{
			RowGroup: GroupDimensionStage, ColumnGroup: GroupDimensionCluster,
			SizeMetric: SizeMetricRequestRate,
		},
		weights,
	)
	require.NoError(t, err)
	require.Len(t, result.Cells, 1)
	require.True(t, result.Cells[0].UsedResourceFallback)
	require.Zero(t, result.Cells[0].RequestRateWeight)
	require.False(t, math.IsInf(result.Cells[0].RequestRateWeight, 0))
	require.False(t, math.IsNaN(result.Cells[0].RequestRateWeight))
	require.Equal(t, uint64(7), result.Cells[0].ResourceWeight)
}

func TestFleetMatrixRejectsEqualAxesWithTypedError(t *testing.T) {
	t.Parallel()

	snapshot := newQuerySnapshot(t)
	_, err := snapshot.QueryMatrix(QueryScope{}, FleetMatrixQuery{
		RowGroup: GroupDimensionStage, ColumnGroup: GroupDimensionStage,
	}, nil)
	require.Error(t, err)
	var axesError *ErrInvalidMatrixAxes
	require.ErrorAs(t, err, &axesError)
}

type matrixWeightReader map[TargetWeightKey]float64

func (r matrixWeightReader) RequestRate(key TargetWeightKey) (float64, bool) {
	weight, ok := r[key]
	return weight, ok
}

func matrixTargetKey(app ApplicationSummary, target StageTargetSummary) TargetWeightKey {
	return TargetWeightKey{
		Project: app.Project, Application: app.Identity, Stage: target.Stage, Cluster: target.Cluster,
	}
}

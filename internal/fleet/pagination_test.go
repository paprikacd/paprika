package fleet

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"
)

func TestPageQueryApplicationsPagesNamesDeterministically(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	snapshot := paginationSnapshot(17,
		paginationApplication("tenant", "zulu", project),
		paginationApplication("tenant", "alpha", project),
		paginationApplication("tenant", "beta", project),
	)
	scope := QueryScope{
		Projects: ProjectSet{project: {}},
		CapabilitiesByProject: map[ProjectKey]CapabilitySet{
			project: {
				CapabilityPipelineRetry:   {},
				CapabilityApplicationSync: {},
			},
		},
	}
	query := ApplicationQuery{
		Sort:      SortFieldName,
		Direction: SortDirectionAsc,
		PageSize:  2,
	}

	first, err := snapshot.QueryApplications(scope, query, "")
	require.NoError(t, err)
	require.Equal(t, uint64(3), first.Total)
	require.Equal(t, uint64(17), first.Generation)
	require.Equal(t, []types.NamespacedName{
		{Namespace: "tenant", Name: "alpha"},
		{Namespace: "tenant", Name: "beta"},
	}, paginationPageIDs(first))
	require.Equal(t,
		[]Capability{CapabilityApplicationSync, CapabilityPipelineRetry},
		first.Applications[0].Capabilities,
	)
	require.NotEmpty(t, first.NextCursor)

	second, err := snapshot.QueryApplications(scope, query, first.NextCursor)
	require.NoError(t, err)
	require.Equal(t, []types.NamespacedName{{Namespace: "tenant", Name: "zulu"}}, paginationPageIDs(second))
	require.Empty(t, second.NextCursor)
}

func TestPageQueryApplicationsCursorResumesAcrossIndependentIndexes(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	scope := QueryScope{Projects: ProjectSet{project: {}}}
	query := ApplicationQuery{Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 2}
	applications := []ApplicationSummary{
		paginationApplication("tenant", "alpha", project),
		paginationApplication("tenant", "beta", project),
		paginationApplication("tenant", "delta", project),
		paginationApplication("tenant", "echo", project),
	}
	firstIndex := NewIndex()
	require.NoError(t, firstIndex.Install(paginationSnapshot(7, applications...)))
	secondIndex := NewIndex()
	require.NoError(t, secondIndex.Install(paginationSnapshot(99, applications...)))
	firstReplica, err := firstIndex.LoadSnapshot()
	require.NoError(t, err)
	secondReplica, err := secondIndex.LoadSnapshot()
	require.NoError(t, err)

	first, err := firstReplica.QueryApplications(scope, query, "")
	require.NoError(t, err)
	require.Equal(t, []types.NamespacedName{
		{Namespace: "tenant", Name: "alpha"},
		{Namespace: "tenant", Name: "beta"},
	}, paginationPageIDs(first))
	require.NotEmpty(t, first.NextCursor)

	second, err := secondReplica.QueryApplications(scope, query, first.NextCursor)
	require.NoError(t, err)
	require.Equal(t, uint64(4), second.Total)
	require.Equal(t, uint64(99), second.Generation)
	require.Equal(t, []types.NamespacedName{
		{Namespace: "tenant", Name: "delta"},
		{Namespace: "tenant", Name: "echo"},
	}, paginationPageIDs(second))
	require.Empty(t, second.NextCursor)
}

func TestPageQueryApplicationsSeeksAfterMissingLiveBoundary(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	scope := QueryScope{Projects: ProjectSet{project: {}}}
	query := ApplicationQuery{Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 2}
	firstSnapshot := paginationSnapshot(7,
		paginationApplication("tenant", "alpha", project),
		paginationApplication("tenant", "beta", project),
		paginationApplication("tenant", "delta", project),
	)
	first, err := firstSnapshot.QueryApplications(scope, query, "")
	require.NoError(t, err)

	// The current live snapshot no longer contains the boundary object and has a
	// newly inserted tuple after it. Tuple seeking must not require identity lookup.
	secondSnapshot := paginationSnapshot(99,
		paginationApplication("tenant", "alpha", project),
		paginationApplication("tenant", "charlie", project),
		paginationApplication("tenant", "delta", project),
		paginationApplication("tenant", "echo", project),
	)
	second, err := secondSnapshot.QueryApplications(scope, query, first.NextCursor)
	require.NoError(t, err)
	require.Equal(t, uint64(4), second.Total)
	require.Equal(t, uint64(99), second.Generation)
	require.Equal(t, []types.NamespacedName{
		{Namespace: "tenant", Name: "charlie"},
		{Namespace: "tenant", Name: "delta"},
	}, paginationPageIDs(second))
	require.NotEmpty(t, second.NextCursor)
}

func TestPageQueryApplicationsReevaluatesAuthorizationBeforeCursorSeek(t *testing.T) {
	t.Parallel()

	projectA := ProjectKey{Namespace: "tenant-a", Name: "payments"}
	projectB := ProjectKey{Namespace: "tenant-b", Name: "payments"}
	snapshot := paginationSnapshot(1,
		paginationApplication("tenant-a", "alpha", projectA),
		paginationApplication("tenant-b", "charlie", projectB),
		paginationApplication("tenant-a", "delta", projectA),
		paginationApplication("tenant-b", "echo", projectB),
	)
	query := ApplicationQuery{Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 2}
	initialScope := QueryScope{Projects: ProjectSet{projectA: {}, projectB: {}}}

	first, err := snapshot.QueryApplications(initialScope, query, "")
	require.NoError(t, err)
	require.Equal(t, []types.NamespacedName{
		{Namespace: "tenant-a", Name: "alpha"},
		{Namespace: "tenant-b", Name: "charlie"},
	}, paginationPageIDs(first))

	revokedScope := QueryScope{Projects: ProjectSet{projectB: {}}}
	second, err := snapshot.QueryApplications(revokedScope, query, first.NextCursor)
	require.NoError(t, err)
	require.Equal(t, uint64(2), second.Total)
	require.Equal(t,
		[]types.NamespacedName{{Namespace: "tenant-b", Name: "echo"}},
		paginationPageIDs(second),
	)
	require.Empty(t, second.NextCursor)
	for _, application := range second.Applications {
		require.Equal(t, projectB, application.Summary.Project)
	}
}

func TestPageQueryApplicationsSearchRelevanceIsAlwaysBestFirst(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	apps := []ApplicationSummary{
		paginationApplication("tenant", "alphi", project),
		paginationApplication("tenant", "service-alpha", project),
		paginationApplication("tenant", "alpha-low", project),
		paginationApplication("tenant", "alpha", project),
		paginationApplication("tenant", "alpha-high", project),
	}
	apps[0].ResourceCount = 500
	apps[1].ResourceCount = 400
	apps[2].ResourceCount = 1
	apps[3].ResourceCount = 0
	apps[4].ResourceCount = 2
	snapshot := paginationSnapshot(1, apps...)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	page, err := snapshot.QueryApplications(scope, ApplicationQuery{
		Search:    "alpha",
		Sort:      SortFieldResourceCount,
		Direction: SortDirectionDesc,
		PageSize:  10,
	}, "")
	require.NoError(t, err)
	require.Equal(t, []types.NamespacedName{
		{Namespace: "tenant", Name: "alpha"},
		{Namespace: "tenant", Name: "alpha-high"},
		{Namespace: "tenant", Name: "alpha-low"},
		{Namespace: "tenant", Name: "service-alpha"},
		{Namespace: "tenant", Name: "alphi"},
	}, paginationPageIDs(page))
}

func TestPageQueryApplicationsSortsEveryFieldInBothDirections(t *testing.T) {
	t.Parallel()

	visibleProjects := ProjectSet{
		{Namespace: "z", Name: "z"}: {},
		{Namespace: "a", Name: "a"}: {},
		{Namespace: "m", Name: "m"}: {},
	}
	a := paginationApplication("apps", "a", ProjectKey{Namespace: "z", Name: "z"})
	b := paginationApplication("apps", "b", ProjectKey{Namespace: "a", Name: "a"})
	c := paginationApplication("apps", "c", ProjectKey{Namespace: "m", Name: "m"})
	a.Targets = []StageTargetSummary{
		{Stage: "z", Cluster: ClusterKey{Namespace: "z", Name: "z"}},
		{Stage: "b", Cluster: ClusterKey{Namespace: "b", Name: "b"}},
	}
	b.Targets = []StageTargetSummary{{Stage: "c", Cluster: ClusterKey{Namespace: "a", Name: "a"}}}
	c.Targets = []StageTargetSummary{{Stage: "a", Cluster: ClusterKey{Namespace: "c", Name: "c"}}}
	a.Health, b.Health, c.Health = HealthMissing, HealthHealthy, HealthDegraded
	a.Sync, b.Sync, c.Sync = SyncStateOutOfSync, SyncStateUnknown, SyncStateSynced
	a.ReleaseState, b.ReleaseState, c.ReleaseState = ReleaseStateComplete, ReleaseStatePending, ReleaseStateFailed
	a.RolloutState, b.RolloutState, c.RolloutState = RolloutStateFailed, RolloutStateHealthy, RolloutStatePending
	a.ResourceCount, b.ResourceCount, c.ResourceCount = 5, 9, 1
	a.LastTransitionUnixMS, b.LastTransitionUnixMS, c.LastTransitionUnixMS = 20, 10, 30
	snapshot := paginationSnapshot(1, a, b, c)
	scope := QueryScope{Projects: visibleProjects}

	tests := []struct {
		name string
		sort SortField
		asc  []string
		desc []string
	}{
		{name: "name", sort: SortFieldName, asc: []string{"a", "b", "c"}, desc: []string{"c", "b", "a"}},
		{name: "project", sort: SortFieldProject, asc: []string{"b", "c", "a"}, desc: []string{"a", "c", "b"}},
		{name: "minimum cluster target", sort: SortFieldCluster, asc: []string{"b", "a", "c"}, desc: []string{"c", "a", "b"}},
		{name: "minimum stage target", sort: SortFieldStage, asc: []string{"c", "a", "b"}, desc: []string{"b", "a", "c"}},
		{name: "health", sort: SortFieldHealth, asc: []string{"b", "c", "a"}, desc: []string{"a", "c", "b"}},
		{name: "sync", sort: SortFieldSync, asc: []string{"c", "a", "b"}, desc: []string{"b", "a", "c"}},
		{name: "release", sort: SortFieldRelease, asc: []string{"b", "a", "c"}, desc: []string{"c", "a", "b"}},
		{name: "rollout", sort: SortFieldRollout, asc: []string{"c", "b", "a"}, desc: []string{"a", "b", "c"}},
		{name: "resource count", sort: SortFieldResourceCount, asc: []string{"c", "a", "b"}, desc: []string{"b", "a", "c"}},
		{name: "last transition", sort: SortFieldLastTransition, asc: []string{"b", "a", "c"}, desc: []string{"c", "a", "b"}},
		{name: "neutral relevance", sort: SortFieldRelevance, asc: []string{"a", "b", "c"}, desc: []string{"a", "b", "c"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			for _, direction := range []struct {
				value SortDirection
				want  []string
			}{
				{value: SortDirectionAsc, want: test.asc},
				{value: SortDirectionDesc, want: test.desc},
			} {
				page, err := snapshot.QueryApplications(scope, ApplicationQuery{
					Sort:      test.sort,
					Direction: direction.value,
					PageSize:  10,
				}, "")
				require.NoError(t, err)
				require.Equal(t, direction.want, paginationPageNames(page))
			}
		})
	}
}

func TestPageQueryApplicationsImpactIsLexicographic(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	failed := paginationApplication("tenant", "failed", project)
	missing := paginationApplication("tenant", "missing", project)
	gates := paginationApplication("tenant", "gates", project)
	active := paginationApplication("tenant", "active", project)
	resources := paginationApplication("tenant", "resources", project)
	transition := paginationApplication("tenant", "transition", project)
	older := paginationApplication("tenant", "older", project)
	failed.Health = HealthFailed
	missing.Health, missing.BlockedGateCount = HealthMissing, 100
	for _, application := range []*ApplicationSummary{&gates, &active, &resources, &transition, &older} {
		application.Health = HealthDegraded
		application.BlockedGateCount = 1
	}
	gates.BlockedGateCount = 2
	active.ReleaseState = ReleaseStatePromoting
	active.ResourceCount = 1
	resources.ResourceCount = 1000
	transition.ResourceCount, transition.LastTransitionUnixMS = 2, 30
	older.ResourceCount, older.LastTransitionUnixMS = 2, 20
	snapshot := paginationSnapshot(1, failed, missing, gates, active, resources, transition, older)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	page, err := snapshot.QueryApplications(scope, ApplicationQuery{
		Sort:      SortFieldImpact,
		Direction: SortDirectionDesc,
		PageSize:  10,
	}, "")
	require.NoError(t, err)
	require.Equal(t, []string{
		"failed", "missing", "gates", "active", "resources", "transition", "older",
	}, paginationPageNames(page))
}

func TestPageQueryApplicationsIdentityTieBreakerIsAlwaysAscending(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	first := paginationApplication("z", "same", project)
	second := paginationApplication("a", "same", project)
	first.ResourceCount, second.ResourceCount = 7, 7
	snapshot := paginationSnapshot(1, first, second)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	for _, direction := range []SortDirection{SortDirectionAsc, SortDirectionDesc} {
		page, err := snapshot.QueryApplications(scope, ApplicationQuery{
			Sort:      SortFieldResourceCount,
			Direction: direction,
			PageSize:  10,
		}, "")
		require.NoError(t, err)
		require.Equal(t, []types.NamespacedName{
			{Namespace: "a", Name: "same"},
			{Namespace: "z", Name: "same"},
		}, paginationPageIDs(page))
	}
}

func TestPageQueryApplicationsRejectsInvalidCursor(t *testing.T) {
	t.Parallel()

	project := ProjectKey{Namespace: "tenant", Name: "payments"}
	snapshot := paginationSnapshot(1, paginationApplication("tenant", "alpha", project))
	_, err := snapshot.QueryApplications(
		QueryScope{Projects: ProjectSet{project: {}}},
		ApplicationQuery{Sort: SortFieldName, Direction: SortDirectionAsc, PageSize: 10},
		"not-a-cursor",
	)
	var invalid *ErrInvalidCursor
	require.True(t, errors.As(err, &invalid))
}

func TestPageActiveReleaseClassificationIsExhaustive(t *testing.T) {
	t.Parallel()

	tests := []struct {
		state ReleaseState
		want  bool
	}{
		{state: ReleaseStateUnspecified, want: false},
		{state: ReleaseStatePending, want: true},
		{state: ReleaseStatePromoting, want: true},
		{state: ReleaseStateCanarying, want: true},
		{state: ReleaseStateVerifying, want: true},
		{state: ReleaseStateComplete, want: false},
		{state: ReleaseStateFailed, want: false},
		{state: ReleaseStateRolledBack, want: false},
		{state: ReleaseStateSuperseded, want: false},
		{state: ReleaseStateAwaitingApproval, want: true},
	}
	for _, test := range tests {
		require.Equal(t, test.want, activeRelease(test.state), "release state %d", test.state)
	}
}

func TestPageActiveRolloutClassificationIsExhaustive(t *testing.T) {
	t.Parallel()

	tests := []struct {
		state RolloutState
		want  bool
	}{
		{state: RolloutStateUnspecified, want: false},
		{state: RolloutStatePending, want: true},
		{state: RolloutStateProgressing, want: true},
		{state: RolloutStatePaused, want: true},
		{state: RolloutStateHealthy, want: false},
		{state: RolloutStateDegraded, want: false},
		{state: RolloutStateFailed, want: false},
		{state: RolloutStateRolledBack, want: false},
		{state: RolloutStateAborted, want: false},
	}
	for _, test := range tests {
		require.Equal(t, test.want, activeRollout(test.state), "rollout state %d", test.state)
	}
}

func TestPageUnhealthySeverityOrdersEveryHealthState(t *testing.T) {
	t.Parallel()

	leastToMostImpactful := []Health{
		HealthHealthy,
		HealthUnspecified,
		HealthUnknown,
		HealthProgressing,
		HealthDegraded,
		HealthMissing,
		HealthFailed,
	}
	for expected, health := range leastToMostImpactful {
		require.Equal(t, uint8(expected), unhealthySeverity(health), "health state %d", health) // #nosec G115 -- seven fixed enum values.
	}
}

func paginationSnapshot(generation uint64, applications ...ApplicationSummary) *Snapshot {
	snapshot := NewSnapshot(generation)
	for i := range applications {
		application := applications[i]
		addApplicationMutable(snapshot, &application)
	}
	snapshot.rebuildSearchIndex()
	return snapshot
}

func paginationApplication(namespace, name string, project ProjectKey) ApplicationSummary {
	return ApplicationSummary{
		Identity: types.NamespacedName{Namespace: namespace, Name: name},
		Project:  project,
		Health:   HealthHealthy,
		Sync:     SyncStateSynced,
	}
}

func paginationPageIDs(page ApplicationPage) []types.NamespacedName {
	ids := make([]types.NamespacedName, len(page.Applications))
	for i := range page.Applications {
		ids[i] = page.Applications[i].Summary.Identity
	}
	return ids
}

func paginationPageNames(page ApplicationPage) []string {
	names := make([]string, len(page.Applications))
	for i := range page.Applications {
		names[i] = page.Applications[i].Summary.Identity.Name
	}
	return names
}

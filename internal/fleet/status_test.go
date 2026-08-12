package fleet

import (
	"math/rand"
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"
)

func TestQueryStatusPopulatesEveryHealthAndSyncBucket(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "all-states")
	applications := make([]ApplicationSummary, 0, 11)
	for index, health := range []Health{
		HealthUnspecified,
		HealthHealthy,
		HealthProgressing,
		HealthDegraded,
		HealthFailed,
		HealthUnknown,
		HealthMissing,
	} {
		application := statusApplication("health", statusName(index), project)
		application.Health = health
		applications = append(applications, application)
	}
	for index, syncState := range []SyncState{
		SyncStateUnspecified,
		SyncStateSynced,
		SyncStateOutOfSync,
		SyncStateUnknown,
	} {
		application := statusApplication("sync", statusName(index), project)
		application.Sync = syncState
		applications = append(applications, application)
	}

	status, err := newQuerySnapshot(t, applications...).QueryStatus(
		QueryScope{Projects: ProjectSet{project: {}}},
		StatusQuery{},
	)
	require.NoError(t, err)
	require.Equal(t, uint64(1), status.Generation)
	require.Equal(t, uint64(11), status.Total)
	require.Equal(t, map[Health]uint64{
		HealthUnspecified: 1,
		HealthHealthy:     5,
		HealthProgressing: 1,
		HealthDegraded:    1,
		HealthFailed:      1,
		HealthUnknown:     1,
		HealthMissing:     1,
	}, status.Health)
	require.Equal(t, map[SyncState]uint64{
		SyncStateUnspecified: 1,
		SyncStateSynced:      8,
		SyncStateOutOfSync:   1,
		SyncStateUnknown:     1,
	}, status.Sync)
}

func TestQueryStatusIncludesEveryAttentionReason(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "attention")
	applications := make([]ApplicationSummary, 0, 20)
	add := func(name string, mutate func(*ApplicationSummary)) {
		application := statusApplication("apps", name, project)
		mutate(&application)
		applications = append(applications, application)
	}
	for _, state := range []struct {
		name   string
		health Health
	}{
		{"health-progressing", HealthProgressing},
		{"health-degraded", HealthDegraded},
		{"health-failed", HealthFailed},
		{"health-unknown", HealthUnknown},
		{"health-missing", HealthMissing},
	} {
		state := state
		add(state.name, func(application *ApplicationSummary) { application.Health = state.health })
	}
	for _, state := range []struct {
		name string
		sync SyncState
	}{
		{"sync-out-of-sync", SyncStateOutOfSync},
		{"sync-unknown", SyncStateUnknown},
	} {
		state := state
		add(state.name, func(application *ApplicationSummary) { application.Sync = state.sync })
	}
	add("blocked-gate", func(application *ApplicationSummary) { application.BlockedGateCount = 1 })
	for _, state := range []struct {
		name  string
		state ReleaseState
	}{
		{"release-failed", ReleaseStateFailed},
		{"release-rolled-back", ReleaseStateRolledBack},
		{"release-awaiting-approval", ReleaseStateAwaitingApproval},
	} {
		state := state
		add(state.name, func(application *ApplicationSummary) { application.ReleaseState = state.state })
	}
	for _, state := range []struct {
		name  string
		state RolloutState
	}{
		{"rollout-paused", RolloutStatePaused},
		{"rollout-degraded", RolloutStateDegraded},
		{"rollout-failed", RolloutStateFailed},
		{"rollout-rolled-back", RolloutStateRolledBack},
		{"rollout-aborted", RolloutStateAborted},
	} {
		state := state
		add(state.name, func(application *ApplicationSummary) { application.RolloutState = state.state })
	}
	add("repository-connection", func(application *ApplicationSummary) {
		application.Repository = fleetID("connections", "repository")
		application.RepositoryConnection = ConnectionStateUnhealthy
	})
	add("observability-connection", func(application *ApplicationSummary) {
		application.EffectiveObservabilitySource = fleetID("connections", "observability")
		application.ObservabilityConnection = ConnectionStateUnhealthy
	})
	add("cluster-connection", func(application *ApplicationSummary) {
		application.Targets = []StageTargetSummary{{
			Cluster: fleetID("connections", "cluster"), ClusterConnection: ConnectionStateUnhealthy,
		}}
	})
	applications = append(applications,
		statusApplication("apps", "healthy", project),
		statusApplicationWithChange("apps", "active-change", project),
	)

	status, err := newQuerySnapshot(t, applications...).QueryStatus(
		QueryScope{Projects: ProjectSet{project: {}}},
		StatusQuery{AttentionLimit: 100},
	)
	require.NoError(t, err)
	require.EqualValues(t, len(applications)-2, status.AttentionTotal)
	require.ElementsMatch(t, statusApplicationNames(applications[:len(applications)-2]), statusResultNames(status.Attention))
	require.False(t, status.HasMoreAttention)
}

func TestQueryStatusAttentionLimitUsesServerSemantics(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "limits")
	applications := make([]ApplicationSummary, 101)
	for index := range applications {
		applications[index] = statusApplication("apps", statusName(index), project)
		applications[index].Health = HealthFailed
	}
	snapshot := newQuerySnapshot(t, applications...)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	for _, test := range []struct {
		name  string
		limit uint32
		want  int
	}{
		{name: "zero defaults to twenty", limit: 0, want: 20},
		{name: "one", limit: 1, want: 1},
		{name: "maximum", limit: 100, want: 100},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			status, err := snapshot.QueryStatus(scope, StatusQuery{AttentionLimit: test.limit})
			require.NoError(t, err)
			require.Len(t, status.Attention, test.want)
			require.Equal(t, uint64(101), status.AttentionTotal)
			require.Equal(t, status.AttentionTotal > uint64(len(status.Attention)), status.HasMoreAttention)
		})
	}
}

func TestQueryStatusAuthorizesAndFiltersBeforeAggregating(t *testing.T) {
	t.Parallel()

	firstProject := fleetID("projects", "first")
	secondProject := fleetID("projects", "second")
	first := statusApplication("apps-a", "first", firstProject)
	first.Health, first.Sync = HealthFailed, SyncStateOutOfSync
	second := statusApplication("apps-b", "second", firstProject)
	second.Health = HealthDegraded
	unauthorized := statusApplication("apps-b", "secret", secondProject)
	unauthorized.Health, unauthorized.Sync = HealthMissing, SyncStateUnknown
	snapshot := newQuerySnapshot(t, first, second, unauthorized)

	empty, err := snapshot.QueryStatus(QueryScope{}, StatusQuery{})
	require.NoError(t, err)
	require.Equal(t, uint64(1), empty.Generation)
	require.Zero(t, empty.Total)
	require.Equal(t, zeroHealthStatusBuckets(), empty.Health)
	require.Equal(t, zeroSyncStatusBuckets(), empty.Sync)
	require.Empty(t, empty.Attention)
	require.Zero(t, empty.AttentionTotal)
	require.False(t, empty.HasMoreAttention)

	filtered, err := snapshot.QueryStatus(
		QueryScope{Projects: ProjectSet{firstProject: {}}},
		StatusQuery{Filter: ApplicationFilter{Namespaces: []string{"apps-b"}}},
	)
	require.NoError(t, err)
	require.Equal(t, uint64(1), filtered.Total)
	require.Equal(t, map[Health]uint64{
		HealthUnspecified: 0,
		HealthHealthy:     0,
		HealthProgressing: 0,
		HealthDegraded:    1,
		HealthFailed:      0,
		HealthUnknown:     0,
		HealthMissing:     0,
	}, filtered.Health)
	require.Equal(t, map[SyncState]uint64{
		SyncStateUnspecified: 0,
		SyncStateSynced:      1,
		SyncStateOutOfSync:   0,
		SyncStateUnknown:     0,
	}, filtered.Sync)
	require.Equal(t, []string{"second"}, statusResultNames(filtered.Attention))
}

func TestQueryStatusAttentionOrderingIsLexicographic(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "ordering")
	tests := []struct {
		name         string
		applications []ApplicationSummary
		want         []string
	}{
		{
			name: "health severity across all values",
			applications: statusApplicationsByHealth(project, []struct {
				name   string
				health Health
			}{
				{"healthy", HealthHealthy},
				{"unspecified", HealthUnspecified},
				{"unknown", HealthUnknown},
				{"progressing", HealthProgressing},
				{"degraded", HealthDegraded},
				{"missing", HealthMissing},
				{"failed", HealthFailed},
			}),
			want: []string{"failed", "missing", "degraded", "progressing", "unknown", "unspecified", "healthy"},
		},
		{
			name: "sync severity across all values",
			applications: statusApplicationsBySync(project, []struct {
				name string
				sync SyncState
			}{
				{"synced", SyncStateSynced},
				{"unspecified", SyncStateUnspecified},
				{"unknown", SyncStateUnknown},
				{"out-of-sync", SyncStateOutOfSync},
			}),
			want: []string{"out-of-sync", "unknown", "unspecified", "synced"},
		},
		{
			name: "blocked gate count",
			applications: statusOrderingApplications(project, []statusOrderingValue{
				{name: "one", blockedGates: 1},
				{name: "three", blockedGates: 3},
				{name: "two", blockedGates: 2},
			}),
			want: []string{"three", "two", "one"},
		},
		{
			name: "maximum release or rollout change severity",
			applications: statusOrderingApplications(project, []statusOrderingValue{
				{name: "unspecified", blockedGates: 1},
				{name: "terminal", blockedGates: 1, release: ReleaseStateComplete, rollout: RolloutStateHealthy},
				{name: "active", blockedGates: 1, release: ReleaseStatePromoting, rollout: RolloutStateProgressing},
				{name: "paused", blockedGates: 1, release: ReleaseStateComplete, rollout: RolloutStatePaused},
				{name: "rolled-back", blockedGates: 1, release: ReleaseStateRolledBack},
				{name: "failed", blockedGates: 1, release: ReleaseStateComplete, rollout: RolloutStateFailed},
			}),
			want: []string{"failed", "rolled-back", "paused", "active", "terminal", "unspecified"},
		},
		{
			name:         "unique unhealthy connection count",
			applications: statusConnectionOrderingApplications(project),
			want:         []string{"three", "two", "one", "zero"},
		},
		{
			name: "managed resource count",
			applications: statusOrderingApplications(project, []statusOrderingValue{
				{name: "one", blockedGates: 1, resources: 1},
				{name: "three", blockedGates: 1, resources: 3},
				{name: "two", blockedGates: 1, resources: 2},
			}),
			want: []string{"three", "two", "one"},
		},
		{
			name: "newest transition",
			applications: statusOrderingApplications(project, []statusOrderingValue{
				{name: "oldest", blockedGates: 1, transition: 1},
				{name: "newest", blockedGates: 1, transition: 3},
				{name: "middle", blockedGates: 1, transition: 2},
			}),
			want: []string{"newest", "middle", "oldest"},
		},
		{
			name: "ascending namespace and name identity tie breaker",
			applications: []ApplicationSummary{
				statusAttentionApplication("z", "same", project),
				statusAttentionApplication("a", "z", project),
				statusAttentionApplication("a", "a", project),
			},
			want: []string{"a/a", "a/z", "z/same"},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			status, err := newQuerySnapshot(t, test.applications...).QueryStatus(
				QueryScope{Projects: ProjectSet{project: {}}},
				StatusQuery{AttentionLimit: 100},
			)
			require.NoError(t, err)
			if test.name == "ascending namespace and name identity tie breaker" {
				require.Equal(t, test.want, statusResultIDs(status.Attention))
				return
			}
			require.Equal(t, test.want, statusResultNames(status.Attention))
		})
	}
}

func TestQueryStatusAttentionOrderingIsStableAcrossMapInsertion(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "stable")
	applications := []ApplicationSummary{
		statusOrderingApplications(project, []statusOrderingValue{{name: "blocked", blockedGates: 4}})[0],
		statusOrderingApplications(project, []statusOrderingValue{{name: "resources", blockedGates: 1, resources: 9}})[0],
		statusOrderingApplications(project, []statusOrderingValue{{name: "newest", blockedGates: 1, resources: 1, transition: 9}})[0],
		statusOrderingApplications(project, []statusOrderingValue{{name: "identity", blockedGates: 1}})[0],
	}
	want := []string{"blocked", "resources", "newest", "identity"}
	random := rand.New(rand.NewSource(42)) // #nosec G404 -- deterministic test shuffling, not security.
	for iteration := 0; iteration < 50; iteration++ {
		random.Shuffle(len(applications), func(left, right int) {
			applications[left], applications[right] = applications[right], applications[left]
		})
		status, err := newQuerySnapshot(t, applications...).QueryStatus(
			QueryScope{Projects: ProjectSet{project: {}}},
			StatusQuery{AttentionLimit: 100},
		)
		require.NoError(t, err)
		require.Equal(t, want, statusResultNames(status.Attention), "iteration %d", iteration)
	}
}

func TestQueryStatusReturnsDefensiveClones(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "clones")
	application := statusAttentionApplication("apps", "clone", project)
	application.Targets = []StageTargetSummary{{StableID: "target", Stage: "production"}}
	application.ObservabilityBindings = []types.NamespacedName{fleetID("sources", "metrics")}
	snapshot := newQuerySnapshot(t, application)
	scope := QueryScope{
		Projects: ProjectSet{project: {}},
		CapabilitiesByProject: map[ProjectKey]CapabilitySet{
			project: {CapabilityApplicationSync: {}, CapabilityGateApprove: {}},
		},
	}

	first, err := snapshot.QueryStatus(scope, StatusQuery{})
	require.NoError(t, err)
	first.Attention[0].Summary.Targets[0].Stage = "mutated"
	first.Attention[0].Summary.ObservabilityBindings[0].Name = "mutated"
	first.Attention[0].Capabilities[0] = CapabilityPipelineRetry
	first.Health[HealthFailed] = 999

	require.Equal(t, "production", snapshot.Applications[application.Identity].Targets[0].Stage)
	require.Equal(t, "metrics", snapshot.Applications[application.Identity].ObservabilityBindings[0].Name)
	second, err := snapshot.QueryStatus(scope, StatusQuery{})
	require.NoError(t, err)
	require.Equal(t, "production", second.Attention[0].Summary.Targets[0].Stage)
	require.Equal(t, "metrics", second.Attention[0].Summary.ObservabilityBindings[0].Name)
	require.Equal(t, []Capability{CapabilityApplicationSync, CapabilityGateApprove}, second.Attention[0].Capabilities)
	require.Equal(t, uint64(1), second.Health[HealthFailed])
}

type statusOrderingValue struct {
	name         string
	blockedGates uint32
	release      ReleaseState
	rollout      RolloutState
	resources    uint32
	transition   int64
}

func statusApplication(namespace, name string, project ProjectKey) ApplicationSummary {
	return ApplicationSummary{
		Identity:                namespaceName(namespace, name),
		Project:                 project,
		Health:                  HealthHealthy,
		Sync:                    SyncStateSynced,
		ReleaseState:            ReleaseStateComplete,
		RolloutState:            RolloutStateHealthy,
		RepositoryConnection:    ConnectionStateHealthy,
		ObservabilityConnection: ConnectionStateHealthy,
	}
}

func statusApplicationWithChange(namespace, name string, project ProjectKey) ApplicationSummary {
	application := statusApplication(namespace, name, project)
	application.ReleaseState = ReleaseStatePromoting
	application.RolloutState = RolloutStateProgressing
	return application
}

func statusAttentionApplication(namespace, name string, project ProjectKey) ApplicationSummary {
	application := statusApplication(namespace, name, project)
	application.Health = HealthFailed
	return application
}

func statusApplicationsByHealth(project ProjectKey, values []struct {
	name   string
	health Health
}) []ApplicationSummary {
	applications := make([]ApplicationSummary, 0, len(values))
	for _, value := range values {
		application := statusApplication("apps", value.name, project)
		application.Health = value.health
		application.BlockedGateCount = 1
		applications = append(applications, application)
	}
	return applications
}

func statusApplicationsBySync(project ProjectKey, values []struct {
	name string
	sync SyncState
}) []ApplicationSummary {
	applications := make([]ApplicationSummary, 0, len(values))
	for _, value := range values {
		application := statusApplication("apps", value.name, project)
		application.Sync = value.sync
		application.BlockedGateCount = 1
		applications = append(applications, application)
	}
	return applications
}

func statusOrderingApplications(project ProjectKey, values []statusOrderingValue) []ApplicationSummary {
	applications := make([]ApplicationSummary, 0, len(values))
	for _, value := range values {
		application := statusApplication("apps", value.name, project)
		application.BlockedGateCount = value.blockedGates
		application.ReleaseState = value.release
		application.RolloutState = value.rollout
		application.ResourceCount = value.resources
		application.LastTransitionUnixMS = value.transition
		applications = append(applications, application)
	}
	return applications
}

func statusConnectionOrderingApplications(project ProjectKey) []ApplicationSummary {
	cluster := fleetID("connections", "cluster")
	values := []struct {
		name       string
		repository bool
		observe    bool
		targets    int
	}{
		{name: "zero"},
		{name: "one", targets: 2},
		{name: "two", repository: true, targets: 2},
		{name: "three", repository: true, observe: true, targets: 2},
	}
	applications := make([]ApplicationSummary, 0, len(values))
	for _, value := range values {
		application := statusApplication("apps", value.name, project)
		application.BlockedGateCount = 1
		if value.repository {
			application.Repository = fleetID("connections", "repository")
			application.RepositoryConnection = ConnectionStateUnhealthy
		}
		if value.observe {
			application.EffectiveObservabilitySource = fleetID("connections", "observability")
			application.ObservabilityConnection = ConnectionStateUnhealthy
		}
		for index := 0; index < value.targets; index++ {
			application.Targets = append(application.Targets, StageTargetSummary{
				StableID: statusName(index), Cluster: cluster, ClusterConnection: ConnectionStateUnhealthy,
			})
		}
		applications = append(applications, application)
	}
	return applications
}

func zeroHealthStatusBuckets() map[Health]uint64 {
	return map[Health]uint64{
		HealthUnspecified: 0,
		HealthHealthy:     0,
		HealthProgressing: 0,
		HealthDegraded:    0,
		HealthFailed:      0,
		HealthUnknown:     0,
		HealthMissing:     0,
	}
}

func zeroSyncStatusBuckets() map[SyncState]uint64 {
	return map[SyncState]uint64{
		SyncStateUnspecified: 0,
		SyncStateSynced:      0,
		SyncStateOutOfSync:   0,
		SyncStateUnknown:     0,
	}
}

func statusResultNames(results []ApplicationQueryResult) []string {
	names := make([]string, 0, len(results))
	for _, result := range results {
		names = append(names, result.Summary.Identity.Name)
	}
	return names
}

func statusResultIDs(results []ApplicationQueryResult) []string {
	identities := make([]string, 0, len(results))
	for _, result := range results {
		identities = append(identities, result.Summary.Identity.Namespace+"/"+result.Summary.Identity.Name)
	}
	return identities
}

func statusApplicationNames(applications []ApplicationSummary) []string {
	names := make([]string, 0, len(applications))
	for _, application := range applications {
		names = append(names, application.Identity.Name)
	}
	return names
}

func namespaceName(namespace, name string) types.NamespacedName {
	return types.NamespacedName{Namespace: namespace, Name: name}
}

func statusName(index int) string {
	const digits = "0123456789"
	return "app-" + string([]byte{
		digits[(index/100)%10],
		digits[(index/10)%10],
		digits[index%10],
	})
}

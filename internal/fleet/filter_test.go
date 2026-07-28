package fleet

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFilterUsesOrWithinDimensionsAndAndAcrossDimensions(t *testing.T) {
	t.Parallel()

	project := fleetID("projects", "payments")
	devCluster := fleetID("clusters", "dev")
	prodCluster := fleetID("clusters", "prod")
	checkout := ApplicationSummary{
		Identity: fleetID("apps", "checkout"),
		Project:  project,
		Targets: []StageTargetSummary{
			{Stage: "dev", Cluster: devCluster},
			{Stage: "prod", Cluster: prodCluster},
		},
		CurrentStage:   "prod",
		CurrentCluster: prodCluster,
		Health:         HealthDegraded,
		Sync:           SyncStateOutOfSync,
		ReleaseState:   ReleaseStateVerifying,
		RolloutState:   RolloutStateProgressing,
		SourceType:     SourceTypeGit,
	}
	worker := ApplicationSummary{
		Identity:     fleetID("apps", "worker"),
		Project:      project,
		Targets:      []StageTargetSummary{{Stage: "qa", Cluster: devCluster}},
		Health:       HealthHealthy,
		Sync:         SyncStateSynced,
		ReleaseState: ReleaseStateComplete,
		RolloutState: RolloutStateHealthy,
		SourceType:   SourceTypeHelm,
	}
	snapshot := newQuerySnapshot(t, checkout, worker)
	scope := QueryScope{Projects: ProjectSet{project: {}}}

	result, err := snapshot.FilterApplications(scope, ApplicationFilter{
		Clusters:      []ClusterKey{devCluster, devCluster},
		Stages:        []string{"prod", "prod"},
		Health:        []Health{HealthHealthy, HealthDegraded, HealthHealthy},
		Sync:          []SyncState{SyncStateOutOfSync},
		ReleaseStates: []ReleaseState{ReleaseStateVerifying},
		RolloutStates: []RolloutState{RolloutStateProgressing},
		SourceTypes:   []SourceType{SourceTypeGit},
	}, "")
	require.NoError(t, err)
	require.Equal(t, idSet(checkout.Identity), result.IDs)
	require.Contains(t, result.Matches, checkout.Identity)

	// Stage and Cluster each match any actual target. Neither predicate is tied
	// to the denormalized current-stage/current-cluster fields.
	result, err = snapshot.FilterApplications(scope, ApplicationFilter{
		Stages:   []string{"dev"},
		Clusters: []ClusterKey{prodCluster},
	}, "")
	require.NoError(t, err)
	require.Equal(t, idSet(checkout.Identity), result.IDs)
}

func TestFilterAuthorizesBeforeSearchAndFailsClosed(t *testing.T) {
	t.Parallel()

	publicProject := fleetID("team-a", "shared")
	otherPublicProject := fleetID("team-b", "shared")
	privateProject := fleetID("private", "secret")
	public := ApplicationSummary{Identity: fleetID("apps", "secret-helper"), Project: publicProject}
	otherPublic := ApplicationSummary{Identity: fleetID("apps", "ordinary"), Project: otherPublicProject}
	private := ApplicationSummary{Identity: fleetID("private", "secret"), Project: privateProject}
	snapshot := newQuerySnapshot(t, public, otherPublic, private)
	scope := QueryScope{
		Projects: ProjectSet{publicProject: {}, otherPublicProject: {}},
		CapabilitiesByProject: map[ProjectKey]CapabilitySet{
			publicProject: {CapabilityApplicationSync: {}, CapabilityGateApprove: {}},
		},
	}

	result, err := snapshot.FilterApplications(scope, ApplicationFilter{}, "secret")
	require.NoError(t, err)
	require.Equal(t, idSet(public.Identity), result.IDs)
	require.NotContains(t, result.Matches, private.Identity)
	require.Equal(t,
		[]Capability{CapabilityApplicationSync, CapabilityGateApprove},
		scope.SortedCapabilities(publicProject),
	)
	require.Empty(t, scope.SortedCapabilities(otherPublicProject))

	result, err = snapshot.FilterApplications(QueryScope{}, ApplicationFilter{}, "")
	require.NoError(t, err)
	require.Empty(t, result.IDs)
	require.Empty(t, result.Matches)
}

func newQuerySnapshot(t *testing.T, applications ...ApplicationSummary) *Snapshot {
	t.Helper()

	snapshot := NewSnapshot(1)
	for i := range applications {
		addApplicationMutable(snapshot, &applications[i])
	}
	snapshot.rebuildSearchIndex()
	return snapshot
}

package apiserver

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"
	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestGetSystemStatusValidatesRequest(t *testing.T) {
	t.Parallel()

	snapshot := buildSystemStatusSnapshot(t, 1, nil)
	tests := map[string]struct {
		request  *connect.Request[paprikav1.GetSystemStatusRequest]
		wantCode connect.Code
	}{
		"nil request":           {request: nil, wantCode: connect.CodeInvalidArgument},
		"limit above maximum":   {request: connect.NewRequest(&paprikav1.GetSystemStatusRequest{AttentionLimit: 101}), wantCode: connect.CodeInvalidArgument},
		"invalid namespace":     {request: connect.NewRequest(&paprikav1.GetSystemStatusRequest{Namespace: pointerTo("bad/name")}), wantCode: connect.CodeInvalidArgument},
		"empty namespace value": {request: connect.NewRequest(&paprikav1.GetSystemStatusRequest{Namespace: pointerTo("")}), wantCode: connect.CodeInvalidArgument},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := NewPaprikaServer(nil, nil, WithFleetIndex(&systemStatusReader{snapshot: snapshot}))
			_, err := server.GetSystemStatus(context.Background(), test.request)
			require.Equal(t, test.wantCode, connect.CodeOf(err))
		})
	}
}

func TestGetSystemStatusAttentionLimits(t *testing.T) {
	t.Parallel()

	applications := make([]fleet.ApplicationSummary, 0, 101)
	for i := 0; i < 101; i++ {
		applications = append(applications, systemStatusApplication(
			"tenant", fmt.Sprintf("app-%03d", i), "payments", fleet.HealthFailed, fleet.SyncStateOutOfSync,
		))
	}
	snapshot := buildSystemStatusSnapshot(t, 4, applications)
	tests := []struct {
		name       string
		limit      uint32
		wantLength int
	}{
		{name: "default", limit: 0, wantLength: 20},
		{name: "explicit one", limit: 1, wantLength: 1},
		{name: "explicit maximum", limit: 100, wantLength: 100},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := NewPaprikaServer(nil, nil, WithFleetIndex(&systemStatusReader{snapshot: snapshot}))
			response, err := server.GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{
				AttentionLimit: test.limit,
			}))
			require.NoError(t, err)
			require.Len(t, response.Msg.Attention, test.wantLength)
			require.Equal(t, uint64(101), response.Msg.AttentionTotal)
			require.True(t, response.Msg.HasMoreAttention)
		})
	}
}

func TestGetSystemStatusLoadsExactlyOneConsistentSnapshot(t *testing.T) {
	t.Parallel()

	first := buildSystemStatusSnapshot(t, 7, []fleet.ApplicationSummary{
		systemStatusApplication("tenant", "first", "payments", fleet.HealthFailed, fleet.SyncStateOutOfSync),
	})
	reader := &systemStatusReader{snapshot: first}
	reader.afterLoad = func() {
		reader.snapshot = buildSystemStatusSnapshot(t, 99, []fleet.ApplicationSummary{
			systemStatusApplication("tenant", "replacement", "payments", fleet.HealthHealthy, fleet.SyncStateSynced),
		})
	}

	server := NewPaprikaServer(nil, nil, WithFleetIndex(reader))
	response, err := server.GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
	require.NoError(t, err)
	require.Equal(t, 1, reader.loadCalls)
	require.Equal(t, uint64(7), response.Msg.IndexGeneration)
	require.Equal(t, uint64(1), response.Msg.Total)
	require.Len(t, response.Msg.Attention, 1)
	require.Equal(t, "first", response.Msg.Attention[0].Identity.Name)
}

func TestGetSystemStatusReturnsFixedOrderedBuckets(t *testing.T) {
	t.Parallel()

	wantHealth := []paprikav1.FleetHealth{
		paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED,
		paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY,
		paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING,
		paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED,
		paprikav1.FleetHealth_FLEET_HEALTH_FAILED,
		paprikav1.FleetHealth_FLEET_HEALTH_UNKNOWN,
		paprikav1.FleetHealth_FLEET_HEALTH_MISSING,
	}
	wantSync := []paprikav1.FleetSyncState{
		paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNSPECIFIED,
		paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED,
		paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC,
		paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNKNOWN,
	}
	tests := map[string]struct {
		applications []fleet.ApplicationSummary
		healthCounts []uint64
		syncCounts   []uint64
	}{
		"populated": {
			applications: []fleet.ApplicationSummary{
				systemStatusApplication("tenant", "healthy", "payments", fleet.HealthHealthy, fleet.SyncStateSynced),
				systemStatusApplication("tenant", "failed", "payments", fleet.HealthFailed, fleet.SyncStateOutOfSync),
				systemStatusApplication("tenant", "unknown", "payments", fleet.HealthUnknown, fleet.SyncStateUnknown),
			},
			healthCounts: []uint64{0, 1, 0, 0, 1, 1, 0},
			syncCounts:   []uint64{0, 1, 1, 1},
		},
		"sparse": {
			applications: []fleet.ApplicationSummary{
				systemStatusApplication("tenant", "missing", "payments", fleet.HealthMissing, fleet.SyncStateUnspecified),
			},
			healthCounts: []uint64{0, 0, 0, 0, 0, 0, 1},
			syncCounts:   []uint64{1, 0, 0, 0},
		},
		"empty": {
			healthCounts: []uint64{0, 0, 0, 0, 0, 0, 0},
			syncCounts:   []uint64{0, 0, 0, 0},
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := NewPaprikaServer(nil, nil, WithFleetIndex(&systemStatusReader{
				snapshot: buildSystemStatusSnapshot(t, 12, test.applications),
			}))
			response, err := server.GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
			require.NoError(t, err)
			require.Len(t, response.Msg.Health, 7)
			require.Len(t, response.Msg.Sync, 4)
			for i, want := range wantHealth {
				require.Equal(t, want, response.Msg.Health[i].Health)
				require.Equal(t, test.healthCounts[i], response.Msg.Health[i].Count)
			}
			for i, want := range wantSync {
				require.Equal(t, want, response.Msg.Sync[i].Sync)
				require.Equal(t, test.syncCounts[i], response.Msg.Sync[i].Count)
			}
		})
	}
}

func TestGetSystemStatusAuthorizesBeforeAggregation(t *testing.T) {
	t.Parallel()

	visible := systemStatusApplication("tenant-a", "checkout", "payments", fleet.HealthFailed, fleet.SyncStateOutOfSync)
	visible.SourceRevision = "visible-revision"
	hidden := systemStatusApplication("tenant-b", "secret-app-marker", "secret-project-marker", fleet.HealthFailed, fleet.SyncStateSynced)
	hidden.SourceRevision = "secret-revision-marker"
	hidden.CurrentClusterLabel = "secret-cluster-marker"
	hidden.Targets = []fleet.StageTargetSummary{{
		StableID: "secret-target-marker", Stage: "secret-stage-marker",
		Cluster:      types.NamespacedName{Namespace: "tenant-b", Name: "secret-cluster-marker"},
		ClusterLabel: "secret-cluster-label-marker", Health: fleet.HealthFailed,
	}}
	snapshot := buildSystemStatusSnapshot(t, 18, []fleet.ApplicationSummary{visible, hidden})
	leakyStatus, err := snapshot.QueryStatus(fleet.QueryScope{Projects: fleet.ProjectSet{
		visible.Project: {},
		hidden.Project:  {},
	}}, fleet.StatusQuery{})
	require.NoError(t, err)
	require.Equal(t, uint64(2), leakyStatus.AttentionTotal, "fixture must expose an attention leak under unrestricted scope")
	require.Len(t, leakyStatus.Attention, 2)
	require.Equal(t, hidden.Identity, leakyStatus.Attention[1].Summary.Identity)
	require.Equal(t, "secret-revision-marker", leakyStatus.Attention[1].Summary.SourceRevision)

	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects: []string{"alice"}, Actions: []string{string(auth.ActionRead)},
		Resources:  []string{string(auth.ResourceApplications)},
		Namespaces: []string{"tenant-a"}, Projects: []string{"payments"},
	}})
	server := NewPaprikaServer(nil, nil, WithAuthorizer(authorizer), WithFleetIndex(&systemStatusReader{snapshot: snapshot}))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	response, err := server.GetSystemStatus(ctx, connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
	require.NoError(t, err)
	require.Equal(t, uint64(18), response.Msg.IndexGeneration)
	require.Equal(t, uint64(1), response.Msg.Total)
	require.Equal(t, uint64(1), response.Msg.AttentionTotal)
	require.Len(t, response.Msg.Attention, 1)
	require.Equal(t, "tenant-a", response.Msg.Attention[0].Identity.Namespace)
	require.Equal(t, "checkout", response.Msg.Attention[0].Identity.Name)
	require.Equal(t, "tenant-a", response.Msg.Attention[0].Project.Namespace)
	require.Equal(t, "payments", response.Msg.Attention[0].Project.Name)
	require.Equal(t, []uint64{0, 0, 0, 0, 1, 0, 0}, systemStatusHealthCounts(response.Msg.Health))
	require.Equal(t, []uint64{0, 0, 1, 0}, systemStatusSyncCounts(response.Msg.Sync))

	encoded, marshalErr := protojson.Marshal(response.Msg)
	require.NoError(t, marshalErr)
	for _, marker := range []string{
		"tenant-b", "secret-app-marker", "secret-project-marker", "secret-revision-marker", "secret-cluster-marker",
		"secret-target-marker", "secret-stage-marker", "secret-cluster-label-marker",
	} {
		require.NotContains(t, string(encoded), marker)
	}
}

func TestGetSystemStatusEmptyAuthorizedScopeSucceeds(t *testing.T) {
	t.Parallel()

	snapshot := buildSystemStatusSnapshot(t, 21, []fleet.ApplicationSummary{
		systemStatusApplication("tenant", "hidden", "payments", fleet.HealthFailed, fleet.SyncStateOutOfSync),
	})
	authorizer := &fleetScopeAuthorizer{}
	server := NewPaprikaServer(nil, nil, WithAuthorizer(authorizer), WithFleetIndex(&systemStatusReader{snapshot: snapshot}))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	response, err := server.GetSystemStatus(ctx, connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
	require.NoError(t, err)
	require.Equal(t, uint64(21), response.Msg.IndexGeneration)
	require.Zero(t, response.Msg.Total)
	require.Zero(t, response.Msg.AttentionTotal)
	require.Empty(t, response.Msg.Attention)
	require.False(t, response.Msg.HasMoreAttention)
	require.Len(t, response.Msg.Health, 7)
	require.Len(t, response.Msg.Sync, 4)
	for _, bucket := range response.Msg.Health {
		require.Zero(t, bucket.Count)
	}
	for _, bucket := range response.Msg.Sync {
		require.Zero(t, bucket.Count)
	}
	require.Len(t, authorizer.authorizedCalls, 1)
}

func TestGetSystemStatusErrorMappingIsGeneric(t *testing.T) {
	t.Parallel()

	t.Run("nil index", func(t *testing.T) {
		_, err := NewPaprikaServer(nil, nil).GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
		require.Equal(t, connect.CodeUnavailable, connect.CodeOf(err))
	})

	t.Run("unavailable snapshot", func(t *testing.T) {
		reader := &systemStatusReader{loadErr: &fleet.ErrUnavailable{Reason: "warming"}}
		_, err := NewPaprikaServer(nil, nil, WithFleetIndex(reader)).GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
		require.Equal(t, connect.CodeUnavailable, connect.CodeOf(err))
	})

	t.Run("unexpected snapshot error", func(t *testing.T) {
		const marker = "snapshot-secret-marker"
		reader := &systemStatusReader{loadErr: errors.New(marker)}
		_, err := NewPaprikaServer(nil, nil, WithFleetIndex(reader)).GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		require.NotContains(t, err.Error(), marker)
	})

	for name, authorizerErr := range map[string]error{
		"denial":     fmt.Errorf("authorization-denial-marker: %w", auth.ErrUnauthorized),
		"unexpected": errors.New("authorization-secret-marker"),
	} {
		t.Run(name, func(t *testing.T) {
			marker := authorizerErr.Error()
			authorizer := &fleetScopeAuthorizer{authorizedErr: authorizerErr}
			reader := &systemStatusReader{snapshot: buildSystemStatusSnapshot(t, 1, []fleet.ApplicationSummary{
				systemStatusApplication("tenant", "app", "payments", fleet.HealthHealthy, fleet.SyncStateSynced),
			})}
			server := NewPaprikaServer(nil, nil, WithAuthorizer(authorizer), WithFleetIndex(reader))
			ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})
			_, err := server.GetSystemStatus(ctx, connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
			if errors.Is(authorizerErr, auth.ErrUnauthorized) {
				require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
			} else {
				require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
			}
			require.NotContains(t, err.Error(), marker)
		})
	}

	t.Run("missing principal", func(t *testing.T) {
		reader := &systemStatusReader{snapshot: buildSystemStatusSnapshot(t, 1, []fleet.ApplicationSummary{
			systemStatusApplication("tenant", "app", "payments", fleet.HealthHealthy, fleet.SyncStateSynced),
		})}
		server := NewPaprikaServer(nil, nil, WithAuthorizer(&fleetScopeAuthorizer{}), WithFleetIndex(reader))
		_, err := server.GetSystemStatus(context.Background(), connect.NewRequest(&paprikav1.GetSystemStatusRequest{}))
		require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
		require.NotContains(t, err.Error(), "missing principal")
	})
}

type systemStatusReader struct {
	snapshot  *fleet.Snapshot
	loadErr   error
	loadCalls int
	afterLoad func()
}

func (*systemStatusReader) ProjectKeys(context.Context, []string) ([]fleet.ProjectKey, error) {
	panic("GetSystemStatus must derive projects from its loaded snapshot")
}

func (*systemStatusReader) QueryApplications(context.Context, fleet.QueryScope, fleet.ApplicationQuery, string) (fleet.ApplicationPage, error) {
	panic("unexpected QueryApplications call")
}

func (*systemStatusReader) QueryMap(context.Context, fleet.QueryScope, fleet.FleetMapQuery) (fleet.FleetMap, error) {
	panic("unexpected QueryMap call")
}

func (*systemStatusReader) QueryMatrix(context.Context, fleet.QueryScope, fleet.FleetMatrixQuery) (fleet.FleetMatrix, error) {
	panic("unexpected QueryMatrix call")
}

func (r *systemStatusReader) LoadSnapshot() (*fleet.Snapshot, error) {
	r.loadCalls++
	snapshot, err := r.snapshot, r.loadErr
	if r.afterLoad != nil {
		afterLoad := r.afterLoad
		r.afterLoad = nil
		afterLoad()
	}
	return snapshot, err
}

func (*systemStatusReader) CheckReady() error { return nil }

func systemStatusApplication(namespace, name, project string, health fleet.Health, syncState fleet.SyncState) fleet.ApplicationSummary {
	return fleet.ApplicationSummary{
		Identity: types.NamespacedName{Namespace: namespace, Name: name},
		Project:  types.NamespacedName{Namespace: namespace, Name: project},
		Health:   health, Sync: syncState, ResourceCount: 1,
	}
}

func buildSystemStatusSnapshot(t *testing.T, generation uint64, applications []fleet.ApplicationSummary) *fleet.Snapshot {
	t.Helper()
	baseIndex := fleet.NewIndex()
	installFleetAuthorizationSnapshot(t, baseIndex, applications)
	base, err := baseIndex.LoadSnapshot()
	require.NoError(t, err)

	snapshot := fleet.NewSnapshot(generation)
	snapshot.Applications = base.Applications
	snapshot.Projects = base.Projects
	snapshot.Clusters = base.Clusters
	snapshot.ByProject = base.ByProject
	snapshot.ByNamespace = base.ByNamespace
	snapshot.ByCluster = base.ByCluster
	snapshot.ByStage = base.ByStage
	snapshot.ByHealth = base.ByHealth
	snapshot.BySync = base.BySync
	snapshot.ByRelease = base.ByRelease
	snapshot.ByRollout = base.ByRollout
	snapshot.BySourceType = base.BySourceType

	index := fleet.NewIndex()
	require.NoError(t, index.Install(snapshot))
	loaded, err := index.LoadSnapshot()
	require.NoError(t, err)
	return loaded
}

func pointerTo[T any](value T) *T { return &value }

func systemStatusHealthCounts(buckets []*paprikav1.FleetHealthBucket) []uint64 {
	counts := make([]uint64, 0, len(buckets))
	for _, bucket := range buckets {
		counts = append(counts, bucket.Count)
	}
	return counts
}

func systemStatusSyncCounts(buckets []*paprikav1.FleetSyncBucket) []uint64 {
	counts := make([]uint64, 0, len(buckets))
	for _, bucket := range buckets {
		counts = append(counts, bucket.Count)
	}
	return counts
}

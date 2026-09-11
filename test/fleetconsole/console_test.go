package main

import (
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func newTestService(t *testing.T, mode dataSourceMode, applications int) v1connect.PaprikaServiceHandler {
	t.Helper()

	fixture, err := seedFixture(t.Context(), applications)
	require.NoError(t, err)
	server := apiserver.NewPaprikaServer(fixture.client, nil, apiserver.WithFleetIndex(fixture.index))
	service, err := newFixtureService(t.Context(), server, fixture, mode)
	require.NoError(t, err)
	return service
}

func dataSourceStates(
	t *testing.T,
	service v1connect.PaprikaServiceHandler,
) map[paprikav1.DataClass]*paprikav1.DataSourceStatus {
	t.Helper()

	response, err := service.GetDataSources(t.Context(), connect.NewRequest(&paprikav1.GetDataSourcesRequest{}))
	require.NoError(t, err)
	// One entry per DataClass, in enum order, always — the invariant the
	// console's boot-time probe depends on. Twelve is the enum's size today.
	require.Len(t, response.Msg.GetSources(), 12)
	byClass := make(map[paprikav1.DataClass]*paprikav1.DataSourceStatus, len(response.Msg.GetSources()))
	for _, source := range response.Msg.GetSources() {
		byClass[source.GetDataClass()] = source
	}
	return byClass
}

// TestDataSourceModesSelectExactlyTheDocumentedClasses pins the contract the
// --data-sources flag exists to provide. The realistic row is the important
// one: it is the shape most installs are in, and a regression that quietly
// promoted cost or signals to OK would make the degraded console untestable
// without anyone noticing.
func TestDataSourceModesSelectExactlyTheDocumentedClasses(t *testing.T) {
	t.Parallel()

	external := []paprikav1.DataClass{
		paprikav1.DataClass_DATA_CLASS_APPLICATION_SIGNALS,
		paprikav1.DataClass_DATA_CLASS_COST,
	}
	derivable := []paprikav1.DataClass{
		paprikav1.DataClass_DATA_CLASS_CLUSTER_INVENTORY,
		paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY,
		paprikav1.DataClass_DATA_CLASS_SOURCE_EVENTS,
		paprikav1.DataClass_DATA_CLASS_ROLLOUT_HISTORY,
		paprikav1.DataClass_DATA_CLASS_PIPELINE_RUNS,
		paprikav1.DataClass_DATA_CLASS_COMMIT_METADATA,
		paprikav1.DataClass_DATA_CLASS_OWNERSHIP,
		paprikav1.DataClass_DATA_CLASS_DRIFT_DETAIL,
		paprikav1.DataClass_DATA_CLASS_LIFECYCLE,
	}

	for _, testCase := range []struct {
		mode       dataSourceMode
		wantOK     []paprikav1.DataClass
		wantAbsent []paprikav1.DataClass
	}{
		{mode: dataSourcesNone, wantAbsent: append(append([]paprikav1.DataClass{}, derivable...), external...)},
		{mode: dataSourcesRealistic, wantOK: derivable, wantAbsent: external},
		{mode: dataSourcesAll, wantOK: append(append([]paprikav1.DataClass{}, derivable...), external...)},
	} {
		t.Run(string(testCase.mode), func(t *testing.T) {
			t.Parallel()

			byClass := dataSourceStates(t, newTestService(t, testCase.mode, 24))
			for _, class := range testCase.wantOK {
				source := byClass[class]
				require.Equal(t, paprikav1.DataState_DATA_STATE_OK, source.GetState(), class.String())
				require.NotEmpty(t, source.GetProvider(), class.String())
				// A configured class must not also carry a reason not to be.
				require.Empty(t, source.GetUnavailableReason(), class.String())
			}
			for _, class := range testCase.wantAbsent {
				source := byClass[class]
				require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, source.GetState(), class.String())
				// Degraded-mode contract: an absent class always says what to
				// do about it, and never quotes a number beside the absence.
				require.NotEmpty(t, source.GetUnavailableReason(), class.String())
				require.Zero(t, source.GetObservedAtUnixMs(), class.String())
			}
		})
	}
}

// TestDegradedModeIsTheRealServerNotAnImitation is the reason dataSourcesNone
// returns the server unwrapped: if the fixture reimplemented the degraded
// answers, the console could be developed against wording the control plane
// never emits.
func TestDegradedModeIsTheRealServerNotAnImitation(t *testing.T) {
	t.Parallel()

	fixture, err := seedFixture(t.Context(), 12)
	require.NoError(t, err)
	server := apiserver.NewPaprikaServer(fixture.client, nil, apiserver.WithFleetIndex(fixture.index))
	service, err := newFixtureService(t.Context(), server, fixture, dataSourcesNone)
	require.NoError(t, err)
	require.Same(t, server, service)
}

// TestRealisticModeDegradesUsageWithoutDegradingCapacity encodes design section
// 4.4: allocatable and requested are real even with no metrics-server, and only
// the used component goes dark. A meter that degraded wholesale would hide the
// headroom the console is supposed to draw.
func TestRealisticModeDegradesUsageWithoutDegradingCapacity(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 24)
	response, err := service.ListClusters(t.Context(), connect.NewRequest(&paprikav1.ListClustersRequest{
		PageSize: 5, IncludeCapacity: true,
	}))
	require.NoError(t, err)
	require.NotEmpty(t, response.Msg.GetClusters())

	cpu := response.Msg.GetClusters()[0].GetCapacity().GetCpu()
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, cpu.GetAllocatableState())
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, cpu.GetRequestedState())
	require.Positive(t, cpu.GetAllocatable())
	// NOT_AVAILABLE is the state design section 4.2 defines for a configured
	// source whose capability is absent, and section 4.4 names an absent
	// metrics-server as exactly that. NOT_CONFIGURED would tell the console to
	// hide the meter instead of greying its used band.
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_AVAILABLE, cpu.GetUsedState())
	// Zero, not a stale or plausible figure: a client ignoring used_state must
	// render an obviously wrong 0 rather than a believable lie.
	require.Zero(t, cpu.GetUsed())
	require.NotEmpty(t, cpu.GetUnavailableReason())
	require.Empty(t, response.Msg.GetClusters()[0].GetCapacity().GetUsageProvider())
}

func TestIncludeCapacityFalseOmitsTheMetersEntirely(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesAll, 24)
	response, err := service.ListClusters(t.Context(), connect.NewRequest(&paprikav1.ListClustersRequest{
		PageSize: 3,
	}))
	require.NoError(t, err)
	require.NotEmpty(t, response.Msg.GetClusters())
	require.Nil(t, response.Msg.GetClusters()[0].GetCapacity())
}

// TestPipelineRunIdentitiesRoundTrip is the regression guard for the bug this
// fixture would otherwise have: an ordinal-only run identifier resolves to a
// different application depending on whether the page it came from was
// namespace-filtered, so opening a row would have shown someone else's run.
func TestPipelineRunIdentitiesRoundTrip(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 60)
	namespace := fixtureNamespace(5)
	for _, request := range []*paprikav1.ListPipelineRunsRequest{
		{PageSize: 5},
		{PageSize: 5, Namespace: &namespace},
	} {
		listed, err := service.ListPipelineRuns(t.Context(), connect.NewRequest(request))
		require.NoError(t, err)
		require.NotEmpty(t, listed.Msg.GetRuns())
		for _, run := range listed.Msg.GetRuns() {
			fetched, fetchErr := service.GetPipelineRun(t.Context(), connect.NewRequest(&paprikav1.GetPipelineRunRequest{
				Namespace: run.GetIdentity().GetNamespace(), Name: run.GetIdentity().GetName(),
			}))
			require.NoError(t, fetchErr, run.GetIdentity().GetName())
			require.Equal(t,
				run.GetApplication().GetName(),
				fetched.Msg.GetRun().GetApplication().GetName(),
			)
		}
	}
}

func TestGetPipelineRunRefusesUnknownAndCrossNamespaceNames(t *testing.T) {
	t.Parallel()

	service := newTestService(t, dataSourcesRealistic, 60)
	for _, target := range []*paprikav1.GetPipelineRunRequest{
		{Namespace: fixtureNamespace(0), Name: "not-a-run"},
		{Namespace: fixtureNamespace(0), Name: "run-99999-0"},
		// Application 0 lives in team-00, so this identifier is real but is
		// addressed to the wrong tenant.
		{Namespace: fixtureNamespace(1), Name: "run-0-0"},
	} {
		_, err := service.GetPipelineRun(t.Context(), connect.NewRequest(target))
		require.Error(t, err, target.GetName())
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err), target.GetName())
	}
}

// TestMutationsStayRefusedInEveryMode: --data-sources selects what is readable
// and must never grant a write. An e2e test that could hold a rollout against
// the fixture would be asserting behaviour production refuses.
func TestMutationsStayRefusedInEveryMode(t *testing.T) {
	t.Parallel()

	for _, mode := range []dataSourceMode{dataSourcesNone, dataSourcesRealistic, dataSourcesAll} {
		t.Run(string(mode), func(t *testing.T) {
			t.Parallel()

			service := newTestService(t, mode, 12)
			namespace := fixtureNamespace(0)
			name := fixtureApplicationName(0)
			mutations := map[string]error{}
			_, mutations["HoldRollout"] = service.HoldRollout(t.Context(),
				connect.NewRequest(&paprikav1.HoldRolloutRequest{Namespace: namespace, Name: name}))
			_, mutations["ResumeRollout"] = service.ResumeRollout(t.Context(),
				connect.NewRequest(&paprikav1.ResumeRolloutRequest{Namespace: namespace, Name: name}))
			_, mutations["IgnoreDriftedField"] = service.IgnoreDriftedField(t.Context(),
				connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{Namespace: namespace, Name: name}))
			_, mutations["ApplyResourcePatch"] = service.ApplyResourcePatch(t.Context(),
				connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{Namespace: namespace, Name: name}))
			_, mutations["SyncResources"] = service.SyncResources(t.Context(),
				connect.NewRequest(&paprikav1.SyncResourcesRequest{Namespace: namespace, Name: name}))
			for rpc, err := range mutations {
				require.Error(t, err, rpc)
				require.Equal(t, connect.CodeUnimplemented, connect.CodeOf(err), rpc)
			}
		})
	}
}

// TestFeedsAndInventoryDoNotScaleWithTheFleet is the guard on the fixture's
// only hard performance requirement: hack/test-fleet-scale.sh runs it at
// --applications 10000, and nothing here may allocate per application.
func TestFeedsAndInventoryDoNotScaleWithTheFleet(t *testing.T) {
	t.Parallel()

	small := newTestService(t, dataSourcesRealistic, 24)
	large := newTestService(t, dataSourcesRealistic, 2400)
	for _, service := range []v1connect.PaprikaServiceHandler{small, large} {
		clusters, err := service.ListClusters(t.Context(), connect.NewRequest(&paprikav1.ListClustersRequest{
			PageSize: 100,
		}))
		require.NoError(t, err)
		// Two clusters per seeded namespace, and the namespace count is capped.
		require.Equal(t, uint64(fixtureNamespaceCount*len(fixtureClusterSpecs)), clusters.Msg.GetTotal())

		events, err := service.ListSourceEvents(t.Context(), connect.NewRequest(&paprikav1.ListSourceEventsRequest{}))
		require.NoError(t, err)
		require.LessOrEqual(t, len(events.Msg.GetEvents()), defaultHistoryPageSize)

		runs, err := service.ListPipelineRuns(t.Context(), connect.NewRequest(&paprikav1.ListPipelineRunsRequest{}))
		require.NoError(t, err)
		require.LessOrEqual(t, len(runs.Msg.GetRuns()), defaultHistoryPageSize)
	}
}

// TestSyntheticDataIsDeterministic: a Playwright assertion may name a value
// only if two processes agree on it.
func TestSyntheticDataIsDeterministic(t *testing.T) {
	t.Parallel()

	first := newTestService(t, dataSourcesAll, 24)
	second := newTestService(t, dataSourcesAll, 24)
	request := func(service v1connect.PaprikaServiceHandler) *paprikav1.CommitInfo {
		response, err := service.GetRevisionInfo(t.Context(), connect.NewRequest(&paprikav1.GetRevisionInfoRequest{
			Namespace: fixtureNamespace(0), Application: fixtureApplicationName(0),
		}))
		require.NoError(t, err)
		return response.Msg.GetCommit()
	}
	left, right := request(first), request(second)
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, left.GetState())
	require.Len(t, left.GetRevision(), 40)
	require.Equal(t, left.GetRevision(), right.GetRevision())
	require.Equal(t, left.GetAuthorName(), right.GetAuthorName())
	require.Equal(t, left.GetMessage(), right.GetMessage())
}

func TestParseDataSourceModeRejectsUnknownValues(t *testing.T) {
	t.Parallel()

	defaults, err := parseConfig(nil)
	require.NoError(t, err)
	require.Equal(t, dataSourcesRealistic, defaults.dataSources)

	for _, value := range []string{"all", "none", "realistic"} {
		parsed, parseErr := parseConfig([]string{"--data-sources", value})
		require.NoError(t, parseErr)
		require.Equal(t, dataSourceMode(value), parsed.dataSources)
	}
	_, err = parseConfig([]string{"--data-sources", "everything"})
	require.Error(t, err)
}

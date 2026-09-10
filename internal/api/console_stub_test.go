package apiserver

import (
	"context"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

// The console redesign lands its wire contract ahead of every collector behind
// it, which makes the degraded shape a server obligation rather than a
// placeholder (design docs/superpowers/specs/console-redesign/01-backend-design.md
// section 4). These tests hold that obligation: one status per DataClass, every
// DataState reading NOT_CONFIGURED, every numeric beside it zero, and no
// mutation reporting a success it did not perform. A stub that quietly starts
// answering plausibly is a worse regression than one that fails, because the
// console cannot tell the difference.

// consoleStubGeneration is the fleet index generation every stub response must
// echo, so a response cannot claim to have authorized against a snapshot it
// never loaded.
const consoleStubGeneration = 12

// dataStateFullName identifies the enum whose members carry the degraded-mode
// contract. Only fields of this enum are held to NOT_CONFIGURED — a
// LifecyclePhaseState of UNKNOWN, for instance, says something different and
// must not be conflated with it.
const dataStateFullName = protoreflect.FullName("paprika.v1.DataState")

// consoleNumericKinds is the set of field kinds a client could render as a
// measurement. It is a map rather than a switch so that adding a scalar kind to
// protobuf cannot silently narrow the check.
var consoleNumericKinds = map[protoreflect.Kind]struct{}{
	protoreflect.Int32Kind: {}, protoreflect.Int64Kind: {},
	protoreflect.Uint32Kind: {}, protoreflect.Uint64Kind: {},
	protoreflect.Sint32Kind: {}, protoreflect.Sint64Kind: {},
	protoreflect.Fixed32Kind: {}, protoreflect.Fixed64Kind: {},
	protoreflect.Sfixed32Kind: {}, protoreflect.Sfixed64Kind: {},
	protoreflect.FloatKind: {}, protoreflect.DoubleKind: {},
}

func TestGetDataSourcesReportsEveryDataClassInEnumOrder(t *testing.T) {
	t.Parallel()

	// The fixed table mirrors the seven-health / four-sync bucket convention the
	// system status surface already follows: every enum member is emitted,
	// UNSPECIFIED included, so the response length and order are invariants the
	// console can index by instead of searching.
	wantClasses := []paprikav1.DataClass{
		paprikav1.DataClass_DATA_CLASS_UNSPECIFIED,
		paprikav1.DataClass_DATA_CLASS_CLUSTER_INVENTORY,
		paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY,
		paprikav1.DataClass_DATA_CLASS_APPLICATION_SIGNALS,
		paprikav1.DataClass_DATA_CLASS_COST,
		paprikav1.DataClass_DATA_CLASS_SOURCE_EVENTS,
		paprikav1.DataClass_DATA_CLASS_ROLLOUT_HISTORY,
		paprikav1.DataClass_DATA_CLASS_PIPELINE_RUNS,
		paprikav1.DataClass_DATA_CLASS_COMMIT_METADATA,
		paprikav1.DataClass_DATA_CLASS_OWNERSHIP,
		paprikav1.DataClass_DATA_CLASS_DRIFT_DETAIL,
		paprikav1.DataClass_DATA_CLASS_LIFECYCLE,
	}
	tests := map[string]struct {
		namespace *string
	}{
		"whole fleet":      {namespace: nil},
		"namespace filter": {namespace: pointerTo("tenant")},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := consoleStubServer(t)
			response, err := server.GetDataSources(context.Background(), connect.NewRequest(
				&paprikav1.GetDataSourcesRequest{Namespace: test.namespace},
			))
			require.NoError(t, err)

			// Derived from the descriptor as well as from the table: a DataClass
			// added to the proto without a status beside it fails here, which is
			// the whole point of a probe the console gates every board on.
			classes := paprikav1.DataClass_DATA_CLASS_UNSPECIFIED.Descriptor().Values()
			require.Equal(t, classes.Len(), len(wantClasses), "table must cover every DataClass member")
			require.Len(t, response.Msg.Sources, len(wantClasses), "one status per DataClass, always")

			for i, want := range wantClasses {
				source := response.Msg.Sources[i]
				require.Equalf(t, want, source.DataClass, "status %d is out of enum order", i)
				require.Equalf(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, source.State,
					"%s must report NOT_CONFIGURED while nothing is collecting", want)
				require.NotEmptyf(t, source.UnavailableReason, "%s must carry an actionable reason", want)
			}
			require.Equal(t, uint64(consoleStubGeneration), response.Msg.IndexGeneration)
		})
	}
}

func TestConsoleReadStubsReportNotConfiguredWithZeroedNumerics(t *testing.T) {
	t.Parallel()

	application := &paprikav1.FleetObjectKey{Namespace: "tenant", Name: "checkout"}
	tests := map[string]struct {
		call func(context.Context, *PaprikaServer) (proto.Message, error)
		// wantNotConfigured is how many DataState fields the response carries.
		// It is asserted rather than merely walked so that a stub cannot pass by
		// dropping a state field: an unset DataState decodes as UNSPECIFIED,
		// which reads as "unknown", not as "nothing is configured".
		wantNotConfigured int
	}{
		"GetDataSources": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.GetDataSources(ctx, connect.NewRequest(
					&paprikav1.GetDataSourcesRequest{},
				)))
			},
			wantNotConfigured: 12,
		},
		"ListClusters": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ListClusters(ctx, connect.NewRequest(
					&paprikav1.ListClustersRequest{},
				)))
			},
			wantNotConfigured: 0,
		},
		"GetCluster": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.GetCluster(ctx, connect.NewRequest(
					&paprikav1.GetClusterRequest{Namespace: "tenant", Name: "eu-west-1"},
				)))
			},
			// Inventory, agent, cost and the used/requested/allocatable states on
			// each of the two capacity meters.
			wantNotConfigured: 9,
		},
		"QueryApplicationSignals": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.QueryApplicationSignals(ctx, connect.NewRequest(
					&paprikav1.QueryApplicationSignalsRequest{Applications: []*paprikav1.FleetObjectKey{application}},
				)))
			},
			// The response, the one application, and one per concrete signal kind.
			wantNotConfigured: 6,
		},
		"QueryCost": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.QueryCost(ctx, connect.NewRequest(
					&paprikav1.QueryCostRequest{},
				)))
			},
			wantNotConfigured: 2,
		},
		"ListSourceEvents": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ListSourceEvents(ctx, connect.NewRequest(
					&paprikav1.ListSourceEventsRequest{},
				)))
			},
			wantNotConfigured: 1,
		},
		"ListRolloutHistory": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ListRolloutHistory(ctx, connect.NewRequest(
					&paprikav1.ListRolloutHistoryRequest{},
				)))
			},
			// The feed and its aggregate, so no caller can read the zeroed stats
			// as a fleet-lifetime success rate.
			wantNotConfigured: 2,
		},
		"ListPipelineRuns": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ListPipelineRuns(ctx, connect.NewRequest(
					&paprikav1.ListPipelineRunsRequest{},
				)))
			},
			wantNotConfigured: 1,
		},
		"GetRevisionInfo": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.GetRevisionInfo(ctx, connect.NewRequest(
					&paprikav1.GetRevisionInfoRequest{Namespace: "tenant", Application: "checkout"},
				)))
			},
			// The commit itself and the run number, which are separately sourced.
			wantNotConfigured: 2,
		},
		"GetApplicationOwnership": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.GetApplicationOwnership(ctx, connect.NewRequest(
					&paprikav1.GetApplicationOwnershipRequest{Namespace: "tenant", Name: "checkout"},
				)))
			},
			wantNotConfigured: 1,
		},
		"ListDriftDetails": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ListDriftDetails(ctx, connect.NewRequest(
					&paprikav1.ListDriftDetailsRequest{Namespace: "tenant", Application: "checkout"},
				)))
			},
			wantNotConfigured: 1,
		},
		"GetApplicationLifecycle": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.GetApplicationLifecycle(ctx, connect.NewRequest(
					&paprikav1.GetApplicationLifecycleRequest{Namespace: "tenant", Name: "checkout"},
				)))
			},
			// Lifecycle phases carry LifecyclePhaseState, not DataState: the
			// control plane does not know the phases yet, which is UNKNOWN rather
			// than NOT_CONFIGURED.
			wantNotConfigured: 0,
		},
		"GetRolloutHold": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.GetRolloutHold(ctx, connect.NewRequest(
					&paprikav1.GetRolloutHoldRequest{Namespace: "tenant", Name: "checkout"},
				)))
			},
			// A hold carries no DataState: "not held" is literally true while
			// holds are unimplemented, so there is nothing to degrade.
			wantNotConfigured: 0,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := consoleStubServer(t)
			message, err := test.call(context.Background(), server)
			require.NoError(t, err, "an unconfigured data class is a state the console renders, not a failure")
			require.NotNil(t, message)

			response := message.ProtoReflect()
			require.Equal(t, test.wantNotConfigured, assertConsoleStubIsHonest(t, response, name),
				"NOT_CONFIGURED field count changed")
			if generation := response.Descriptor().Fields().ByName("index_generation"); generation != nil {
				require.Equal(t, uint64(consoleStubGeneration), response.Get(generation).Uint(),
					"a stub must report the snapshot generation it authorized against")
			}
		})
	}
}

func TestConsoleMutationStubsRefuseInsteadOfReportingSuccess(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		call func(context.Context, *PaprikaServer) (proto.Message, error)
	}{
		"HoldRollout": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.HoldRollout(ctx, connect.NewRequest(
					&paprikav1.HoldRolloutRequest{Namespace: "tenant", Name: "checkout", Reason: "incident"},
				)))
			},
		},
		"ResumeRollout": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ResumeRollout(ctx, connect.NewRequest(
					&paprikav1.ResumeRolloutRequest{Namespace: "tenant", Name: "checkout"},
				)))
			},
		},
		"IgnoreDriftedField": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.IgnoreDriftedField(ctx, connect.NewRequest(
					&paprikav1.IgnoreDriftedFieldRequest{
						Namespace: "tenant", Name: "checkout", JsonPointers: []string{"/spec/replicas"},
					},
				)))
			},
		},
		"ApplyResourcePatch": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.ApplyResourcePatch(ctx, connect.NewRequest(
					&paprikav1.ApplyResourcePatchRequest{
						Namespace: "tenant", Name: "checkout", Patch: "{}", Confirm: true,
					},
				)))
			},
		},
		"SyncResources": {
			call: func(ctx context.Context, server *PaprikaServer) (proto.Message, error) {
				return consoleStubMessage(server.SyncResources(ctx, connect.NewRequest(
					&paprikav1.SyncResourcesRequest{Namespace: "tenant", Name: "checkout", Confirm: true},
				)))
			},
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := consoleStubServer(t)
			message, err := test.call(context.Background(), server)
			require.Equal(t, connect.CodeUnimplemented, connect.CodeOf(err),
				"a mutation that changed nothing must never be mistakable for one that succeeded")
			require.Nil(t, message, "a refused mutation must not carry a response body")
			require.ErrorContains(t, err, name, "the refusal must name the RPC that refused")
		})
	}
}

func TestGetPipelineRunReportsAbsenceRatherThanSynthesisingARun(t *testing.T) {
	t.Parallel()

	// GetPipelineRunResponse carries no DataState, so there is no honest
	// degraded shape for it: a synthesised summary would be indistinguishable
	// from a recorded run. NotFound, carrying the same sentence GetDataSources
	// reports for DATA_CLASS_PIPELINE_RUNS, is the only truthful answer.
	server := consoleStubServer(t)
	response, err := server.GetPipelineRun(context.Background(), connect.NewRequest(
		&paprikav1.GetPipelineRunRequest{Namespace: "tenant", Name: "run-1"},
	))
	require.Nil(t, response)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	require.ErrorContains(t, err, pipelineRunsUnavailableReason)
}

// assertConsoleStubIsHonest walks every populated field of a stub response and
// reports how many DataState fields it found.
//
// Range visits only populated fields, which is exactly the property under test:
// a numeric that is visited is a numeric the server chose to emit, and on this
// surface the only defensible non-zero one is index_generation. Everything else
// must be absent, so a client that ignores the states renders an obvious 0
// rather than a plausible lie.
func assertConsoleStubIsHonest(t *testing.T, message protoreflect.Message, path string) int {
	t.Helper()
	states := 0
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		name := path + "." + string(field.Name())
		require.Falsef(t, field.IsMap(), "%s: maps are not part of the console contract", name)
		if !field.IsList() {
			states += assertConsoleStubValue(t, field, value, name)
			return true
		}
		list := value.List()
		for i := 0; i < list.Len(); i++ {
			states += assertConsoleStubValue(t, field, list.Get(i), fmt.Sprintf("%s[%d]", name, i))
		}
		return true
	})
	return states
}

func assertConsoleStubValue(
	t *testing.T,
	field protoreflect.FieldDescriptor,
	value protoreflect.Value,
	path string,
) int {
	t.Helper()
	if field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind {
		return assertConsoleStubIsHonest(t, value.Message(), path)
	}
	if field.Kind() == protoreflect.EnumKind && field.Enum().FullName() == dataStateFullName {
		require.Equalf(t, protoreflect.EnumNumber(paprikav1.DataState_DATA_STATE_NOT_CONFIGURED), value.Enum(),
			"%s must report NOT_CONFIGURED while nothing is collecting", path)
		return 1
	}
	if _, numeric := consoleNumericKinds[field.Kind()]; numeric && field.Name() != "index_generation" {
		require.Zerof(t, value.Interface(),
			"%s must be zero: a client that ignores the state must see an obvious 0, never a plausible lie", path)
	}
	return 0
}

// consoleStubMessage adapts a handler result to the reflective walk. It returns
// the response body even alongside an error, so a handler that refuses and
// still hands back a body cannot pass the mutation table.
func consoleStubMessage[T any](response *connect.Response[T], err error) (proto.Message, error) {
	if response == nil {
		return nil, err
	}
	message, _ := any(response.Msg).(proto.Message)
	return message, err
}

// consoleStubServer builds a server over a one-application fleet snapshot, so
// every stub authorizes against a real generation rather than an empty index.
func consoleStubServer(t *testing.T) *PaprikaServer {
	t.Helper()
	snapshot := buildSystemStatusSnapshot(t, consoleStubGeneration, []fleet.ApplicationSummary{
		systemStatusApplication("tenant", "checkout", "payments", fleet.HealthHealthy, fleet.SyncStateSynced),
	})
	return NewPaprikaServer(nil, nil, WithFleetIndex(&systemStatusReader{snapshot: snapshot}))
}

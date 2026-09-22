package apiserver

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// Phase 0 of the console redesign lands the wire contract ahead of every
// collector behind it. These handlers therefore answer honestly rather than
// plausibly: each state-carrying field reports DATA_STATE_NOT_CONFIGURED, every
// numeric beside it stays zero, and no mutation reports success it did not
// perform. See docs/superpowers/specs/console-redesign/01-backend-design.md §4.

// detailDataSource pairs a DataClass with the canonical sentence the console
// shows while nothing is collecting for that class. The sentences live in
// console_stub.go, not here, because the RPC that serves each class reports the
// same string in its own unavailable_reason — GetDataSources is the probe that
// decides whether a board is drawn at all, so it must not describe an absence
// differently from the board it gates.
type detailDataSource struct {
	class  paprikav1.DataClass
	reason string
}

// detailDataSources is the fixed table GetDataSources answers from: exactly one
// entry per DataClass member, in enum order, always. This mirrors the fixed
// seven-health / four-sync bucket convention in system_status_handler.go, which
// likewise emits the UNSPECIFIED member so the response length is an invariant
// the console and its tests can rely on.
var detailDataSources = [...]detailDataSource{
	{paprikav1.DataClass_DATA_CLASS_UNSPECIFIED, dataClassUnspecifiedReason},
	{paprikav1.DataClass_DATA_CLASS_CLUSTER_INVENTORY, clusterInventoryUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY, clusterCapacityUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_APPLICATION_SIGNALS, applicationSignalsUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_COST, costUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_SOURCE_EVENTS, sourceEventsUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_ROLLOUT_HISTORY, rolloutHistoryUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_PIPELINE_RUNS, pipelineRunsUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_COMMIT_METADATA, commitMetadataUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_OWNERSHIP, ownershipUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_DRIFT_DETAIL, driftDetailUnavailableReason},
	{paprikav1.DataClass_DATA_CLASS_LIFECYCLE, lifecycleUnavailableReason},
}

// detailLifecyclePhases is the fixed six-phase vector every lifecycle response
// carries, in LifecyclePhase order 1..6. The vector is positional on the wire,
// so it is declared once here rather than rebuilt per call site.
var detailLifecyclePhases = [...]paprikav1.LifecyclePhase{
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_SOURCE,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_BUILD,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_TEST,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_RENDER,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_DEPLOY,
	paprikav1.LifecyclePhase_LIFECYCLE_PHASE_VERIFY,
}

// GetDataSources reports one status per DataClass so the console can decide at
// boot which boards exist at all, instead of probing every RPC and inferring
// capability from empty results.
func (s *PaprikaServer) GetDataSources(
	ctx context.Context,
	req *connect.Request[paprikav1.GetDataSourcesRequest],
) (*connect.Response[paprikav1.GetDataSourcesResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	// The probe is authorized like any other tenant-scoped read: which sources an
	// install has configured is itself information a caller must be allowed to see.
	generation, err := s.authorizeOptionalNamespaceScope(ctx, req.Msg.Namespace)
	if err != nil {
		return nil, err
	}

	response := &paprikav1.GetDataSourcesResponse{
		Sources:         make([]*paprikav1.DataSourceStatus, 0, len(detailDataSources)),
		IndexGeneration: generation,
	}
	for _, source := range detailDataSources {
		// Capacity is the one class with a collector behind it, so it reports
		// what a real read produced rather than the stub's fixed answer. For
		// every other class, provider, observation time, staleness budget and
		// retention stay zero: nothing is collecting, so each would be a claim.
		if source.class == paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY {
			response.Sources = append(response.Sources, s.capacityDataSourceStatus(ctx, req.Msg.Namespace, source.reason))
			continue
		}
		response.Sources = append(response.Sources, &paprikav1.DataSourceStatus{
			DataClass:         source.class,
			State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			UnavailableReason: source.reason,
		})
	}
	return connect.NewResponse(response), nil
}

// GetRevisionInfo answers with an explicitly unconfigured commit rather than a
// fabricated or partially guessed one. No revision collector exists yet, so
// every identity field stays empty and run_number stays zero.
func (s *PaprikaServer) GetRevisionInfo(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRevisionInfoRequest],
) (*connect.Response[paprikav1.GetRevisionInfoResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Application, "application"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetRevisionInfoResponse{
		Commit:         &paprikav1.CommitInfo{State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED},
		RunNumberState: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
	}), nil
}

// GetApplicationOwnership reports that no ownership metadata is configured.
// Ownership carries no unavailable_reason field of its own; the actionable
// sentence for DATA_CLASS_OWNERSHIP is served by GetDataSources.
func (s *PaprikaServer) GetApplicationOwnership(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationOwnershipRequest],
) (*connect.Response[paprikav1.GetApplicationOwnershipResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetApplicationOwnershipResponse{
		Ownership: &paprikav1.Ownership{State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED},
	}), nil
}

// ListDriftDetails returns an empty page rather than an error: an unconfigured
// data class is a normal state the console renders, not a failure. The zero
// counts are safe to read only alongside state, which is why state leads the
// message.
func (s *PaprikaServer) ListDriftDetails(
	ctx context.Context,
	req *connect.Request[paprikav1.ListDriftDetailsRequest],
) (*connect.Response[paprikav1.ListDriftDetailsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	// Enforce the page bound from day one so the console learns the real limit
	// against the stub instead of discovering it when collection lands.
	if req.Msg.PageSize > maxFleetPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Application, "application"); err != nil {
		return nil, err
	}
	// An empty next_cursor is the completeness marker for "no further pages", and
	// evaluated_at stays zero because no evaluation happened.
	return connect.NewResponse(&paprikav1.ListDriftDetailsResponse{
		State:     paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Resources: []*paprikav1.ResourceDriftDetail{},
	}), nil
}

// GetApplicationLifecycle returns the full six-phase vector with every phase
// UNKNOWN. UNKNOWN, not NOT_APPLICABLE: the control plane does not yet know
// which stages an application has, and claiming a stage is absent would be as
// wrong as claiming it failed.
func (s *PaprikaServer) GetApplicationLifecycle(
	ctx context.Context,
	req *connect.Request[paprikav1.GetApplicationLifecycleRequest],
) (*connect.Response[paprikav1.GetApplicationLifecycleResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetApplicationLifecycleResponse{
		Lifecycle: detailUnknownLifecycle(req.Msg.Namespace, req.Msg.Name),
	}), nil
}

// GetRolloutHold reports the absence of a hold. That is literally true while
// holds are unimplemented, and the console still gates the Hold and Resume
// affordances on FLEET_CAPABILITY_ROLLOUT_HOLD rather than on this response.
func (s *PaprikaServer) GetRolloutHold(
	ctx context.Context,
	req *connect.Request[paprikav1.GetRolloutHoldRequest],
) (*connect.Response[paprikav1.GetRolloutHoldResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.GetRolloutHoldResponse{
		Hold: &paprikav1.RolloutHold{},
	}), nil
}

// HoldRollout refuses instead of reporting a hold it did not place.
func (s *PaprikaServer) HoldRollout(
	_ context.Context,
	_ *connect.Request[paprikav1.HoldRolloutRequest],
) (*connect.Response[paprikav1.HoldRolloutResponse], error) {
	return nil, detailNotImplemented("HoldRollout")
}

// ResumeRollout refuses instead of reporting a resume it did not perform.
func (s *PaprikaServer) ResumeRollout(
	_ context.Context,
	_ *connect.Request[paprikav1.ResumeRolloutRequest],
) (*connect.Response[paprikav1.ResumeRolloutResponse], error) {
	return nil, detailNotImplemented("ResumeRollout")
}

// IgnoreDriftedField refuses instead of returning rules it did not persist. A
// silently dropped ignore rule would leave drift showing forever with no
// indication the request was lost.
func (s *PaprikaServer) IgnoreDriftedField(
	_ context.Context,
	_ *connect.Request[paprikav1.IgnoreDriftedFieldRequest],
) (*connect.Response[paprikav1.IgnoreDriftedFieldResponse], error) {
	return nil, detailNotImplemented("IgnoreDriftedField")
}

// ApplyResourcePatch refuses outright. Returning dry_run=true with an empty
// diff would read as "nothing would change", which is the most dangerous
// possible lie for a write that bypasses Git.
func (s *PaprikaServer) ApplyResourcePatch(
	_ context.Context,
	_ *connect.Request[paprikav1.ApplyResourcePatchRequest],
) (*connect.Response[paprikav1.ApplyResourcePatchResponse], error) {
	return nil, detailNotImplemented("ApplyResourcePatch")
}

// SyncResources refuses instead of returning accepted=false with a zero
// selected_count, which a caller could not distinguish from "your selector
// matched nothing".
func (s *PaprikaServer) SyncResources(
	_ context.Context,
	_ *connect.Request[paprikav1.SyncResourcesRequest],
) (*connect.Response[paprikav1.SyncResourcesResponse], error) {
	return nil, detailNotImplemented("SyncResources")
}

// detailUnknownLifecycle builds the six-entry lifecycle vector with every phase
// UNKNOWN and every timestamp zero. The entry count and order are contractual,
// so callers can index by LifecyclePhase without a lookup.
func detailUnknownLifecycle(namespace, name string) *paprikav1.ApplicationLifecycle {
	phases := make([]*paprikav1.LifecyclePhaseStatus, 0, len(detailLifecyclePhases))
	for _, phase := range detailLifecyclePhases {
		phases = append(phases, &paprikav1.LifecyclePhaseStatus{
			Phase: phase,
			State: paprikav1.LifecyclePhaseState_LIFECYCLE_PHASE_STATE_UNKNOWN,
		})
	}
	return &paprikav1.ApplicationLifecycle{
		Application: &paprikav1.FleetObjectKey{Namespace: namespace, Name: name},
		Phases:      phases,
	}
}

// detailNotImplemented refuses a mutation this control plane cannot perform yet.
// CodeUnimplemented plus an explicit "no change was made" is the contract: a
// stub must never be mistakable for a completed action.
func detailNotImplemented(rpc string) error {
	return connect.NewError(connect.CodeUnimplemented, fmt.Errorf(
		"%s is not implemented on this control plane; no change was made", rpc,
	))
}

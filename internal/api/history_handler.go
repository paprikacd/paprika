package apiserver

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// Phase 0 history stubs — the source-event feed (design section 2.5), rollout
// history (2.6) and pipeline run history (2.7).
//
// All three feeds read record CRDs that no controller writes yet. Until a
// recorder exists every feed answers with DATA_STATE_NOT_CONFIGURED, an empty
// page and zeroed completeness markers, per the degraded-mode contract in
// design section 4: a client that ignores the state renders an empty board
// rather than a fabricated one, and no caller has to infer capability from an
// error code.
//
// None of the three list responses carries an unavailable_reason field, so the
// human-readable reason for the source-event and rollout-history feeds is
// reported once, by GetDataSources, against DATA_CLASS_SOURCE_EVENTS and
// DATA_CLASS_ROLLOUT_HISTORY. Only the single-record lookup below needs a
// reason of its own, and it uses the same canonical sentence GetDataSources
// reports for DATA_CLASS_PIPELINE_RUNS (console_stub.go).
//
// All four authorize before answering, exactly as the cluster, cost and detail
// stubs do. None of them can return data yet, so the scope narrows nothing
// today; the point is that the prologue is already in place when a recorder
// lands behind it, rather than being the step someone must remember to add.

// ListSourceEvents serves the recent source-trigger feed.
//
// Stub: validates the request exactly as the real feed will, then reports the
// feed as unconfigured with an empty page.
func (s *PaprikaServer) ListSourceEvents(
	ctx context.Context,
	req *connect.Request[paprikav1.ListSourceEventsRequest],
) (*connect.Response[paprikav1.ListSourceEventsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := validateHistoryWindow(req.Msg.PageSize, req.Msg.SinceUnixMs); err != nil {
		return nil, err
	}
	if _, err := fleetObjectKeysFromProto(req.Msg.Applications, "application"); err != nil {
		return nil, err
	}
	if err := validateSourceEventKinds(req.Msg.Kinds); err != nil {
		return nil, err
	}
	// None of the three list responses carries an index_generation, so the
	// authorized scope is discarded; the call is made regardless because a stub
	// must never be more permissive than the feed it stands in for.
	if _, err := s.authorizeOptionalNamespaceScope(ctx, req.Msg.Namespace); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.ListSourceEventsResponse{
		State:  paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Events: []*paprikav1.SourceEvent{},
		// Nothing is retained, so there is no horizon, no limit and no next page.
		NextCursor:             "",
		RetentionHorizonUnixMs: 0,
		RetentionLimit:         0,
	}), nil
}

// ListRolloutHistory serves completed rollout records and their aggregate.
//
// Stub: reports the feed as unconfigured, with a zeroed aggregate whose
// sample_size and window_start_unix_ms are also zero so the numbers cannot be
// read as fleet-lifetime statistics.
func (s *PaprikaServer) ListRolloutHistory(
	ctx context.Context,
	req *connect.Request[paprikav1.ListRolloutHistoryRequest],
) (*connect.Response[paprikav1.ListRolloutHistoryResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := validateHistoryWindow(req.Msg.PageSize, req.Msg.SinceUnixMs); err != nil {
		return nil, err
	}
	if err := validateRolloutHistoryFilters(req.Msg); err != nil {
		return nil, err
	}
	// None of the three list responses carries an index_generation, so the
	// authorized scope is discarded; the call is made regardless because a stub
	// must never be more permissive than the feed it stands in for.
	if _, err := s.authorizeOptionalNamespaceScope(ctx, req.Msg.Namespace); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.ListRolloutHistoryResponse{
		State:   paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Entries: []*paprikav1.RolloutHistoryEntry{},
		Stats: &paprikav1.RolloutHistoryStats{
			State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		},
		NextCursor:             "",
		RetentionHorizonUnixMs: 0,
		RetentionLimit:         0,
	}), nil
}

// ListPipelineRuns serves completed pipeline run summaries.
//
// Stub: reports the feed as unconfigured with an empty page.
func (s *PaprikaServer) ListPipelineRuns(
	ctx context.Context,
	req *connect.Request[paprikav1.ListPipelineRunsRequest],
) (*connect.Response[paprikav1.ListPipelineRunsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := validateHistoryWindow(req.Msg.PageSize, req.Msg.SinceUnixMs); err != nil {
		return nil, err
	}
	if err := validateOptionalHistoryKey(req.Msg.Pipeline, "pipeline"); err != nil {
		return nil, err
	}
	if err := validateOptionalHistoryKey(req.Msg.Application, "application"); err != nil {
		return nil, err
	}
	// None of the three list responses carries an index_generation, so the
	// authorized scope is discarded; the call is made regardless because a stub
	// must never be more permissive than the feed it stands in for.
	if _, err := s.authorizeOptionalNamespaceScope(ctx, req.Msg.Namespace); err != nil {
		return nil, err
	}
	return connect.NewResponse(&paprikav1.ListPipelineRunsResponse{
		State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		Runs:  []*paprikav1.PipelineRunSummary{},
		// Nothing is retained, so there is no horizon, no limit and no next page.
		NextCursor:             "",
		RetentionHorizonUnixMs: 0,
		RetentionLimit:         0,
	}), nil
}

// GetPipelineRun returns one recorded pipeline run.
//
// Stub: GetPipelineRunResponse has no state field, and a synthesised summary
// would be indistinguishable from a real run, so the absence is reported as
// NotFound with a reason that names the missing capability instead.
func (s *PaprikaServer) GetPipelineRun(
	ctx context.Context,
	req *connect.Request[paprikav1.GetPipelineRunRequest],
) (*connect.Response[paprikav1.GetPipelineRunResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := s.beginObjectScopedStub(ctx, req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}
	return nil, connect.NewError(connect.CodeNotFound, errors.New(pipelineRunsUnavailableReason))
}

// validateHistoryWindow applies the paging and window rules shared by every
// history feed. The optional namespace filter is validated by
// authorizeOptionalNamespaceScope instead, so it cannot be validated in one
// feed and forgotten in another.
func validateHistoryWindow(pageSize uint32, sinceUnixMs int64) error {
	if pageSize > maxFleetPageSize {
		return fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	if sinceUnixMs < 0 {
		return fleetInvalidArgument("since_unix_ms must not be negative")
	}
	return nil
}

// validateOptionalHistoryKey validates a singular, optional object key filter.
func validateOptionalHistoryKey(key *paprikav1.FleetObjectKey, field string) error {
	if key == nil {
		return nil
	}
	_, err := fleetObjectKeysFromProto([]*paprikav1.FleetObjectKey{key}, field)
	return err
}

func validateRolloutHistoryFilters(msg *paprikav1.ListRolloutHistoryRequest) error {
	if _, err := fleetObjectKeysFromProto(msg.Applications, "application"); err != nil {
		return err
	}
	if _, err := fleetObjectKeysFromProto(msg.Clusters, "cluster"); err != nil {
		return err
	}
	return validateFleetStrings(msg.Stages, "stage")
}

func validateSourceEventKinds(kinds []paprikav1.SourceEventKind) error {
	for _, kind := range kinds {
		if !validSourceEventKind(kind) {
			return fleetInvalidArgument("filter kinds has invalid value %d", kind)
		}
	}
	return nil
}

func validSourceEventKind(kind paprikav1.SourceEventKind) bool {
	switch kind {
	case paprikav1.SourceEventKind_SOURCE_EVENT_KIND_GIT_PUSH,
		paprikav1.SourceEventKind_SOURCE_EVENT_KIND_GIT_TAG,
		paprikav1.SourceEventKind_SOURCE_EVENT_KIND_OCI_PUSH,
		paprikav1.SourceEventKind_SOURCE_EVENT_KIND_S3_OBJECT,
		paprikav1.SourceEventKind_SOURCE_EVENT_KIND_POLL_DETECTED,
		paprikav1.SourceEventKind_SOURCE_EVENT_KIND_MANUAL_SYNC:
		return true
	case paprikav1.SourceEventKind_SOURCE_EVENT_KIND_UNSPECIFIED:
		return false
	default:
		return false
	}
}

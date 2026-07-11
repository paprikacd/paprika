package apiserver

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

const (
	defaultFleetPageSize = 100
	maxFleetPageSize     = 500
	maxFleetSearchRunes  = 128
)

// QueryApplications validates the fleet application query contract. Data
// retrieval is intentionally deferred until the fleet index is implemented.
func (s *PaprikaServer) QueryApplications(
	_ context.Context,
	req *connect.Request[paprikav1.QueryApplicationsRequest],
) (*connect.Response[paprikav1.QueryApplicationsResponse], error) {
	if req.Msg.PageSize == 0 {
		req.Msg.PageSize = defaultFleetPageSize
	}
	if req.Msg.PageSize > maxFleetPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	if err := validateFleetSearch(req.Msg.Search); err != nil {
		return nil, err
	}
	if err := validateFleetFilter(req.Msg.Filter); err != nil {
		return nil, err
	}
	if !validFleetSortField(req.Msg.Sort) {
		return nil, fleetInvalidArgument("sort has invalid value %d", req.Msg.Sort)
	}
	if !validFleetSortDirection(req.Msg.Direction) {
		return nil, fleetInvalidArgument("direction has invalid value %d", req.Msg.Direction)
	}
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("fleet application queries are not implemented"))
}

// QueryFleetMap validates the fleet map query contract. Data retrieval is
// intentionally deferred until the fleet index is implemented.
func (s *PaprikaServer) QueryFleetMap(
	_ context.Context,
	req *connect.Request[paprikav1.QueryFleetMapRequest],
) (*connect.Response[paprikav1.QueryFleetMapResponse], error) {
	if err := validateFleetSearch(req.Msg.Search); err != nil {
		return nil, err
	}
	if err := validateFleetFilter(req.Msg.Filter); err != nil {
		return nil, err
	}
	if !validFleetGroupDimension(req.Msg.Group, true) {
		return nil, fleetInvalidArgument("group has invalid value %d", req.Msg.Group)
	}
	if !validFleetSizeMetric(req.Msg.SizeMetric) {
		return nil, fleetInvalidArgument("size_metric has invalid value %d", req.Msg.SizeMetric)
	}
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("fleet map queries are not implemented"))
}

// QueryFleetMatrix validates the fleet matrix query contract. Data retrieval
// is intentionally deferred until the fleet index is implemented.
func (s *PaprikaServer) QueryFleetMatrix(
	_ context.Context,
	req *connect.Request[paprikav1.QueryFleetMatrixRequest],
) (*connect.Response[paprikav1.QueryFleetMatrixResponse], error) {
	if err := validateFleetSearch(req.Msg.Search); err != nil {
		return nil, err
	}
	if err := validateFleetFilter(req.Msg.Filter); err != nil {
		return nil, err
	}
	if !validFleetGroupDimension(req.Msg.RowGroup, false) {
		return nil, fleetInvalidArgument("row_group must be a concrete fleet group dimension")
	}
	if !validFleetGroupDimension(req.Msg.ColumnGroup, false) {
		return nil, fleetInvalidArgument("column_group must be a concrete fleet group dimension")
	}
	if req.Msg.RowGroup == req.Msg.ColumnGroup {
		return nil, fleetInvalidArgument("row_group and column_group must differ")
	}
	if !validFleetSizeMetric(req.Msg.SizeMetric) {
		return nil, fleetInvalidArgument("size_metric has invalid value %d", req.Msg.SizeMetric)
	}
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("fleet matrix queries are not implemented"))
}

func validateFleetSearch(search string) error {
	if utf8.RuneCountInString(search) > maxFleetSearchRunes {
		return fleetInvalidArgument("search must not exceed %d Unicode characters", maxFleetSearchRunes)
	}
	return nil
}

func validateFleetFilter(filter *paprikav1.FleetFilter) error {
	if filter == nil {
		return nil
	}

	// Unspecified values are defaults only where the request contract says so.
	// In repeated filters they do not identify a bucket, so fail closed.
	if err := validateFleetHealthFilter(filter.Health); err != nil {
		return err
	}
	if err := validateFleetSyncFilter(filter.Sync); err != nil {
		return err
	}
	if err := validateFleetReleaseFilter(filter.ReleaseStates); err != nil {
		return err
	}
	if err := validateFleetRolloutFilter(filter.RolloutStates); err != nil {
		return err
	}
	return validateFleetSourceFilter(filter.SourceTypes)
}

func validateFleetHealthFilter(values []paprikav1.FleetHealth) error {
	for _, value := range values {
		if !validFleetHealth(value) {
			return fleetInvalidArgument("filter health has invalid value %d", value)
		}
	}
	return nil
}

func validateFleetSyncFilter(values []paprikav1.FleetSyncState) error {
	for _, value := range values {
		if !validFleetSyncState(value) {
			return fleetInvalidArgument("filter sync has invalid value %d", value)
		}
	}
	return nil
}

func validateFleetReleaseFilter(values []paprikav1.FleetReleaseState) error {
	for _, value := range values {
		if !validFleetReleaseState(value) {
			return fleetInvalidArgument("filter release_states has invalid value %d", value)
		}
	}
	return nil
}

func validateFleetRolloutFilter(values []paprikav1.FleetRolloutState) error {
	for _, value := range values {
		if !validFleetRolloutState(value) {
			return fleetInvalidArgument("filter rollout_states has invalid value %d", value)
		}
	}
	return nil
}

func validateFleetSourceFilter(values []paprikav1.FleetSourceType) error {
	for _, value := range values {
		if !validFleetSourceType(value) {
			return fleetInvalidArgument("filter source_types has invalid value %d", value)
		}
	}
	return nil
}

func validFleetHealth(value paprikav1.FleetHealth) bool {
	switch value {
	case paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED:
		return false
	case paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY,
		paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING,
		paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED,
		paprikav1.FleetHealth_FLEET_HEALTH_FAILED,
		paprikav1.FleetHealth_FLEET_HEALTH_UNKNOWN,
		paprikav1.FleetHealth_FLEET_HEALTH_MISSING:
		return true
	default:
		return false
	}
}

func validFleetSyncState(value paprikav1.FleetSyncState) bool {
	switch value {
	case paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNSPECIFIED:
		return false
	case paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED,
		paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC,
		paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNKNOWN:
		return true
	default:
		return false
	}
}

func validFleetReleaseState(value paprikav1.FleetReleaseState) bool {
	switch value {
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_UNSPECIFIED:
		return false
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PENDING,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PROMOTING,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_CANARYING,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_VERIFYING,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_COMPLETE,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_FAILED,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_ROLLED_BACK,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_SUPERSEDED,
		paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_AWAITING_APPROVAL:
		return true
	default:
		return false
	}
}

func validFleetRolloutState(value paprikav1.FleetRolloutState) bool {
	switch value {
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_UNSPECIFIED:
		return false
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PENDING,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PROGRESSING,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PAUSED,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_HEALTHY,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_DEGRADED,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_FAILED,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ROLLED_BACK,
		paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ABORTED:
		return true
	default:
		return false
	}
}

func validFleetSourceType(value paprikav1.FleetSourceType) bool {
	switch value {
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_UNSPECIFIED:
		return false
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT,
		paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_HELM,
		paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_KUSTOMIZE,
		paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_S3,
		paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_OCI,
		paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_INLINE:
		return true
	default:
		return false
	}
}

func validFleetSortField(value paprikav1.FleetSortField) bool {
	switch value {
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_UNSPECIFIED,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_NAME,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_PROJECT,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_CLUSTER,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_STAGE,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_HEALTH,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_SYNC,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_RELEASE,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_ROLLOUT,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_RESOURCE_COUNT,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_LAST_TRANSITION,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_IMPACT,
		paprikav1.FleetSortField_FLEET_SORT_FIELD_RELEVANCE:
		return true
	default:
		return false
	}
}

func validFleetSortDirection(value paprikav1.FleetSortDirection) bool {
	switch value {
	case paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_UNSPECIFIED,
		paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_ASC,
		paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_DESC:
		return true
	default:
		return false
	}
}

func validFleetGroupDimension(value paprikav1.FleetGroupDimension, allowUnspecified bool) bool {
	switch value {
	case paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_UNSPECIFIED:
		return allowUnspecified
	case paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT,
		paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER,
		paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_STAGE,
		paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_HEALTH:
		return true
	default:
		return false
	}
}

func validFleetSizeMetric(value paprikav1.FleetSizeMetric) bool {
	switch value {
	case paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_UNSPECIFIED,
		paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_RESOURCE_COUNT,
		paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_REQUEST_RATE:
		return true
	default:
		return false
	}
}

func fleetInvalidArgument(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

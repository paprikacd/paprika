package apiserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

const (
	defaultFleetPageSize = 100
	maxFleetPageSize     = 500
	maxFleetSearchRunes  = 128
)

// QueryApplications serves one authorized page from the immutable fleet index.
//
//nolint:cyclop // Keep the complete request validation contract visible at the RPC boundary.
func (s *PaprikaServer) QueryApplications(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryApplicationsRequest],
) (*connect.Response[paprikav1.QueryApplicationsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
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
	filter, err := fleetFilterFromProto(req.Msg.Filter)
	if err != nil {
		return nil, err
	}
	reader, err := s.requireFleetIndex()
	if err != nil {
		return nil, err
	}
	scope, err := buildFleetQueryScope(
		ctx, reader, s.authorizer, auth.PrincipalFromContext(ctx), filter.Namespaces,
	)
	if err != nil {
		return nil, mapFleetError(err)
	}
	page, err := reader.QueryApplications(ctx, scope, fleet.ApplicationQuery{
		Filter: filter, Search: req.Msg.Search,
		Sort:      fleetSortFieldFromProto(req.Msg.Sort, req.Msg.Search),
		Direction: fleetSortDirectionFromProto(req.Msg.Direction),
		PageSize:  req.Msg.PageSize,
	}, req.Msg.Cursor)
	if err != nil {
		return nil, mapFleetError(err)
	}
	return connect.NewResponse(fleetApplicationPageToProto(&page)), nil
}

// QueryFleetMap serves one authorized map aggregation.
//
//nolint:cyclop // Keep the complete request validation contract visible at the RPC boundary.
func (s *PaprikaServer) QueryFleetMap(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryFleetMapRequest],
) (*connect.Response[paprikav1.QueryFleetMapResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
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
	filter, err := fleetFilterFromProto(req.Msg.Filter)
	if err != nil {
		return nil, err
	}
	reader, err := s.requireFleetIndex()
	if err != nil {
		return nil, err
	}
	scope, err := buildFleetQueryScope(
		ctx, reader, s.authorizer, auth.PrincipalFromContext(ctx), filter.Namespaces,
	)
	if err != nil {
		return nil, mapFleetError(err)
	}
	result, err := reader.QueryMap(ctx, scope, fleet.FleetMapQuery{
		Filter: filter, Search: req.Msg.Search,
		Group:      fleetGroupDimensionFromProto(req.Msg.Group),
		SizeMetric: fleetSizeMetricFromProto(req.Msg.SizeMetric),
	})
	if err != nil {
		return nil, mapFleetError(err)
	}
	return connect.NewResponse(fleetMapToProto(&result)), nil
}

// QueryFleetMatrix serves one authorized sparse matrix aggregation.
//
//nolint:cyclop // Keep the complete request validation contract visible at the RPC boundary.
func (s *PaprikaServer) QueryFleetMatrix(
	ctx context.Context,
	req *connect.Request[paprikav1.QueryFleetMatrixRequest],
) (*connect.Response[paprikav1.QueryFleetMatrixResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
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
	filter, err := fleetFilterFromProto(req.Msg.Filter)
	if err != nil {
		return nil, err
	}
	reader, err := s.requireFleetIndex()
	if err != nil {
		return nil, err
	}
	scope, err := buildFleetQueryScope(
		ctx, reader, s.authorizer, auth.PrincipalFromContext(ctx), filter.Namespaces,
	)
	if err != nil {
		return nil, mapFleetError(err)
	}
	result, err := reader.QueryMatrix(ctx, scope, fleet.FleetMatrixQuery{
		Filter: filter, Search: req.Msg.Search,
		RowGroup:    fleetGroupDimensionFromProto(req.Msg.RowGroup),
		ColumnGroup: fleetGroupDimensionFromProto(req.Msg.ColumnGroup),
		SizeMetric:  fleetSizeMetricFromProto(req.Msg.SizeMetric),
	})
	if err != nil {
		return nil, mapFleetError(err)
	}
	return connect.NewResponse(fleetMatrixToProto(&result)), nil
}

func (s *PaprikaServer) requireFleetIndex() (fleet.Reader, error) {
	if s == nil || s.fleetIndex == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("fleet index is not configured"))
	}
	return s.fleetIndex, nil
}

func mapFleetError(err error) error {
	if err == nil {
		return nil
	}
	var unavailable *fleet.ErrUnavailable
	if errors.As(err, &unavailable) {
		return connect.NewError(connect.CodeUnavailable, errors.New(unavailable.Error()))
	}
	var invalidCursor *fleet.ErrInvalidCursor
	if errors.As(err, &invalidCursor) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid fleet cursor"))
	}
	var invalidSearch *fleet.InvalidSearchError
	if errors.As(err, &invalidSearch) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid fleet search"))
	}
	var invalidAxes *fleet.ErrInvalidMatrixAxes
	if errors.As(err, &invalidAxes) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid fleet matrix axes"))
	}
	if errors.Is(err, auth.ErrUnauthorized) {
		return connect.NewError(connect.CodePermissionDenied, errors.New("fleet query is not authorized"))
	}
	if errors.Is(err, context.Canceled) {
		return connect.NewError(connect.CodeCanceled, context.Canceled)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.NewError(connect.CodeDeadlineExceeded, context.DeadlineExceeded)
	}
	return connect.NewError(connect.CodeInternal, errors.New("fleet query failed"))
}

//nolint:cyclop // Each independent filter dimension must be validated and converted explicitly.
func fleetFilterFromProto(filter *paprikav1.FleetFilter) (fleet.ApplicationFilter, error) {
	if filter == nil {
		return fleet.ApplicationFilter{}, nil
	}
	projects, err := fleetObjectKeysFromProto(filter.Projects, "project")
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	clusters, err := fleetObjectKeysFromProto(filter.Clusters, "cluster")
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	err = validateFleetStrings(filter.Namespaces, "namespace")
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	err = validateFleetStrings(filter.Stages, "stage")
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	health, err := fleetHealthFilterFromProto(filter.Health)
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	syncStates, err := fleetSyncFilterFromProto(filter.Sync)
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	releases, err := fleetReleaseFilterFromProto(filter.ReleaseStates)
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	rollouts, err := fleetRolloutFilterFromProto(filter.RolloutStates)
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	sources, err := fleetSourceFilterFromProto(filter.SourceTypes)
	if err != nil {
		return fleet.ApplicationFilter{}, err
	}
	return fleet.ApplicationFilter{
		Projects: projects, Namespaces: append([]string(nil), filter.Namespaces...),
		Clusters: clusters, Stages: append([]string(nil), filter.Stages...),
		Health: health, Sync: syncStates, ReleaseStates: releases,
		RolloutStates: rollouts, SourceTypes: sources,
	}, nil
}

func fleetObjectKeysFromProto(values []*paprikav1.FleetObjectKey, field string) ([]types.NamespacedName, error) {
	result := make([]types.NamespacedName, 0, len(values))
	for _, value := range values {
		if value == nil || strings.TrimSpace(value.Namespace) == "" || strings.TrimSpace(value.Name) == "" {
			return nil, fleetInvalidArgument("filter %s keys require namespace and name", field)
		}
		result = append(result, types.NamespacedName{Namespace: value.Namespace, Name: value.Name})
	}
	return result, nil
}

func validateFleetStrings(values []string, field string) error {
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return fleetInvalidArgument("filter %s values must not be empty", field)
		}
	}
	return nil
}

func fleetHealthFilterFromProto(values []paprikav1.FleetHealth) ([]fleet.Health, error) {
	result := make([]fleet.Health, 0, len(values))
	for _, value := range values {
		mapped, ok := fleetHealthFromProto(value)
		if !ok || mapped == fleet.HealthUnspecified {
			return nil, fleetInvalidArgument("filter health has invalid value %d", value)
		}
		result = append(result, mapped)
	}
	return result, nil
}

func fleetHealthFromProto(value paprikav1.FleetHealth) (fleet.Health, bool) {
	switch value {
	case paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED:
		return fleet.HealthUnspecified, true
	case paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY:
		return fleet.HealthHealthy, true
	case paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING:
		return fleet.HealthProgressing, true
	case paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED:
		return fleet.HealthDegraded, true
	case paprikav1.FleetHealth_FLEET_HEALTH_FAILED:
		return fleet.HealthFailed, true
	case paprikav1.FleetHealth_FLEET_HEALTH_UNKNOWN:
		return fleet.HealthUnknown, true
	case paprikav1.FleetHealth_FLEET_HEALTH_MISSING:
		return fleet.HealthMissing, true
	default:
		return fleet.HealthUnspecified, false
	}
}

func fleetSyncFilterFromProto(values []paprikav1.FleetSyncState) ([]fleet.SyncState, error) {
	result := make([]fleet.SyncState, 0, len(values))
	for _, value := range values {
		mapped, ok := fleetSyncFromProto(value)
		if !ok || mapped == fleet.SyncStateUnspecified {
			return nil, fleetInvalidArgument("filter sync has invalid value %d", value)
		}
		result = append(result, mapped)
	}
	return result, nil
}

func fleetSyncFromProto(value paprikav1.FleetSyncState) (fleet.SyncState, bool) {
	switch value {
	case paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNSPECIFIED:
		return fleet.SyncStateUnspecified, true
	case paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED:
		return fleet.SyncStateSynced, true
	case paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC:
		return fleet.SyncStateOutOfSync, true
	case paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNKNOWN:
		return fleet.SyncStateUnknown, true
	default:
		return fleet.SyncStateUnspecified, false
	}
}

func fleetReleaseFilterFromProto(values []paprikav1.FleetReleaseState) ([]fleet.ReleaseState, error) {
	result := make([]fleet.ReleaseState, 0, len(values))
	for _, value := range values {
		mapped, ok := fleetReleaseFromProto(value)
		if !ok || mapped == fleet.ReleaseStateUnspecified {
			return nil, fleetInvalidArgument("filter release_states has invalid value %d", value)
		}
		result = append(result, mapped)
	}
	return result, nil
}

//nolint:cyclop // Exhaustive enum conversion intentionally rejects unknown wire values.
func fleetReleaseFromProto(value paprikav1.FleetReleaseState) (fleet.ReleaseState, bool) {
	switch value {
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_UNSPECIFIED:
		return fleet.ReleaseStateUnspecified, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PENDING:
		return fleet.ReleaseStatePending, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PROMOTING:
		return fleet.ReleaseStatePromoting, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_CANARYING:
		return fleet.ReleaseStateCanarying, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_VERIFYING:
		return fleet.ReleaseStateVerifying, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_COMPLETE:
		return fleet.ReleaseStateComplete, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_FAILED:
		return fleet.ReleaseStateFailed, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_ROLLED_BACK:
		return fleet.ReleaseStateRolledBack, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_SUPERSEDED:
		return fleet.ReleaseStateSuperseded, true
	case paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_AWAITING_APPROVAL:
		return fleet.ReleaseStateAwaitingApproval, true
	default:
		return fleet.ReleaseStateUnspecified, false
	}
}

func fleetRolloutFilterFromProto(values []paprikav1.FleetRolloutState) ([]fleet.RolloutState, error) {
	result := make([]fleet.RolloutState, 0, len(values))
	for _, value := range values {
		mapped, ok := fleetRolloutFromProto(value)
		if !ok || mapped == fleet.RolloutStateUnspecified {
			return nil, fleetInvalidArgument("filter rollout_states has invalid value %d", value)
		}
		result = append(result, mapped)
	}
	return result, nil
}

//nolint:cyclop // Exhaustive enum conversion intentionally rejects unknown wire values.
func fleetRolloutFromProto(value paprikav1.FleetRolloutState) (fleet.RolloutState, bool) {
	switch value {
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_UNSPECIFIED:
		return fleet.RolloutStateUnspecified, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PENDING:
		return fleet.RolloutStatePending, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PROGRESSING:
		return fleet.RolloutStateProgressing, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PAUSED:
		return fleet.RolloutStatePaused, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_HEALTHY:
		return fleet.RolloutStateHealthy, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_DEGRADED:
		return fleet.RolloutStateDegraded, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_FAILED:
		return fleet.RolloutStateFailed, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ROLLED_BACK:
		return fleet.RolloutStateRolledBack, true
	case paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ABORTED:
		return fleet.RolloutStateAborted, true
	default:
		return fleet.RolloutStateUnspecified, false
	}
}

func fleetSourceFilterFromProto(values []paprikav1.FleetSourceType) ([]fleet.SourceType, error) {
	result := make([]fleet.SourceType, 0, len(values))
	for _, value := range values {
		mapped, ok := fleetSourceFromProto(value)
		if !ok || mapped == fleet.SourceTypeUnspecified {
			return nil, fleetInvalidArgument("filter source_types has invalid value %d", value)
		}
		result = append(result, mapped)
	}
	return result, nil
}

func fleetSourceFromProto(value paprikav1.FleetSourceType) (fleet.SourceType, bool) {
	switch value {
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_UNSPECIFIED:
		return fleet.SourceTypeUnspecified, true
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT:
		return fleet.SourceTypeGit, true
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_HELM:
		return fleet.SourceTypeHelm, true
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_KUSTOMIZE:
		return fleet.SourceTypeKustomize, true
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_S3:
		return fleet.SourceTypeS3, true
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_OCI:
		return fleet.SourceTypeOCI, true
	case paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_INLINE:
		return fleet.SourceTypeInline, true
	default:
		return fleet.SourceTypeUnspecified, false
	}
}

//nolint:cyclop // Exhaustive enum conversion keeps API and index values decoupled.
func fleetSortFieldFromProto(value paprikav1.FleetSortField, search string) fleet.SortField {
	switch value {
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_UNSPECIFIED:
		if strings.TrimSpace(search) != "" {
			return fleet.SortFieldRelevance
		}
		return fleet.SortFieldName
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_NAME:
		return fleet.SortFieldName
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_PROJECT:
		return fleet.SortFieldProject
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_CLUSTER:
		return fleet.SortFieldCluster
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_STAGE:
		return fleet.SortFieldStage
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_HEALTH:
		return fleet.SortFieldHealth
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_SYNC:
		return fleet.SortFieldSync
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_RELEASE:
		return fleet.SortFieldRelease
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_ROLLOUT:
		return fleet.SortFieldRollout
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_RESOURCE_COUNT:
		return fleet.SortFieldResourceCount
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_LAST_TRANSITION:
		return fleet.SortFieldLastTransition
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_IMPACT:
		return fleet.SortFieldImpact
	case paprikav1.FleetSortField_FLEET_SORT_FIELD_RELEVANCE:
		return fleet.SortFieldRelevance
	default:
		return fleet.SortFieldUnspecified
	}
}

func fleetSortDirectionFromProto(value paprikav1.FleetSortDirection) fleet.SortDirection {
	switch value {
	case paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_UNSPECIFIED,
		paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_ASC:
		return fleet.SortDirectionAsc
	case paprikav1.FleetSortDirection_FLEET_SORT_DIRECTION_DESC:
		return fleet.SortDirectionDesc
	default:
		return fleet.SortDirectionUnspecified
	}
}

func fleetGroupDimensionFromProto(value paprikav1.FleetGroupDimension) fleet.GroupDimension {
	switch value {
	case paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_UNSPECIFIED,
		paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_PROJECT:
		return fleet.GroupDimensionProject
	case paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_CLUSTER:
		return fleet.GroupDimensionCluster
	case paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_STAGE:
		return fleet.GroupDimensionStage
	case paprikav1.FleetGroupDimension_FLEET_GROUP_DIMENSION_HEALTH:
		return fleet.GroupDimensionHealth
	default:
		return fleet.GroupDimensionUnspecified
	}
}

func fleetSizeMetricFromProto(value paprikav1.FleetSizeMetric) fleet.SizeMetric {
	switch value {
	case paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_UNSPECIFIED,
		paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_RESOURCE_COUNT:
		return fleet.SizeMetricResourceCount
	case paprikav1.FleetSizeMetric_FLEET_SIZE_METRIC_REQUEST_RATE:
		return fleet.SizeMetricRequestRate
	default:
		return fleet.SizeMetricUnspecified
	}
}

func fleetApplicationPageToProto(page *fleet.ApplicationPage) *paprikav1.QueryApplicationsResponse {
	response := &paprikav1.QueryApplicationsResponse{
		Applications: make([]*paprikav1.ApplicationSummary, 0, len(page.Applications)),
		Total:        page.Total, NextCursor: page.NextCursor, IndexGeneration: page.Generation,
		Facets: make([]*paprikav1.FleetFacetBucket, 0, len(page.Facets)),
	}
	for i := range page.Applications {
		response.Applications = append(response.Applications, fleetApplicationResultToProto(&page.Applications[i]))
	}
	for i := range page.Facets {
		response.Facets = append(response.Facets, fleetFacetToProto(&page.Facets[i]))
	}
	return response
}

func fleetApplicationResultToProto(result *fleet.ApplicationQueryResult) *paprikav1.ApplicationSummary {
	summary := &result.Summary
	converted := &paprikav1.ApplicationSummary{
		Identity:                     fleetObjectKeyToProto(summary.Identity),
		Project:                      fleetObjectKeyToProto(summary.Project),
		Targets:                      make([]*paprikav1.StageTargetSummary, 0, len(summary.Targets)),
		CurrentStage:                 summary.CurrentStage,
		CurrentCluster:               fleetObjectKeyToProto(summary.CurrentCluster),
		CurrentClusterLabel:          summary.CurrentClusterLabel,
		SourceType:                   fleetSourceToProto(summary.SourceType),
		SourceRevision:               summary.SourceRevision,
		Health:                       fleetHealthToProto(summary.Health),
		Sync:                         fleetSyncToProto(summary.Sync),
		DriftCount:                   summary.DriftCount,
		MissingResourceCount:         summary.MissingResourceCount,
		ReleaseState:                 fleetReleaseToProto(summary.ReleaseState),
		RolloutState:                 fleetRolloutToProto(summary.RolloutState),
		ResourceCount:                summary.ResourceCount,
		Repository:                   fleetObjectKeyToProto(summary.Repository),
		RepositoryConnection:         fleetConnectionToProto(summary.RepositoryConnection),
		EffectiveObservabilitySource: fleetObjectKeyToProto(summary.EffectiveObservabilitySource),
		ObservabilityConnection:      fleetConnectionToProto(summary.ObservabilityConnection),
		BlockedGateCount:             summary.BlockedGateCount,
		LastTransitionUnixMs:         summary.LastTransitionUnixMS,
		Capabilities:                 make([]paprikav1.FleetCapability, 0, len(result.Capabilities)),
	}
	for i := range summary.Targets {
		converted.Targets = append(converted.Targets, fleetTargetToProto(&summary.Targets[i]))
	}
	for _, capability := range result.Capabilities {
		converted.Capabilities = append(converted.Capabilities, fleetCapabilityToProto(capability))
	}
	return converted
}

func fleetTargetToProto(target *fleet.StageTargetSummary) *paprikav1.StageTargetSummary {
	return &paprikav1.StageTargetSummary{
		StableId: target.StableID, Stage: target.Stage, Ring: target.Ring,
		Cluster: fleetObjectKeyToProto(target.Cluster), ClusterLabel: target.ClusterLabel,
		Health:                 fleetHealthToProto(target.Health),
		ClusterConnection:      fleetConnectionToProto(target.ClusterConnection),
		UnmanagedInlineCluster: target.UnmanagedInlineCluster,
	}
}

func fleetFacetToProto(bucket *fleet.FacetBucket) *paprikav1.FleetFacetBucket {
	converted := &paprikav1.FleetFacetBucket{
		Dimension: fleetFacetDimensionToProto(bucket.Dimension),
		Label:     bucket.Label,
		Count:     bucket.Count,
	}
	if bucket.Object != (types.NamespacedName{}) {
		converted.Key = &paprikav1.FleetFacetBucket_Object{Object: fleetObjectKeyToProto(bucket.Object)}
	} else if bucket.Value != "" {
		converted.Key = &paprikav1.FleetFacetBucket_Value{Value: bucket.Value}
	}
	return converted
}

func fleetMapToProto(result *fleet.FleetMap) *paprikav1.QueryFleetMapResponse {
	response := &paprikav1.QueryFleetMapResponse{
		Roots:  make([]*paprikav1.FleetMapNode, 0, len(result.Roots)),
		Facets: make([]*paprikav1.FleetFacetBucket, 0, len(result.Facets)),
		Total:  result.Total, IndexGeneration: result.Generation,
	}
	for i := range result.Roots {
		response.Roots = append(response.Roots, fleetMapNodeToProto(&result.Roots[i]))
	}
	for i := range result.Facets {
		response.Facets = append(response.Facets, fleetFacetToProto(&result.Facets[i]))
	}
	return response
}

func fleetMapNodeToProto(node *fleet.FleetMapNode) *paprikav1.FleetMapNode {
	converted := &paprikav1.FleetMapNode{
		StableId: node.StableID, Kind: fleetMapNodeKindToProto(node.Kind), Label: node.Label,
		Application:      fleetObjectKeyToProto(node.Application),
		ApplicationCount: node.ApplicationCount, TargetCount: node.TargetCount,
		Health: fleetHealthBucketsToProto(node.Health), ResourceWeight: node.ResourceWeight,
		RequestRateWeight: node.RequestRateWeight, EffectiveWeight: node.EffectiveWeight,
		UsedResourceFallback: node.UsedResourceFallback,
		Children:             make([]*paprikav1.FleetMapNode, 0, len(node.Children)),
	}
	if node.GroupObject != (types.NamespacedName{}) {
		converted.GroupKey = &paprikav1.FleetMapNode_GroupObject{
			GroupObject: fleetObjectKeyToProto(node.GroupObject),
		}
	} else if node.GroupValue != "" {
		converted.GroupKey = &paprikav1.FleetMapNode_GroupValue{GroupValue: node.GroupValue}
	}
	for i := range node.Children {
		converted.Children = append(converted.Children, fleetMapNodeToProto(&node.Children[i]))
	}
	return converted
}

func fleetMatrixToProto(result *fleet.FleetMatrix) *paprikav1.QueryFleetMatrixResponse {
	response := &paprikav1.QueryFleetMatrixResponse{
		Rows:    make([]*paprikav1.FleetMatrixHeader, 0, len(result.Rows)),
		Columns: make([]*paprikav1.FleetMatrixHeader, 0, len(result.Columns)),
		Cells:   make([]*paprikav1.FleetMatrixCell, 0, len(result.Cells)),
		Facets:  make([]*paprikav1.FleetFacetBucket, 0, len(result.Facets)),
		Total:   result.Total, IndexGeneration: result.Generation,
	}
	for i := range result.Rows {
		response.Rows = append(response.Rows, fleetMatrixHeaderToProto(&result.Rows[i]))
	}
	for i := range result.Columns {
		response.Columns = append(response.Columns, fleetMatrixHeaderToProto(&result.Columns[i]))
	}
	for i := range result.Cells {
		response.Cells = append(response.Cells, fleetMatrixCellToProto(&result.Cells[i]))
	}
	for i := range result.Facets {
		response.Facets = append(response.Facets, fleetFacetToProto(&result.Facets[i]))
	}
	return response
}

func fleetMatrixHeaderToProto(header *fleet.FleetMatrixHeader) *paprikav1.FleetMatrixHeader {
	converted := &paprikav1.FleetMatrixHeader{StableId: header.StableID, Label: header.Label}
	if header.Object != (types.NamespacedName{}) {
		converted.Key = &paprikav1.FleetMatrixHeader_Object{Object: fleetObjectKeyToProto(header.Object)}
	} else if header.Value != "" {
		converted.Key = &paprikav1.FleetMatrixHeader_Value{Value: header.Value}
	}
	return converted
}

func fleetMatrixCellToProto(cell *fleet.FleetMatrixCell) *paprikav1.FleetMatrixCell {
	return &paprikav1.FleetMatrixCell{
		RowId: cell.RowID, ColumnId: cell.ColumnID,
		ApplicationCount: cell.ApplicationCount, TargetCount: cell.TargetCount,
		Health: fleetHealthBucketsToProto(cell.Health), ResourceWeight: cell.ResourceWeight,
		RequestRateWeight:    cell.RequestRateWeight,
		UsedResourceFallback: cell.UsedResourceFallback,
	}
}

func fleetHealthBucketsToProto(values []fleet.HealthBucket) []*paprikav1.FleetHealthBucket {
	result := make([]*paprikav1.FleetHealthBucket, 0, len(values))
	for i := range values {
		result = append(result, &paprikav1.FleetHealthBucket{
			Health: fleetHealthToProto(values[i].Health), Count: values[i].Count,
		})
	}
	return result
}

func fleetObjectKeyToProto(key types.NamespacedName) *paprikav1.FleetObjectKey {
	if key == (types.NamespacedName{}) {
		return nil
	}
	return &paprikav1.FleetObjectKey{Namespace: key.Namespace, Name: key.Name}
}

func fleetHealthToProto(value fleet.Health) paprikav1.FleetHealth {
	switch value {
	case fleet.HealthHealthy:
		return paprikav1.FleetHealth_FLEET_HEALTH_HEALTHY
	case fleet.HealthProgressing:
		return paprikav1.FleetHealth_FLEET_HEALTH_PROGRESSING
	case fleet.HealthDegraded:
		return paprikav1.FleetHealth_FLEET_HEALTH_DEGRADED
	case fleet.HealthFailed:
		return paprikav1.FleetHealth_FLEET_HEALTH_FAILED
	case fleet.HealthUnknown:
		return paprikav1.FleetHealth_FLEET_HEALTH_UNKNOWN
	case fleet.HealthMissing:
		return paprikav1.FleetHealth_FLEET_HEALTH_MISSING
	case fleet.HealthUnspecified:
		return paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED
	default:
		return paprikav1.FleetHealth_FLEET_HEALTH_UNSPECIFIED
	}
}

func fleetSyncToProto(value fleet.SyncState) paprikav1.FleetSyncState {
	switch value {
	case fleet.SyncStateSynced:
		return paprikav1.FleetSyncState_FLEET_SYNC_STATE_SYNCED
	case fleet.SyncStateOutOfSync:
		return paprikav1.FleetSyncState_FLEET_SYNC_STATE_OUT_OF_SYNC
	case fleet.SyncStateUnknown:
		return paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNKNOWN
	case fleet.SyncStateUnspecified:
		return paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNSPECIFIED
	default:
		return paprikav1.FleetSyncState_FLEET_SYNC_STATE_UNSPECIFIED
	}
}

func fleetSourceToProto(value fleet.SourceType) paprikav1.FleetSourceType {
	switch value {
	case fleet.SourceTypeGit:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_GIT
	case fleet.SourceTypeHelm:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_HELM
	case fleet.SourceTypeKustomize:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_KUSTOMIZE
	case fleet.SourceTypeS3:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_S3
	case fleet.SourceTypeOCI:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_OCI
	case fleet.SourceTypeInline:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_INLINE
	case fleet.SourceTypeUnspecified:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_UNSPECIFIED
	default:
		return paprikav1.FleetSourceType_FLEET_SOURCE_TYPE_UNSPECIFIED
	}
}

//nolint:cyclop // Exhaustive enum conversion keeps index and API values decoupled.
func fleetReleaseToProto(value fleet.ReleaseState) paprikav1.FleetReleaseState {
	switch value {
	case fleet.ReleaseStatePending:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PENDING
	case fleet.ReleaseStatePromoting:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_PROMOTING
	case fleet.ReleaseStateCanarying:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_CANARYING
	case fleet.ReleaseStateVerifying:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_VERIFYING
	case fleet.ReleaseStateComplete:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_COMPLETE
	case fleet.ReleaseStateFailed:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_FAILED
	case fleet.ReleaseStateRolledBack:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_ROLLED_BACK
	case fleet.ReleaseStateSuperseded:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_SUPERSEDED
	case fleet.ReleaseStateAwaitingApproval:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_AWAITING_APPROVAL
	case fleet.ReleaseStateUnspecified:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_UNSPECIFIED
	default:
		return paprikav1.FleetReleaseState_FLEET_RELEASE_STATE_UNSPECIFIED
	}
}

//nolint:cyclop // Exhaustive enum conversion keeps index and API values decoupled.
func fleetRolloutToProto(value fleet.RolloutState) paprikav1.FleetRolloutState {
	switch value {
	case fleet.RolloutStatePending:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PENDING
	case fleet.RolloutStateProgressing:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PROGRESSING
	case fleet.RolloutStatePaused:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_PAUSED
	case fleet.RolloutStateHealthy:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_HEALTHY
	case fleet.RolloutStateDegraded:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_DEGRADED
	case fleet.RolloutStateFailed:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_FAILED
	case fleet.RolloutStateRolledBack:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ROLLED_BACK
	case fleet.RolloutStateAborted:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_ABORTED
	case fleet.RolloutStateUnspecified:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_UNSPECIFIED
	default:
		return paprikav1.FleetRolloutState_FLEET_ROLLOUT_STATE_UNSPECIFIED
	}
}

func fleetConnectionToProto(value fleet.ConnectionState) paprikav1.FleetConnectionState {
	switch value {
	case fleet.ConnectionStateHealthy:
		return paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_HEALTHY
	case fleet.ConnectionStateUnhealthy:
		return paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_UNHEALTHY
	case fleet.ConnectionStateDisabled:
		return paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_DISABLED
	case fleet.ConnectionStateNotConfigured:
		return paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_NOT_CONFIGURED
	case fleet.ConnectionStateUnspecified:
		return paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_UNSPECIFIED
	default:
		return paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_UNSPECIFIED
	}
}

func fleetCapabilityToProto(value fleet.Capability) paprikav1.FleetCapability {
	switch value {
	case fleet.CapabilityApplicationSync:
		return paprikav1.FleetCapability_FLEET_CAPABILITY_APPLICATION_SYNC
	case fleet.CapabilityReleaseRollback:
		return paprikav1.FleetCapability_FLEET_CAPABILITY_RELEASE_ROLLBACK
	case fleet.CapabilityGateApprove:
		return paprikav1.FleetCapability_FLEET_CAPABILITY_GATE_APPROVE
	case fleet.CapabilityPipelineRetry:
		return paprikav1.FleetCapability_FLEET_CAPABILITY_PIPELINE_RETRY
	case fleet.CapabilityUnspecified:
		return paprikav1.FleetCapability_FLEET_CAPABILITY_UNSPECIFIED
	default:
		return paprikav1.FleetCapability_FLEET_CAPABILITY_UNSPECIFIED
	}
}

//nolint:cyclop // Exhaustive enum conversion keeps index and API values decoupled.
func fleetFacetDimensionToProto(value fleet.FacetDimension) paprikav1.FleetFacetDimension {
	switch value {
	case fleet.FacetDimensionProject:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_PROJECT
	case fleet.FacetDimensionNamespace:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_NAMESPACE
	case fleet.FacetDimensionCluster:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_CLUSTER
	case fleet.FacetDimensionStage:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_STAGE
	case fleet.FacetDimensionHealth:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_HEALTH
	case fleet.FacetDimensionSync:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_SYNC
	case fleet.FacetDimensionRelease:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_RELEASE
	case fleet.FacetDimensionRollout:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_ROLLOUT
	case fleet.FacetDimensionSourceType:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_SOURCE_TYPE
	case fleet.FacetDimensionUnspecified:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_UNSPECIFIED
	default:
		return paprikav1.FleetFacetDimension_FLEET_FACET_DIMENSION_UNSPECIFIED
	}
}

func fleetMapNodeKindToProto(value fleet.FleetMapNodeKind) paprikav1.FleetMapNodeKind {
	switch value {
	case fleet.FleetMapNodeKindGroup:
		return paprikav1.FleetMapNodeKind_FLEET_MAP_NODE_KIND_GROUP
	case fleet.FleetMapNodeKindApplication:
		return paprikav1.FleetMapNodeKind_FLEET_MAP_NODE_KIND_APPLICATION
	case fleet.FleetMapNodeKindUnspecified:
		return paprikav1.FleetMapNodeKind_FLEET_MAP_NODE_KIND_UNSPECIFIED
	default:
		return paprikav1.FleetMapNodeKind_FLEET_MAP_NODE_KIND_UNSPECIFIED
	}
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

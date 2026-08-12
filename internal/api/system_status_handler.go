package apiserver

import (
	"context"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

const maxSystemStatusAttentionLimit uint32 = 100

// GetSystemStatus aggregates one authorized view from one immutable snapshot.
func (s *PaprikaServer) GetSystemStatus(
	ctx context.Context,
	req *connect.Request[paprikav1.GetSystemStatusRequest],
) (*connect.Response[paprikav1.GetSystemStatusResponse], error) {
	namespaces, err := validateSystemStatusRequest(req)
	if err != nil {
		return nil, err
	}

	reader, err := s.requireFleetIndex()
	if err != nil {
		return nil, err
	}
	snapshot, err := reader.LoadSnapshot()
	if err != nil {
		return nil, mapFleetError(err)
	}
	if snapshot == nil {
		return nil, mapFleetError(&fleet.ErrUnavailable{Reason: "fleet snapshot is unavailable"})
	}

	scope, err := buildFleetQueryScopeFromProjects(
		ctx, s.authorizer, auth.PrincipalFromContext(ctx), snapshot.ProjectKeys(namespaces),
	)
	if err != nil {
		return nil, mapFleetError(err)
	}
	status, err := snapshot.QueryStatus(scope, fleet.StatusQuery{
		Filter: fleet.ApplicationFilter{Namespaces: namespaces}, AttentionLimit: req.Msg.AttentionLimit,
	})
	if err != nil {
		return nil, mapFleetError(err)
	}
	return connect.NewResponse(fleetSystemStatusToProto(&status)), nil
}

func validateSystemStatusRequest(
	req *connect.Request[paprikav1.GetSystemStatusRequest],
) ([]string, error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if req.Msg.AttentionLimit > maxSystemStatusAttentionLimit {
		return nil, fleetInvalidArgument("attention_limit must not exceed %d", maxSystemStatusAttentionLimit)
	}

	if req.Msg.Namespace == nil {
		return nil, nil
	}
	if problems := validation.IsDNS1123Label(req.Msg.GetNamespace()); len(problems) != 0 {
		return nil, fleetInvalidArgument("namespace must be a valid DNS-1123 label")
	}
	return []string{req.Msg.GetNamespace()}, nil
}

func fleetSystemStatusToProto(status *fleet.Status) *paprikav1.GetSystemStatusResponse {
	healthOrder := [...]fleet.Health{
		fleet.HealthUnspecified,
		fleet.HealthHealthy,
		fleet.HealthProgressing,
		fleet.HealthDegraded,
		fleet.HealthFailed,
		fleet.HealthUnknown,
		fleet.HealthMissing,
	}
	syncOrder := [...]fleet.SyncState{
		fleet.SyncStateUnspecified,
		fleet.SyncStateSynced,
		fleet.SyncStateOutOfSync,
		fleet.SyncStateUnknown,
	}
	response := &paprikav1.GetSystemStatusResponse{
		IndexGeneration:  status.Generation,
		Total:            status.Total,
		Health:           make([]*paprikav1.FleetHealthBucket, 0, len(healthOrder)),
		Sync:             make([]*paprikav1.FleetSyncBucket, 0, len(syncOrder)),
		AttentionTotal:   status.AttentionTotal,
		Attention:        make([]*paprikav1.ApplicationSummary, 0, len(status.Attention)),
		HasMoreAttention: status.HasMoreAttention,
	}
	for _, health := range healthOrder {
		response.Health = append(response.Health, &paprikav1.FleetHealthBucket{
			Health: fleetHealthToProto(health), Count: status.Health[health],
		})
	}
	for _, syncState := range syncOrder {
		response.Sync = append(response.Sync, &paprikav1.FleetSyncBucket{
			Sync: fleetSyncToProto(syncState), Count: status.Sync[syncState],
		})
	}
	for i := range status.Attention {
		response.Attention = append(response.Attention, fleetApplicationResultToProto(&status.Attention[i]))
	}
	return response
}

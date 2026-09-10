package apiserver

import (
	"context"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/dataprovider"
)

// Phase 0 stubs for the cluster surface (design 2.1) and the cluster half of
// the capacity surface (design 2.2). No cluster projection and no capacity
// collector are wired yet, so both RPCs answer with the degraded-mode contract
// of design 4: a well-formed response in which every state field reads
// DATA_STATE_NOT_CONFIGURED, every numeric beside it reads zero, and
// unavailable_reason is the canonical sentence for that data class, declared
// once in console_stub.go so this board and the GetDataSources probe that gates
// it cannot describe the same absence two different ways.

// ListClusters serves one authorized page of the cluster inventory.
//
// Stub: the page is empty. That is deliberate rather than an error — the
// degraded-mode contract forbids failing a list RPC merely because its data
// class is not configured, and the completeness markers say so unambiguously:
// zero total and no next cursor.
func (s *PaprikaServer) ListClusters(
	ctx context.Context,
	req *connect.Request[paprikav1.ListClustersRequest],
) (*connect.Response[paprikav1.ListClustersResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if req.Msg.PageSize > maxFleetPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	generation, err := s.authorizeOptionalNamespaceScope(ctx, req.Msg.Namespace)
	if err != nil {
		return nil, err
	}

	// The cursor is accepted and ignored on purpose: this stub never emits one,
	// so no caller can hold a cursor of ours. include_unreferenced is likewise
	// immaterial while the page is empty; its admin check belongs with the
	// projection that can actually reveal an unreferenced cluster.
	return connect.NewResponse(&paprikav1.ListClustersResponse{
		Clusters:        []*paprikav1.Cluster{},
		Total:           0,
		NextCursor:      "",
		IndexGeneration: generation,
	}), nil
}

// GetCluster serves one authorized cluster.
//
// Stub: the requested identity is echoed and every state-carrying field reads
// NOT_CONFIGURED with zeroed numerics, so the console can build the detail view
// against the final wire shape while rendering nothing this server cannot
// substantiate. The response asserts no health, capacity, cost or agent fact
// about the cluster; once the projection lands, an unknown name becomes a
// genuine NotFound rather than this shell.
func (s *PaprikaServer) GetCluster(
	ctx context.Context,
	req *connect.Request[paprikav1.GetClusterRequest],
) (*connect.Response[paprikav1.GetClusterResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if err := validateFleetObjectTarget(req.Msg.Namespace, req.Msg.Name, "name"); err != nil {
		return nil, err
	}

	generation, err := s.authorizeFleetSnapshotScope(ctx, []string{req.Msg.Namespace})
	if err != nil {
		return nil, err
	}

	// Capacity is no longer a stub: it is read from whichever providers are
	// bound to this cluster's scope and merged into one meter. Everything else
	// on the cluster still reports NOT_CONFIGURED, because nothing else is
	// collecting yet.
	cluster := notConfiguredCluster(req.Msg.Namespace, req.Msg.Name)
	cluster.Capacity = s.clusterCapacity(ctx, req.Msg.Namespace, req.Msg.Name)

	return connect.NewResponse(&paprikav1.GetClusterResponse{
		Cluster:         cluster,
		IndexGeneration: generation,
	}), nil
}

// notConfiguredCluster is the honest empty form of one cluster: the identity
// the caller asked for, every DataState NOT_CONFIGURED, every numeric zero, and
// every identity-ish scalar left empty because empty is unambiguous there
// (kubernetes_version, server, service_account, display_name). Mode, phase and
// connection stay UNSPECIFIED: nothing has been observed, and UNSPECIFIED is
// the wire's "unknown" — NOT_CONFIGURED on connection would claim a
// configuration fact this server has not established.
func notConfiguredCluster(namespace, name string) *paprikav1.Cluster {
	return &paprikav1.Cluster{
		Identity:   &paprikav1.FleetObjectKey{Namespace: namespace, Name: name},
		Mode:       paprikav1.ClusterMode_CLUSTER_MODE_UNSPECIFIED,
		Phase:      paprikav1.ClusterPhase_CLUSTER_PHASE_UNSPECIFIED,
		Connection: paprikav1.FleetConnectionState_FLEET_CONNECTION_STATE_UNSPECIFIED,
		Conditions: []*paprikav1.Condition{},
		Inventory: &paprikav1.ClusterInventory{
			State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			Regions:           []string{},
			Zones:             []string{},
			KubeletVersions:   []string{},
			UnavailableReason: clusterInventoryUnavailableReason,
		},
		Capacity: &paprikav1.ClusterCapacity{
			Cpu:    notConfiguredClusterMeter(paprikav1.ResourceUnit_RESOURCE_UNIT_MILLICORES),
			Memory: notConfiguredClusterMeter(paprikav1.ResourceUnit_RESOURCE_UNIT_BYTES),
			// Empty: no usage source is bound, so naming one would be a lie.
			UsageProvider: "",
		},
		// One cost shape for the whole API surface, so a cluster chip and the
		// cost board can never disagree about what "no cost" looks like.
		Cost: notConfiguredCostSummary(costUnavailableReason),
		// NOT_CONFIGURED is exact here: agent details exist only for
		// CLUSTER_MODE_AGENT, and no mode has been observed.
		Agent: &paprikav1.ClusterAgentInfo{
			State: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		},
	}
}

// notConfiguredClusterMeter reports every component of one meter as
// unavailable. The unit is contract metadata rather than a measurement, so it
// is safe to state while the numbers are not; used, requested, allocatable and
// capacity are all zero, so a client that ignores the states renders 0 next to
// a hidden meter — visibly a bug rather than a plausible lie.
//
// It is built through the same mapping a measured meter goes through, so the
// degraded shape cannot drift away from the served one: the rule that only OK
// and STALE carry a number is enforced in one place for both.
func notConfiguredClusterMeter(unit paprikav1.ResourceUnit) *paprikav1.ResourceMeter {
	notConfigured := dataprovider.Sample{
		State:  dataprovider.StateNotConfigured,
		Reason: clusterCapacityUnavailableReason,
	}

	meter := dataprovider.Meter{
		Used:        notConfigured,
		Requested:   notConfigured,
		Allocatable: notConfigured,
	}

	return capacityMeterMessage(unit, &meter)
}

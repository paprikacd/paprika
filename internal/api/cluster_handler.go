package apiserver

import (
	"context"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/dataprovider"
	"github.com/benebsworth/paprika/internal/fleet"
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
// A cluster is on the page when an application the caller is authorized to read
// deploys to it; include_unreferenced widens that to the whole registered
// inventory and is an admin read, because an inventory of clusters nobody the
// caller can see deploys to is a fact about the install, not about the caller's
// own workloads.
//
// Capacity is read only when include_capacity is set. It is the one class on
// this message that costs a round trip to another API server per cluster, so a
// board that only needs rows does not pay for meters it will not draw; a row
// served without it carries the same NOT_CONFIGURED meter the stub did.
func (s *PaprikaServer) ListClusters(
	ctx context.Context,
	req *connect.Request[paprikav1.ListClustersRequest],
) (*connect.Response[paprikav1.ListClustersResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	msg := req.Msg
	if msg.PageSize > maxFleetPageSize {
		return nil, fleetInvalidArgument("page_size must not exceed %d", maxFleetPageSize)
	}
	namespaces, err := optionalNamespaceScope(msg.Namespace)
	if err != nil {
		return nil, err
	}
	snapshot, scope, err := s.authorizedFleetSnapshot(ctx, namespaces)
	if err != nil {
		return nil, err
	}
	if err = s.authorizeUnreferencedClusters(ctx, msg.Namespace, msg.IncludeUnreferenced); err != nil {
		return nil, err
	}

	visible, references, err := s.listAuthorizedClusters(ctx, snapshot, scope, msg.Namespace, msg.IncludeUnreferenced)
	if err != nil {
		return nil, err
	}

	page, next := pageClusters(visible, msg.Cursor, clusterPageSize(msg.PageSize))
	clusters := clusterMessages(page, snapshot, references)
	if msg.IncludeCapacity {
		s.attachClusterCapacity(ctx, clusters)
	}

	return connect.NewResponse(&paprikav1.ListClustersResponse{
		Clusters: clusters,
		// Total counts the whole authorized inventory, not the page: a console
		// that shows "12 of 40" must not have to page to the end to learn 40.
		Total:           uint64(len(visible)),
		NextCursor:      next,
		IndexGeneration: snapshot.Generation,
	}), nil
}

// clusterPageSize applies the fleet-wide default to an unset page_size, so the
// clusters board pages the same way every other board does.
func clusterPageSize(requested uint32) uint32 {
	if requested == 0 {
		return defaultFleetPageSize
	}

	return requested
}

// GetCluster serves one authorized cluster.
//
// Capacity is read from whichever providers are bound to this cluster's scope
// and merged into one meter; the rest of the message is the same projection
// ListClusters serves, so the detail view and the board cannot describe one
// cluster two different ways.
//
// A name with no Cluster object behind it still answers with the degraded
// shell rather than NotFound. That is deliberately unchanged here: this RPC has
// never distinguished the two, and turning absence into an error is a contract
// change the console has to be ready for, not a side effect of the projection
// landing.
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

	snapshot, scope, err := s.authorizedFleetSnapshot(ctx, []string{req.Msg.Namespace})
	if err != nil {
		return nil, err
	}

	cluster := s.clusterDetail(ctx, snapshot, scope, req.Msg.Namespace, req.Msg.Name)
	cluster.Capacity = s.clusterCapacity(ctx, req.Msg.Namespace, req.Msg.Name)

	return connect.NewResponse(&paprikav1.GetClusterResponse{
		Cluster:         cluster,
		IndexGeneration: snapshot.Generation,
	}), nil
}

// clusterDetail projects one named cluster, falling back to the degraded shell
// when there is no Cluster object to project — an inventory this server cannot
// read is reported as an inventory it has nothing to say about.
func (s *PaprikaServer) clusterDetail(
	ctx context.Context,
	snapshot *fleet.Snapshot,
	scope fleet.QueryScope,
	namespace, name string,
) *paprikav1.Cluster {
	if s.client == nil {
		return notConfiguredCluster(namespace, name)
	}

	var cluster clustersv1alpha1.Cluster
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &cluster); err != nil {
		return notConfiguredCluster(namespace, name)
	}

	key := types.NamespacedName{Namespace: namespace, Name: name}
	references := authorizedClusterReferences(snapshot, scope)

	return clusterMessage(&cluster, snapshot.Clusters[key], references[key])
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

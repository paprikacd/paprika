package apiserver

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	providersv1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/dataprovider"
	"github.com/benebsworth/paprika/internal/fleet"
)

// The clusters board is the first list the console draws from a real
// projection rather than a stub. What these tests hold is what the stub used to
// guarantee for free: a row only ever carries what was actually observed, a
// caller only sees clusters its own applications reach, and the expensive half
// of a row — capacity, one round trip per cluster — is paid for only when asked
// for.

// clusterTestServer builds a server over an explicit fleet snapshot, so a test
// can decide which applications exist and which clusters they target.
func clusterTestServer(
	t *testing.T,
	applications []fleet.ApplicationSummary,
	sources []dataprovider.CapacitySource,
	objs ...client.Object,
) *PaprikaServer {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, providersv1alpha1.AddToScheme(scheme))
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()

	registry := dataprovider.NewRegistry()
	for _, source := range sources {
		require.NoError(t, registry.RegisterCapacity(source))
	}

	snapshot := buildSystemStatusSnapshot(t, consoleStubGeneration, applications)
	return NewPaprikaServer(cl, nil,
		WithFleetIndex(&systemStatusReader{snapshot: snapshot}),
		WithCapacityProviders(registry),
		WithControlPlaneNamespace(capacityControlPlaneNamespace),
	)
}

// clusterTargetedApplication is one authorized application deploying to one
// cluster, which is what puts that cluster on the board at all.
func clusterTargetedApplication(name, cluster string) fleet.ApplicationSummary {
	summary := systemStatusApplication("tenant", name, "payments", fleet.HealthHealthy, fleet.SyncStateSynced)
	summary.Targets = []fleet.StageTargetSummary{{
		StableID:     name + "-prod",
		Stage:        "prod",
		Cluster:      types.NamespacedName{Namespace: "tenant", Name: cluster},
		ClusterLabel: cluster,
	}}
	return summary
}

func registeredCluster(name string) *clustersv1alpha1.Cluster {
	return &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "tenant", Name: name},
		Spec: clustersv1alpha1.ClusterSpec{
			DisplayName: "Production " + name,
			Mode:        clustersv1alpha1.ClusterModeDirect,
			Server:      "https://" + name + ".example.test",
		},
		Status: clustersv1alpha1.ClusterStatus{
			Phase:   clustersv1alpha1.ClusterPhaseHealthy,
			Version: "v1.33.2",
		},
	}
}

func listTestClusters(
	t *testing.T,
	server *PaprikaServer,
	request *paprikav1.ListClustersRequest,
) *paprikav1.ListClustersResponse {
	t.Helper()
	response, err := server.ListClusters(context.Background(), connect.NewRequest(request))
	require.NoError(t, err)
	return response.Msg
}

func TestListClustersProjectsTheRegisteredCluster(t *testing.T) {
	t.Parallel()

	server := clusterTestServer(t,
		[]fleet.ApplicationSummary{clusterTargetedApplication("checkout", "eu-west-1")},
		nil,
		registeredCluster("eu-west-1"),
	)

	page := listTestClusters(t, server, &paprikav1.ListClustersRequest{})
	require.Len(t, page.Clusters, 1)
	require.Equal(t, uint64(1), page.Total)
	require.Empty(t, page.NextCursor)
	require.Equal(t, uint64(consoleStubGeneration), page.IndexGeneration)

	cluster := page.Clusters[0]
	require.Equal(t, "tenant", cluster.Identity.Namespace)
	require.Equal(t, "eu-west-1", cluster.Identity.Name)
	require.Equal(t, "Production eu-west-1", cluster.DisplayName)
	require.Equal(t, paprikav1.ClusterMode_CLUSTER_MODE_DIRECT, cluster.Mode)
	require.Equal(t, paprikav1.ClusterPhase_CLUSTER_PHASE_HEALTHY, cluster.Phase)
	require.Equal(t, "v1.33.2", cluster.KubernetesVersion)
	require.Equal(t, uint64(1), cluster.ApplicationCount)
	require.Equal(t, uint64(1), cluster.TargetCount)

	// Everything no collector produces still reports its absence rather than a
	// zero that reads as a measurement.
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, cluster.Inventory.State)
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, cluster.Capacity.Cpu.AllocatableState)
	require.Zero(t, cluster.Capacity.Cpu.Allocatable)
}

func TestListClustersHidesAClusterNoAuthorizedApplicationReaches(t *testing.T) {
	t.Parallel()

	// A cluster nothing the caller can read deploys to is inventory, not the
	// caller's fleet: showing it by default would leak the shape of the install
	// to every tenant.
	server := clusterTestServer(t,
		[]fleet.ApplicationSummary{clusterTargetedApplication("checkout", "eu-west-1")},
		nil,
		registeredCluster("eu-west-1"),
		registeredCluster("us-east-1"),
	)

	page := listTestClusters(t, server, &paprikav1.ListClustersRequest{})
	require.Len(t, page.Clusters, 1)
	require.Equal(t, "eu-west-1", page.Clusters[0].Identity.Name)

	widened := listTestClusters(t, server, &paprikav1.ListClustersRequest{IncludeUnreferenced: true})
	require.Len(t, widened.Clusters, 2)
	require.Equal(t, uint64(2), widened.Total)
	require.Zero(t, widened.Clusters[1].ApplicationCount,
		"an unreferenced cluster must not acquire a count it does not have")
}

func TestListClustersReadsCapacityOnlyWhenAskedFor(t *testing.T) {
	t.Parallel()

	// Capacity is a round trip to another API server per cluster. A board that
	// only needs rows must not pay for meters it will not draw.
	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := clusterTestServer(t,
		[]fleet.ApplicationSummary{clusterTargetedApplication("checkout", "eu-west-1")},
		[]dataprovider.CapacitySource{source},
		registeredCluster("eu-west-1"),
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural",
			providersv1alpha1.ScopeGlobal, ""),
	)

	page := listTestClusters(t, server, &paprikav1.ListClustersRequest{})
	require.Empty(t, source.recorded(), "no provider may be read for a row that asked for no capacity")
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		page.Clusters[0].Capacity.Cpu.AllocatableState)

	metered := listTestClusters(t, server, &paprikav1.ListClustersRequest{IncludeCapacity: true})
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, metered.Clusters[0].Capacity.Cpu.AllocatableState)
	require.InDelta(t, 6000, metered.Clusters[0].Capacity.Cpu.Allocatable, 0.001)

	recorded := source.recorded()
	require.Len(t, recorded, 1)
	require.Equal(t, "tenant/eu-west-1", recorded[0].ClusterKey,
		"a row's meter must be read from the cluster that row names")
}

func TestListClustersPagesFromAResumableCursor(t *testing.T) {
	t.Parallel()

	server := clusterTestServer(t,
		[]fleet.ApplicationSummary{
			clusterTargetedApplication("checkout", "eu-west-1"),
			clusterTargetedApplication("billing", "eu-west-2"),
			clusterTargetedApplication("search", "us-east-1"),
		},
		nil,
		registeredCluster("eu-west-1"),
		registeredCluster("eu-west-2"),
		registeredCluster("us-east-1"),
	)

	first := listTestClusters(t, server, &paprikav1.ListClustersRequest{PageSize: 2})
	require.Len(t, first.Clusters, 2)
	require.Equal(t, uint64(3), first.Total, "total counts the inventory, not the page")
	require.Equal(t, "tenant/eu-west-2", first.NextCursor)

	second := listTestClusters(t, server, &paprikav1.ListClustersRequest{PageSize: 2, Cursor: first.NextCursor})
	require.Len(t, second.Clusters, 1)
	require.Equal(t, "us-east-1", second.Clusters[0].Identity.Name)
	require.Empty(t, second.NextCursor, "the last page must not offer a cursor onto nothing")
	require.Equal(t, uint64(3), second.Total)
}

func TestListClustersResumesAcrossANamespaceBoundary(t *testing.T) {
	t.Parallel()

	// The cursor names a (namespace, name) pair and the page is sorted by that
	// pair. Comparing the joined "ns/name" strings instead would disagree with
	// the sort here — '-' sorts before '/', so "tenant-b/..." precedes
	// "tenant/..." as a string — and the seek would skip the rest of the fleet.
	neighbour := clusterTargetedApplication("checkout", "eu-west-1")
	distant := systemStatusApplication("tenant-b", "ledger", "payments", fleet.HealthHealthy, fleet.SyncStateSynced)
	distant.Targets = []fleet.StageTargetSummary{{
		StableID: "ledger-prod", Stage: "prod",
		Cluster:      types.NamespacedName{Namespace: "tenant-b", Name: "ap-south-1"},
		ClusterLabel: "ap-south-1",
	}}
	remote := registeredCluster("ap-south-1")
	remote.Namespace = "tenant-b"

	server := clusterTestServer(t,
		[]fleet.ApplicationSummary{neighbour, distant}, nil,
		registeredCluster("eu-west-1"), remote,
	)

	first := listTestClusters(t, server, &paprikav1.ListClustersRequest{PageSize: 1})
	require.Equal(t, "tenant/eu-west-1", first.NextCursor)

	second := listTestClusters(t, server, &paprikav1.ListClustersRequest{PageSize: 1, Cursor: first.NextCursor})
	require.Len(t, second.Clusters, 1, "the next namespace must not be seeked past")
	require.Equal(t, "tenant-b", second.Clusters[0].Identity.Namespace)
}

func TestListClustersRejectsAPageSizeAboveTheMaximum(t *testing.T) {
	t.Parallel()

	server := clusterTestServer(t, nil, nil)
	_, err := server.ListClusters(context.Background(), connect.NewRequest(
		&paprikav1.ListClustersRequest{PageSize: maxFleetPageSize + 1},
	))
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestGetClusterProjectsTheRegisteredClusterAlongsideItsMeter(t *testing.T) {
	t.Parallel()

	// The detail view and the board are one projection: a cluster must not be
	// described one way on a card and another way on its own page.
	server := clusterTestServer(t,
		[]fleet.ApplicationSummary{clusterTargetedApplication("checkout", "eu-west-1")},
		nil,
		registeredCluster("eu-west-1"),
	)

	cluster := getTestCluster(t, server)
	require.Equal(t, "Production eu-west-1", cluster.DisplayName)
	require.Equal(t, paprikav1.ClusterPhase_CLUSTER_PHASE_HEALTHY, cluster.Phase)
	require.Equal(t, uint64(1), cluster.ApplicationCount)
}

func TestGetClusterStillAnswersForAnUnregisteredName(t *testing.T) {
	t.Parallel()

	// Absence is not an error on this RPC: the degraded shell is what the
	// console is built to render, and turning it into NotFound is a contract
	// change rather than a side effect of the projection landing.
	server := clusterTestServer(t, nil, nil)
	cluster := getTestCluster(t, server)
	require.Equal(t, "eu-west-1", cluster.Identity.Name)
	require.Equal(t, paprikav1.ClusterPhase_CLUSTER_PHASE_UNSPECIFIED, cluster.Phase)
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, cluster.Inventory.State)
}

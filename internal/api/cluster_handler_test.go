package apiserver

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	providersv1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/dataprovider"
	"github.com/benebsworth/paprika/internal/fleet"
)

// Capacity is the first console data class served from real providers. What
// these tests hold is not that the numbers arrive, but that nothing arrives
// dressed as a number it is not: a non-OK state is always accompanied by a
// zero, a provider's own failure never reaches the caller as text, and a read
// scoped to one cluster is asked of that cluster and no other.

// stubCapacitySource is a CapacitySource whose reading is fixed by the test,
// and which records the requests it was asked to serve.
type stubCapacitySource struct {
	name    string
	reading dataprovider.CapacityReading
	err     error

	mu       sync.Mutex
	requests []dataprovider.ReadRequest
}

func (s *stubCapacitySource) Descriptor() dataprovider.Descriptor {
	return dataprovider.Descriptor{Name: s.name}
}

func (s *stubCapacitySource) ValidateConfig(_ json.RawMessage) error { return nil }

func (s *stubCapacitySource) Read(
	_ context.Context,
	req dataprovider.ReadRequest,
) (dataprovider.CapacityReading, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, req)
	if s.err != nil {
		return dataprovider.CapacityReading{}, s.err
	}
	return s.reading, nil
}

func (s *stubCapacitySource) recorded() []dataprovider.ReadRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]dataprovider.ReadRequest(nil), s.requests...)
}

// capacityControlPlaneNamespace is where the test control plane runs, and so
// the only namespace whose Global-scoped bindings are honoured.
const capacityControlPlaneNamespace = "paprika-system"

// capacityObservedAt is the fixed observation time the stub providers report,
// so a test can assert the meter carries the time it was measured at.
var capacityObservedAt = time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)

// structuralReading is what KubernetesCapacity produces: allocatable and
// requested measured, used explicitly not configured.
func structuralReading() dataprovider.CapacityReading {
	return dataprovider.CapacityReading{
		CPUMillicores: dataprovider.Meter{
			Used:        dataprovider.Sample{State: dataprovider.StateNotConfigured, Reason: "no usage source is bound"},
			Requested:   dataprovider.Sample{Value: 750, State: dataprovider.StateOK},
			Allocatable: dataprovider.Sample{Value: 6000, State: dataprovider.StateOK},
			ObservedAt:  capacityObservedAt,
		},
		MemoryBytes: dataprovider.Meter{
			Used:        dataprovider.Sample{State: dataprovider.StateNotConfigured, Reason: "no usage source is bound"},
			Requested:   dataprovider.Sample{Value: 2 << 30, State: dataprovider.StateOK},
			Allocatable: dataprovider.Sample{Value: 32 << 30, State: dataprovider.StateOK},
			ObservedAt:  capacityObservedAt,
		},
	}
}

// usageReading is what MetricsServer produces: used measured, nothing else.
func usageReading() dataprovider.CapacityReading {
	notConfigured := dataprovider.Sample{State: dataprovider.StateNotConfigured, Reason: "metrics-server reads only usage"}
	return dataprovider.CapacityReading{
		CPUMillicores: dataprovider.Meter{
			Used:        dataprovider.Sample{Value: 2000, State: dataprovider.StateOK},
			Requested:   notConfigured,
			Allocatable: notConfigured,
			ObservedAt:  capacityObservedAt,
		},
		MemoryBytes: dataprovider.Meter{
			Used:        dataprovider.Sample{Value: 8 << 30, State: dataprovider.StateOK},
			Requested:   notConfigured,
			Allocatable: notConfigured,
			ObservedAt:  capacityObservedAt,
		},
	}
}

func capacityProvider(namespace, name, registryKey string) *providersv1alpha1.CapacityProvider {
	return &providersv1alpha1.CapacityProvider{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec:       providersv1alpha1.CapacityProviderSpec{Provider: registryKey},
	}
}

func capacityBinding(
	namespace, name, providerName string,
	kind providersv1alpha1.ScopeKind,
	scopeName string,
) *providersv1alpha1.DataProviderBinding {
	return &providersv1alpha1.DataProviderBinding{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: providersv1alpha1.DataProviderBindingSpec{
			ProviderRef: providersv1alpha1.ProviderReference{Kind: "CapacityProvider", Name: providerName},
			Scope:       providersv1alpha1.BindingScope{Kind: kind, Name: scopeName},
		},
	}
}

// capacityTestServer builds a server whose fleet snapshot authorizes the
// "tenant" namespace, with sources registered and objs already applied.
func capacityTestServer(
	t *testing.T,
	sources []dataprovider.CapacitySource,
	objs ...client.Object,
) *PaprikaServer {
	t.Helper()

	return clusterTestServer(t, []fleet.ApplicationSummary{
		systemStatusApplication("tenant", "checkout", "payments", fleet.HealthHealthy, fleet.SyncStateSynced),
	}, sources, objs...)
}

func getTestCluster(t *testing.T, server *PaprikaServer) *paprikav1.Cluster {
	t.Helper()
	response, err := server.GetCluster(context.Background(), connect.NewRequest(
		&paprikav1.GetClusterRequest{Namespace: "tenant", Name: "eu-west-1"},
	))
	require.NoError(t, err)
	return response.Msg.Cluster
}

func TestCapacitySampleNeverCarriesANumberBesideANonOKState(t *testing.T) {
	t.Parallel()

	// The premise of the whole DataState contract: a client that renders the
	// number and ignores the state must see an obvious zero, never a plausible
	// figure the server has just disclaimed. STALE is the single carve-out —
	// there the number is a real measurement whose age the client is told.
	tests := map[string]struct {
		state     dataprovider.DataState
		wantState paprikav1.DataState
		wantValue float64
	}{
		"ok carries its measurement": {
			state: dataprovider.StateOK, wantState: paprikav1.DataState_DATA_STATE_OK, wantValue: 4200,
		},
		"stale carries its measurement": {
			state: dataprovider.StateStale, wantState: paprikav1.DataState_DATA_STATE_STALE, wantValue: 4200,
		},
		"error zeroes it": {
			state: dataprovider.StateError, wantState: paprikav1.DataState_DATA_STATE_ERROR, wantValue: 0,
		},
		"not configured zeroes it": {
			state:     dataprovider.StateNotConfigured,
			wantState: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
			wantValue: 0,
		},
		"not available zeroes it": {
			state:     dataprovider.StateNotAvailable,
			wantState: paprikav1.DataState_DATA_STATE_NOT_AVAILABLE,
			wantValue: 0,
		},
		"forbidden zeroes it": {
			state: dataprovider.StateForbidden, wantState: paprikav1.DataState_DATA_STATE_FORBIDDEN, wantValue: 0,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			state, value := capacitySampleMessage(dataprovider.Sample{Value: 4200, State: test.state})
			require.Equal(t, test.wantState, state)
			require.InDelta(t, test.wantValue, value, 0.001)
		})
	}
}

func TestGetClusterZeroesTheNumberBesideAFailedSample(t *testing.T) {
	t.Parallel()

	// The same rule, held at the wire rather than at the mapping, so a future
	// handler that builds a meter some other way cannot route around it.
	failed := dataprovider.Sample{Value: 4200, State: dataprovider.StateError, Reason: "the read failed"}
	source := &stubCapacitySource{
		name: "Faulty",
		reading: dataprovider.CapacityReading{
			CPUMillicores: dataprovider.Meter{
				Used: failed, Requested: failed, Allocatable: failed, ObservedAt: capacityObservedAt,
			},
		},
	}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityProvider(capacityControlPlaneNamespace, "faulty", "Faulty"),
		capacityBinding(capacityControlPlaneNamespace, "bind-faulty", "faulty", providersv1alpha1.ScopeGlobal, ""),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, cpu.UsedState)
	require.Zero(t, cpu.Used, "a disclaimed measurement must never reach the wire as a number")
	require.Zero(t, cpu.Requested)
	require.Zero(t, cpu.Allocatable)
	require.Zero(t, cpu.ObservedAtUnixMs, "nothing was observed, so no observation time")
	require.Equal(t, "the read failed", cpu.UnavailableReason)
}

func TestGetClusterMergesComplementaryProvidersIntoOneMeter(t *testing.T) {
	t.Parallel()

	structural := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	usage := &stubCapacitySource{name: "MetricsServer", reading: usageReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{structural, usage},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityProvider(capacityControlPlaneNamespace, "usage", "MetricsServer"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeCluster, "eu-west-1"),
		capacityBinding(capacityControlPlaneNamespace, "bind-usage", "usage", providersv1alpha1.ScopeGlobal, ""),
	)

	capacity := getTestCluster(t, server).Capacity
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, capacity.Cpu.AllocatableState)
	require.InDelta(t, 6000, capacity.Cpu.Allocatable, 0.001)
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, capacity.Cpu.RequestedState)
	require.InDelta(t, 750, capacity.Cpu.Requested, 0.001)
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, capacity.Cpu.UsedState,
		"one provider's used and another's allocatable are one meter")
	require.InDelta(t, 2000, capacity.Cpu.Used, 0.001)
	require.InDelta(t, 8<<30, capacity.Memory.Used, 0.001)
	require.Equal(t, capacityObservedAt.UnixMilli(), capacity.Cpu.ObservedAtUnixMs)
	require.Empty(t, capacity.Cpu.UnavailableReason, "a whole meter has nothing to explain")
	require.Equal(t, "MetricsServer", capacity.UsageProvider,
		"the usage provider is the one that actually supplied used")
}

func TestGetClusterKeepsMeasuredFieldsWhenAnotherProviderFails(t *testing.T) {
	t.Parallel()

	structural := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	usage := &stubCapacitySource{name: "MetricsServer", err: errCapacityStub}
	server := capacityTestServer(t, []dataprovider.CapacitySource{structural, usage},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityProvider(capacityControlPlaneNamespace, "usage", "MetricsServer"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeGlobal, ""),
		capacityBinding(capacityControlPlaneNamespace, "bind-usage", "usage", providersv1alpha1.ScopeGlobal, ""),
	)

	capacity := getTestCluster(t, server).Capacity
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, capacity.Cpu.AllocatableState,
		"one provider failing must not blank the fields another measured")
	require.InDelta(t, 6000, capacity.Cpu.Allocatable, 0.001)
	require.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, capacity.Cpu.UsedState)
	require.Zero(t, capacity.Cpu.Used)
	require.Empty(t, capacity.UsageProvider, "no provider supplied usage, so none is credited")
}

func TestGetClusterCapacityNeverEchoesAProviderError(t *testing.T) {
	t.Parallel()

	source := &stubCapacitySource{name: "Leaky", err: errCapacityLeak}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityProvider(capacityControlPlaneNamespace, "leaky", "Leaky"),
		capacityBinding(capacityControlPlaneNamespace, "bind-leaky", "leaky", providersv1alpha1.ScopeGlobal, ""),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, cpu.UsedState)
	require.Equal(t, capacityReadFailedReason, cpu.UnavailableReason)
	require.NotContains(t, cpu.UnavailableReason, "https://api.internal.example",
		"a reason reaches the console and the logs; a cluster host must never ride along")
}

func TestGetClusterAsksTheClusterTheRequestNamed(t *testing.T) {
	t.Parallel()

	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeGlobal, ""),
	)

	getTestCluster(t, server)

	recorded := source.recorded()
	require.Len(t, recorded, 1)
	require.Equal(t, "tenant/eu-west-1", recorded[0].ClusterKey,
		"per-cluster scoping is the point: the read must name the cluster asked about")
	require.Empty(t, recorded[0].Namespace, "a cluster's capacity is the whole cluster's, not one namespace's")
}

func TestGetClusterCapacityPrefersTheMostSpecificBinding(t *testing.T) {
	t.Parallel()

	// Two bindings for the same provider object: the cluster-scoped one wins,
	// which is visible here as the config the winning binding's provider
	// carries reaching Read.
	specific := &stubCapacitySource{name: "Specific", reading: structuralReading()}
	broad := &stubCapacitySource{name: "Broad", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{specific, broad},
		capacityProvider(capacityControlPlaneNamespace, "specific", "Specific"),
		capacityProvider(capacityControlPlaneNamespace, "broad", "Broad"),
		capacityBinding(capacityControlPlaneNamespace, "bind-a", "specific", providersv1alpha1.ScopeCluster, "eu-west-1"),
		capacityBinding(capacityControlPlaneNamespace, "bind-b", "specific", providersv1alpha1.ScopeGlobal, ""),
		capacityBinding(capacityControlPlaneNamespace, "bind-c", "broad", providersv1alpha1.ScopeNamespace, "other-tenant"),
	)

	getTestCluster(t, server)
	require.Len(t, specific.recorded(), 1, "one winner per provider, not one read per binding")
	require.Empty(t, broad.recorded(), "a binding scoped elsewhere must not be read here")
}

func TestGetClusterReportsNotConfiguredWhenNothingIsBound(t *testing.T) {
	t.Parallel()

	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, cpu.AllocatableState,
		"a registered provider nobody bound is not a configured provider")
	require.Zero(t, cpu.Allocatable)
	require.Equal(t, clusterCapacityUnavailableReason, cpu.UnavailableReason)
	require.Empty(t, source.recorded())
}

func TestGetClusterReportsNotAvailableWhenTheBoundProviderIsGone(t *testing.T) {
	t.Parallel()

	// The binding survived the CapacityProvider it points at. That is a
	// configuration fault an operator can fix, and it is emphatically not the
	// same as nothing being configured.
	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeGlobal, ""),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_AVAILABLE, cpu.AllocatableState)
	require.Equal(t, capacityProviderUnreadableReason, cpu.UnavailableReason)
}

func TestGetClusterReportsNotConfiguredWhenTheProviderKeyIsUnknown(t *testing.T) {
	t.Parallel()

	server := capacityTestServer(t, nil,
		capacityProvider(capacityControlPlaneNamespace, "exotic", "CloudBillingCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-exotic", "exotic", providersv1alpha1.ScopeGlobal, ""),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, cpu.AllocatableState)
	require.Equal(t, capacityProviderUnregisteredReason, cpu.UnavailableReason)
}

func TestGetClusterCapacityMatchesAProjectScopedBinding(t *testing.T) {
	t.Parallel()

	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		&clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{
			Namespace: "tenant", Name: "eu-west-1",
			Labels: map[string]string{projectLabelKey: "payments"},
		}},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeProject, "payments"),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, cpu.AllocatableState,
		"a cluster's project comes from its own label, so a project-scoped binding reaches it")
}

func TestGlobalBindingFromAForeignNamespaceIsIgnored(t *testing.T) {
	t.Parallel()

	// Bindings are read fleet-wide, so without this rule any tenant could
	// create a Global-scoped binding in its own namespace and repoint the
	// capacity source every other tenant sees. Nothing crosses the boundary
	// as data — the reading still lands in the asking tenant's response — but
	// one namespace could blank or misdirect the whole fleet's meters.
	intruder := &stubCapacitySource{name: "Intruder", reading: usageReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{intruder},
		capacityProvider("tenant", "intruder", "Intruder"),
		capacityBinding("tenant", "bind-intruder", "intruder", providersv1alpha1.ScopeGlobal, ""),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, cpu.UsedState,
		"the fleet falls back to what it would have resolved without the foreign binding")
	require.Equal(t, clusterCapacityUnavailableReason, cpu.UnavailableReason)
	require.Empty(t, intruder.recorded(), "an ineligible binding must not even be read")
}

func TestGlobalBindingFromAForeignNamespaceCannotDisplaceAPermittedOne(t *testing.T) {
	t.Parallel()

	// The dangerous shape is not the lone intruder but the one that outranks,
	// or merges ahead of, a binding an operator actually made.
	legitimate := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	intruder := &stubCapacitySource{name: "Intruder", reading: usageReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{legitimate, intruder},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural",
			providersv1alpha1.ScopeGlobal, ""),
		capacityProvider("tenant", "intruder", "Intruder"),
		capacityBinding("tenant", "bind-intruder", "intruder", providersv1alpha1.ScopeGlobal, ""),
	)

	capacity := getTestCluster(t, server).Capacity
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, capacity.Cpu.AllocatableState)
	require.InDelta(t, 6000, capacity.Cpu.Allocatable, 0.001)
	require.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, capacity.Cpu.UsedState,
		"the intruder's usage must not merge into the fleet's meter")
	require.Empty(t, capacity.UsageProvider)
	require.Len(t, legitimate.recorded(), 1)
	require.Empty(t, intruder.recorded())
}

func TestGlobalBindingInTheControlPlaneNamespaceAppliesFleetWide(t *testing.T) {
	t.Parallel()

	// The other half of the rule: a Global binding an operator made in the
	// control plane's own namespace reaches a cluster in a different one.
	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural",
			providersv1alpha1.ScopeGlobal, ""),
	)

	cpu := getTestCluster(t, server).Capacity.Cpu
	require.Equal(t, paprikav1.DataState_DATA_STATE_OK, cpu.AllocatableState)
	require.InDelta(t, 6000, cpu.Allocatable, 0.001)
}

func TestScopedBindingsAreUnaffectedByTheGlobalRule(t *testing.T) {
	t.Parallel()

	// Namespace, Cluster and Project scopes name what they affect, so a tenant
	// binding one from its own namespace is exactly what scoping is for and
	// must keep working wherever the binding lives.
	tests := map[string]struct {
		kind      providersv1alpha1.ScopeKind
		scopeName string
	}{
		"namespace": {kind: providersv1alpha1.ScopeNamespace, scopeName: "tenant"},
		"cluster":   {kind: providersv1alpha1.ScopeCluster, scopeName: "eu-west-1"},
		"project":   {kind: providersv1alpha1.ScopeProject, scopeName: "payments"},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
			server := capacityTestServer(t, []dataprovider.CapacitySource{source},
				&clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{
					Namespace: "tenant", Name: "eu-west-1",
					Labels: map[string]string{projectLabelKey: "payments"},
				}},
				capacityProvider("tenant", "structural", "KubernetesCapacity"),
				capacityBinding("tenant", "bind-structural", "structural", test.kind, test.scopeName),
			)

			cpu := getTestCluster(t, server).Capacity.Cpu
			require.Equal(t, paprikav1.DataState_DATA_STATE_OK, cpu.AllocatableState,
				"a scoped binding from a tenant namespace still applies")
			require.InDelta(t, 6000, cpu.Allocatable, 0.001)
		})
	}
}

func TestGetDataSourcesReportsCapacityFromTheResolvedProvider(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		source    dataprovider.CapacitySource
		bind      bool
		wantState paprikav1.DataState
		wantEmpty bool
	}{
		"a provider that resolves and reads is OK": {
			source:    &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()},
			bind:      true,
			wantState: paprikav1.DataState_DATA_STATE_OK,
			wantEmpty: true,
		},
		"a provider that fails reports its own state": {
			source:    &stubCapacitySource{name: "KubernetesCapacity", err: errCapacityStub},
			bind:      true,
			wantState: paprikav1.DataState_DATA_STATE_ERROR,
		},
		"nothing bound is not configured": {
			source:    &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()},
			wantState: paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			objs := []client.Object{capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity")}
			if test.bind {
				objs = append(objs,
					capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeGlobal, ""))
			}
			server := capacityTestServer(t, []dataprovider.CapacitySource{test.source}, objs...)

			response, err := server.GetDataSources(context.Background(), connect.NewRequest(
				&paprikav1.GetDataSourcesRequest{},
			))
			require.NoError(t, err)

			status := response.Msg.Sources[2]
			require.Equal(t, paprikav1.DataClass_DATA_CLASS_CLUSTER_CAPACITY, status.DataClass,
				"the table stays in enum order")
			require.Equal(t, test.wantState, status.State)
			if test.wantEmpty {
				require.Empty(t, status.UnavailableReason, "a class that is collecting has nothing to explain")
				require.Equal(t, "KubernetesCapacity", status.Provider)
				return
			}
			require.NotEmpty(t, status.UnavailableReason, "a class that is not collecting must say what to do")
		})
	}
}

func TestGetDataSourcesProbesTheControlPlanesOwnCluster(t *testing.T) {
	t.Parallel()

	source := &stubCapacitySource{name: "KubernetesCapacity", reading: structuralReading()}
	server := capacityTestServer(t, []dataprovider.CapacitySource{source},
		capacityProvider(capacityControlPlaneNamespace, "structural", "KubernetesCapacity"),
		capacityBinding(capacityControlPlaneNamespace, "bind-structural", "structural", providersv1alpha1.ScopeGlobal, ""),
	)

	_, err := server.GetDataSources(context.Background(), connect.NewRequest(
		&paprikav1.GetDataSourcesRequest{},
	))
	require.NoError(t, err)

	recorded := source.recorded()
	require.Len(t, recorded, 1)
	require.Empty(t, recorded[0].ClusterKey,
		"the probe asks about the install, so it reads the cluster this control plane runs in")
}

// errCapacityStub is a plain provider failure, and errCapacityLeak is one
// carrying exactly the kind of operational detail a reason must never repeat.
var (
	errCapacityStub = errors.New("the provider failed")
	errCapacityLeak = errors.New("get https://api.internal.example/api/v1/nodes: unauthorized")
)

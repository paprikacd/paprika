package dataprovider

import (
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8stesting "k8s.io/client-go/testing"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	"k8s.io/metrics/pkg/client/clientset/versioned"
	metricsfake "k8s.io/metrics/pkg/client/clientset/versioned/fake"
)

// nodeMetrics returns a NodeMetrics reporting cpu/memory usage for one node.
func nodeMetrics(name, cpu, memory string) *metricsv1beta1.NodeMetrics {
	return &metricsv1beta1.NodeMetrics{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Usage: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse(cpu),
			corev1.ResourceMemory: resource.MustParse(memory),
		},
	}
}

// clientReturning returns a fake metrics clientset whose node-metrics list
// call always fails with err.
func clientReturning(err error) versioned.Interface {
	clientset := metricsfake.NewSimpleClientset()
	clientset.PrependReactor("list", "nodes", func(_ k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, err
	})
	return clientset
}

// clientWithNodeMetrics returns a fake metrics clientset whose node-metrics
// list responds with items.
//
// This cannot be done by passing items straight to
// metricsfake.NewSimpleClientset: that constructor infers each preset
// object's REST resource from its Kind by naive pluralization
// ("NodeMetrics" -> "nodemetricses"), but the generated metrics client
// actually lists resource "nodes" (see
// nodemetrics.go in k8s.io/metrics/pkg/client/clientset/versioned/typed/metrics/v1beta1).
// A preset NodeMetrics therefore lands under a GVR the client never queries,
// and List always comes back empty — a documented client-go object-tracker
// limitation, not something fixable by how the object is constructed.
// Answering the "list"/"nodes" action directly with a reactor sidesteps it;
// it's the same technique kubectl's own "top node" tests use against this
// same generated client.
func clientWithNodeMetrics(items ...*metricsv1beta1.NodeMetrics) versioned.Interface {
	list := &metricsv1beta1.NodeMetricsList{}
	for _, item := range items {
		list.Items = append(list.Items, *item)
	}

	clientset := metricsfake.NewSimpleClientset()
	clientset.PrependReactor("list", "nodes", func(_ k8stesting.Action) (bool, runtime.Object, error) {
		return true, list, nil
	})
	return clientset
}

func TestMetricsServerDescriptorAdvertisesOnlyUsed(t *testing.T) {
	t.Parallel()
	src := newMetricsServerWithClient(metricsfake.NewSimpleClientset())
	d := src.Descriptor()

	require.Equal(t, "MetricsServer", d.Name)
	require.Equal(t, []Field{FieldUsed}, d.Supplies)
	require.False(t, d.NeedsEgress)
	require.True(t, d.CanSupply(FieldUsed))
	require.False(t, d.CanSupply(FieldRequested), "this provider does not measure requested and must not claim to")
	require.False(t, d.CanSupply(FieldAllocatable), "this provider does not measure allocatable and must not claim to")
}

func TestMetricsServerReportsUsage(t *testing.T) {
	t.Parallel()
	mc := clientWithNodeMetrics(
		nodeMetrics("node-a", "1500m", "2Gi"),
		nodeMetrics("node-b", "500m", "1Gi"),
	)
	src := newMetricsServerWithClient(mc)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Equal(t, StateOK, got.CPUMillicores.Used.State)
	require.InDelta(t, 2000, got.CPUMillicores.Used.Value, 0.001)
}

func TestMetricsServerSumsMemoryAcrossNodes(t *testing.T) {
	t.Parallel()
	mc := clientWithNodeMetrics(
		nodeMetrics("node-a", "1500m", "2Gi"),
		nodeMetrics("node-b", "500m", "1Gi"),
	)
	src := newMetricsServerWithClient(mc)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)

	const gibibyte = 1024 * 1024 * 1024
	require.Equal(t, StateOK, got.MemoryBytes.Used.State)
	require.InDelta(t, 3*gibibyte, got.MemoryBytes.Used.Value, 0.001)
}

func TestMetricsServerLeavesRequestedAndAllocatableNotConfigured(t *testing.T) {
	t.Parallel()
	mc := clientWithNodeMetrics(nodeMetrics("node-a", "1500m", "2Gi"))
	src := newMetricsServerWithClient(mc)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)

	require.Equal(t, StateNotConfigured, got.CPUMillicores.Requested.State)
	require.Zero(t, got.CPUMillicores.Requested.Value)
	require.NotEmpty(t, got.CPUMillicores.Requested.Reason)
	require.Equal(t, StateNotConfigured, got.CPUMillicores.Allocatable.State)
	require.Zero(t, got.CPUMillicores.Allocatable.Value)
	require.NotEmpty(t, got.CPUMillicores.Allocatable.Reason)
	require.Equal(t, StateNotConfigured, got.MemoryBytes.Requested.State)
	require.Equal(t, StateNotConfigured, got.MemoryBytes.Allocatable.State)
}

func TestMetricsServerAbsentReportsNotAvailableNotZero(t *testing.T) {
	t.Parallel()
	// metrics.k8s.io is frequently not installed. That is a different
	// condition from "usage is zero", and the console renders it differently.
	src := newMetricsServerWithClient(clientReturning(apierrors.NewNotFound(
		schema.GroupResource{Group: "metrics.k8s.io", Resource: "nodemetrics"}, "")))
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err, "an absent metrics API is a state, not a call failure")
	require.Equal(t, StateNotAvailable, got.CPUMillicores.Used.State)
	require.Zero(t, got.CPUMillicores.Used.Value)
	require.NotEmpty(t, got.CPUMillicores.Used.Reason)
}

func TestMetricsServerServiceUnavailableReportsNotAvailable(t *testing.T) {
	t.Parallel()
	// The API group is registered but the metrics-server backend is not up
	// yet (e.g. still starting) — this is the same "not a call failure" state
	// as a NotFound, not an error.
	src := newMetricsServerWithClient(clientReturning(apierrors.NewServiceUnavailable("backend is unavailable")))
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Equal(t, StateNotAvailable, got.CPUMillicores.Used.State)
	require.Zero(t, got.CPUMillicores.Used.Value)
	require.NotEmpty(t, got.CPUMillicores.Used.Reason)
}

func TestMetricsServerOtherErrorReportsStateErrorSanitized(t *testing.T) {
	t.Parallel()
	// A generic failure (here, an internal server error carrying a made-up
	// detail) must map to StateError, and the Reason must never echo the
	// underlying error text.
	sensitive := "connection refused dialing https://10.0.0.5:443"
	src := newMetricsServerWithClient(clientReturning(apierrors.NewInternalError(
		&testError{msg: sensitive})))
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err, "a metrics query failure is reported through the Sample, not the return error")
	require.Equal(t, StateError, got.CPUMillicores.Used.State)
	require.Zero(t, got.CPUMillicores.Used.Value)
	require.NotEmpty(t, got.CPUMillicores.Used.Reason)
	require.NotContains(t, got.CPUMillicores.Used.Reason, sensitive,
		"the reason must never echo the underlying error, which may carry a cluster host")
	require.NotContains(t, got.CPUMillicores.Used.Reason, "10.0.0.5")
}

// testError is a minimal error used only to smuggle a distinctive, sensitive
// string into an error chain so a test can assert it never surfaces.
type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }

func TestMetricsServerValidateConfigAcceptsEmpty(t *testing.T) {
	t.Parallel()
	src := newMetricsServerWithClient(metricsfake.NewSimpleClientset())

	require.NoError(t, src.ValidateConfig(nil))
	require.NoError(t, src.ValidateConfig([]byte("")))
	require.NoError(t, src.ValidateConfig([]byte("null")))
	require.NoError(t, src.ValidateConfig([]byte("{}")))
}

func TestMetricsServerValidateConfigRejectsNonEmpty(t *testing.T) {
	t.Parallel()
	src := newMetricsServerWithClient(metricsfake.NewSimpleClientset())

	err := src.ValidateConfig([]byte(`{"apiKey":"super-secret-value"}`))
	require.Error(t, err)
	require.ErrorContains(t, err, "apiKey")
	require.NotContains(t, err.Error(), "super-secret-value",
		"the error must never echo a config value, only key names")
}

// metricsClientAlwaysContinuing returns a fake metrics clientset whose node-metrics
// list always hands back the exact same non-empty Continue token, forever —
// pageThroughList must refuse to loop against this rather than spinning.
func metricsClientAlwaysContinuing() versioned.Interface {
	clientset := metricsfake.NewSimpleClientset()
	clientset.PrependReactor("list", "nodes", func(_ k8stesting.Action) (bool, runtime.Object, error) {
		list := &metricsv1beta1.NodeMetricsList{
			ListMeta: metav1.ListMeta{Continue: "same-token-forever"},
			Items:    []metricsv1beta1.NodeMetrics{*nodeMetrics("node-a", "1", "1Gi")},
		}
		return true, list, nil
	})
	return clientset
}

func TestMetricsServerErrorsRatherThanSpinsOnRepeatingContinueToken(t *testing.T) {
	t.Parallel()
	src := newMetricsServerWithClient(metricsClientAlwaysContinuing())

	// A repeating Continue token is a pageThroughList programming-error case,
	// not an absent-API state, so it still surfaces as a StateError sample
	// rather than looping forever.
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Equal(t, StateError, got.CPUMillicores.Used.State)
}

func TestMetricsServerNoClientAvailableIsAnError(t *testing.T) {
	t.Parallel()
	src := NewMetricsServer(nil)
	_, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.Error(t, err, "with no client and no kube.Clients, Read cannot even attempt a query")
}

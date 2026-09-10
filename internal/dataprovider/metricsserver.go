package dataprovider

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/metrics/pkg/client/clientset/versioned"

	"github.com/benebsworth/paprika/internal/kube"
)

// metricsServerName is Descriptor().Name for MetricsServer.
const metricsServerName = "MetricsServer"

// requestedAllocatableNotConfiguredReason explains why Requested and
// Allocatable never become anything but StateNotConfigured here: this
// provider reads only metrics.k8s.io, which reports current usage and
// nothing about what a workload asked for or what a node can hold — that
// comes from the Kubernetes API itself, e.g. KubernetesCapacity.
const requestedAllocatableNotConfiguredReason = "MetricsServer reads only usage; bind a KubernetesCapacity provider for requested and allocatable"

// metricsNotAvailableReason explains a StateNotAvailable Used sample:
// metrics.k8s.io is frequently not installed on a cluster (metrics-server is
// an optional add-on), and an absent API is a fleet configuration state, not
// a call failure — so Read reports it without returning an error.
const metricsNotAvailableReason = "the metrics.k8s.io API is not installed or not ready on this cluster; install metrics-server to report usage"

// metricsErrorReason is the sanitized Reason used for any metrics.k8s.io
// failure that is not absence (a NotFound or a service-unavailable
// response). It never echoes the underlying error, which could otherwise
// carry a cluster host or other operational detail into a Sample that flows
// into the console and logs.
const metricsErrorReason = "querying metrics.k8s.io failed"

// MetricsServer reads current resource usage from a cluster's metrics.k8s.io
// aggregated API (typically served by the metrics-server add-on), summing
// every Node's reported usage. It is the "Used" counterpart to
// KubernetesCapacity: metrics-server has no notion of what was requested or
// what a node can hold, so Requested and Allocatable are always
// StateNotConfigured here.
//
// metrics-server is optional and frequently absent from a cluster. Read
// treats that absence as a reportable state (StateNotAvailable) rather than
// an error — see Read and metricsNotAvailableReason.
type MetricsServer struct {
	// clients hands out the cached metrics.k8s.io client for a cluster, the
	// same cache and the same entry KubernetesCapacity draws its core client
	// from: both providers read the same API server for the same cluster, so
	// they share one connection pool. Building a metrics client per Read —
	// which this did before kube.Clients learned the second client type —
	// meant a TLS handshake per capacity read per cluster, which is the cost
	// that cache exists to avoid.
	clients *kube.Clients

	// configs resolves the connection details for the cluster a ReadRequest
	// names, so usage for a remote fleet cluster comes from that cluster's own
	// metrics.k8s.io. Nil means the local-only fallback; see
	// InClusterConfigResolver.
	configs ClusterConfigResolver

	// client, when set, is used directly instead of resolving one through
	// clients. Test seam only: see newMetricsServerWithClient.
	client versioned.Interface
}

// NewMetricsServer returns a CapacitySource that reads current usage from
// the metrics.k8s.io API of the cluster named by each ReadRequest, using
// configs to resolve how that cluster is reached.
//
// A nil configs resolves only the cluster this control plane runs in; every
// other cluster key is then refused rather than silently answered with local
// numbers. See InClusterConfigResolver.
func NewMetricsServer(clients *kube.Clients, configs ClusterConfigResolver) *MetricsServer {
	return &MetricsServer{clients: clients, configs: configResolverOrDefault(configs)}
}

// newMetricsServerWithClient returns a MetricsServer that talks to client
// directly, bypassing in-cluster config resolution. Test seam only: it lets
// tests in this package use
// k8s.io/metrics/pkg/client/clientset/versioned/fake without standing up a
// kube.Clients or a cluster.
func newMetricsServerWithClient(client versioned.Interface) *MetricsServer {
	return &MetricsServer{client: client}
}

// Descriptor implements CapacitySource.
func (m *MetricsServer) Descriptor() Descriptor {
	return Descriptor{
		Name:        metricsServerName,
		Supplies:    []Field{FieldUsed},
		NeedsEgress: false,
	}
}

// ValidateConfig implements CapacitySource. MetricsServer needs no
// configuration of its own — it always reads node metrics from the cluster
// named by the request — so an empty/absent config is valid; a non-empty
// one is rejected. See validateNoConfig.
func (m *MetricsServer) ValidateConfig(config json.RawMessage) error {
	return validateNoConfig(metricsServerName, config)
}

// Read implements CapacitySource.
//
// An absent or unready metrics.k8s.io API is reported through Used's
// DataState, not through the returned error: see metricsNotAvailableReason.
// The returned error is reserved for failing to obtain a client at all, the
// same class of failure KubernetesCapacity.Read surfaces as an error.
func (m *MetricsServer) Read(ctx context.Context, req ReadRequest) (CapacityReading, error) {
	client, err := m.clientFor(ctx, req.ClusterKey)
	if err != nil {
		return CapacityReading{}, err
	}

	cpuMillis, memoryBytes, sumErr := sumNodeMetricsUsage(ctx, client)

	now := time.Now()
	used := usedSampleFor(cpuMillis, sumErr)
	usedMemory := usedSampleFor(memoryBytes, sumErr)
	notConfigured := Sample{State: StateNotConfigured, Reason: requestedAllocatableNotConfiguredReason}

	return CapacityReading{
		CPUMillicores: Meter{
			Used:        used,
			Requested:   notConfigured,
			Allocatable: notConfigured,
			ObservedAt:  now,
		},
		MemoryBytes: Meter{
			Used:        usedMemory,
			Requested:   notConfigured,
			Allocatable: notConfigured,
			ObservedAt:  now,
		},
	}, nil
}

// usedSampleFor turns the outcome of sumNodeMetricsUsage into a Used Sample
// for one resource dimension. A nil sumErr reports value as a fresh
// measurement; a NotFound or service-unavailable sumErr reports
// StateNotAvailable with a zero value rather than a fabricated zero
// measurement (see metricsNotAvailableReason); any other sumErr reports
// StateError with a sanitized reason (see metricsErrorReason).
func usedSampleFor(value int64, sumErr error) Sample {
	switch {
	case sumErr == nil:
		return Sample{Value: float64(value), State: StateOK}
	case apierrors.IsNotFound(sumErr) || apierrors.IsServiceUnavailable(sumErr):
		return Sample{State: StateNotAvailable, Reason: metricsNotAvailableReason}
	default:
		return Sample{State: StateError, Reason: metricsErrorReason}
	}
}

// clientFor returns the versioned.Interface to read clusterKey's node
// metrics through.
//
// When a test seam client is set it is always used. Otherwise the injected
// ClusterConfigResolver decides how clusterKey is reached, the same seam
// KubernetesCapacity resolves its own client through.
func (m *MetricsServer) clientFor(ctx context.Context, clusterKey string) (versioned.Interface, error) {
	if m.client != nil {
		return m.client, nil
	}
	if m.clients == nil {
		return nil, fmt.Errorf("metrics server: no client available for cluster %q", clusterKey)
	}

	cfg, err := configResolverOrDefault(m.configs).ConfigFor(ctx, clusterKey)
	if err != nil {
		return nil, fmt.Errorf("resolving config for cluster %q: %w", clusterKey, err)
	}

	metricsClient, err := m.clients.MetricsFor(clusterKey, kube.WithProtobufBothWays(cfg))
	if err != nil {
		return nil, fmt.Errorf("building metrics client for cluster %q: %w", clusterKey, err)
	}

	return metricsClient, nil
}

// sumNodeMetricsUsage sums reported usage.cpu and usage.memory across every
// NodeMetrics. There is one NodeMetrics per node, the same cardinality as
// the Node list KubernetesCapacity pages through, so this reuses
// pageThroughList rather than a second, unbounded loop: a misbehaving
// metrics.k8s.io implementation that never empties its Continue token must
// not be able to spin this Read forever any more than a misbehaving core API
// server can spin KubernetesCapacity's.
func sumNodeMetricsUsage(ctx context.Context, client versioned.Interface) (cpuMillis, memoryBytes int64, err error) {
	err = pageThroughList(func(continueToken string) (string, error) {
		list, listErr := client.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{
			Limit:    capacityListPageSize,
			Continue: continueToken,
		})
		if listErr != nil {
			return "", fmt.Errorf("listing node metrics: %w", listErr)
		}

		for i := range list.Items {
			usage := list.Items[i].Usage
			cpuMillis += usage.Cpu().MilliValue()
			memoryBytes += usage.Memory().Value()
		}

		return list.Continue, nil
	})
	if err != nil {
		return 0, 0, err
	}

	return cpuMillis, memoryBytes, nil
}

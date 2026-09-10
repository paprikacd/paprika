package dataprovider

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/benebsworth/paprika/internal/kube"
)

// kubernetesCapacityName is Descriptor().Name for KubernetesCapacity.
const kubernetesCapacityName = "KubernetesCapacity"

// usedNotConfiguredReason explains why Used never becomes anything but
// StateNotConfigured here: this provider reads only the Kubernetes API
// (nodes and pods), which has no notion of actual resource consumption —
// that requires a real usage source such as metrics-server or Prometheus.
const usedNotConfiguredReason = "no usage source is bound; bind a MetricsServer or Prometheus provider"

// capacityListPageSize bounds how many objects KubernetesCapacity asks for
// in one List call. A fleet-scale cluster's pod list is the expensive call
// this provider makes, so it is paged rather than fetched in one response.
const capacityListPageSize = 500

// KubernetesCapacity reads Allocatable and Requested straight from a
// cluster's own Kubernetes API: Allocatable by summing every Node's
// status.allocatable, Requested by summing every consuming Pod's container
// resource requests. It needs no configuration and no external system, so a
// default install gets working capacity meters for those two fields without
// standing up anything else.
//
// It cannot supply Used — that requires an actual usage source, which the
// Kubernetes API itself does not expose — so Used is always reported as
// StateNotConfigured rather than a misleading zero. See Descriptor and Read.
type KubernetesCapacity struct {
	clients *kube.Clients

	// clientset, when set, is used directly instead of resolving a client
	// through clients. It exists so tests can exercise Read against
	// k8s.io/client-go/kubernetes/fake without a kube.Clients or a real
	// cluster; see newKubernetesCapacityWithClientset.
	clientset kubernetes.Interface
}

// NewKubernetesCapacity returns a CapacitySource that reads allocatable and
// requested capacity from the Kubernetes API of the cluster named by each
// ReadRequest, using clients to obtain (and reuse) a client per cluster.
func NewKubernetesCapacity(clients *kube.Clients) *KubernetesCapacity {
	return &KubernetesCapacity{clients: clients}
}

// newKubernetesCapacityWithClientset returns a KubernetesCapacity that talks
// to clientset directly, bypassing the per-cluster client cache. Test seam
// only: it lets tests in this package use k8s.io/client-go/kubernetes/fake
// without standing up a kube.Clients or a cluster.
func newKubernetesCapacityWithClientset(clientset kubernetes.Interface) *KubernetesCapacity {
	return &KubernetesCapacity{clientset: clientset}
}

// Descriptor implements CapacitySource.
func (k *KubernetesCapacity) Descriptor() Descriptor {
	return Descriptor{
		Name:        kubernetesCapacityName,
		Supplies:    []Field{FieldRequested, FieldAllocatable},
		NeedsEgress: false,
	}
}

// ValidateConfig implements CapacitySource. KubernetesCapacity needs no
// configuration — it always reads nodes and pods directly — so an
// empty/absent config is valid. A non-empty config is rejected rather than
// silently ignored: silently ignoring it would let a typo'd or stale config
// pass admission unnoticed.
//
// The rejection names only the unexpected key(s), never their values. This
// error can surface through an admission rejection and reach API server
// logs, and a future config shape could carry a credential.
func (k *KubernetesCapacity) ValidateConfig(config json.RawMessage) error {
	trimmed := strings.TrimSpace(string(config))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var asObject map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &asObject); err != nil {
		return fmt.Errorf("%s accepts no configuration", kubernetesCapacityName)
	}
	if len(asObject) == 0 {
		return nil
	}

	keys := make([]string, 0, len(asObject))
	for key := range asObject {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	return fmt.Errorf("%s accepts no configuration, but found key(s): %s", kubernetesCapacityName, strings.Join(keys, ", "))
}

// Read implements CapacitySource.
func (k *KubernetesCapacity) Read(ctx context.Context, req ReadRequest) (CapacityReading, error) {
	client, err := k.clientFor(req.ClusterKey)
	if err != nil {
		return CapacityReading{}, err
	}

	allocatableCPU, allocatableMemory, err := sumAllocatable(ctx, client)
	if err != nil {
		return CapacityReading{}, fmt.Errorf("summing allocatable capacity: %w", err)
	}

	requestedCPU, requestedMemory, err := sumRequested(ctx, client, req.Namespace)
	if err != nil {
		return CapacityReading{}, fmt.Errorf("summing requested capacity: %w", err)
	}

	now := time.Now()
	notConfiguredUsed := Sample{State: StateNotConfigured, Reason: usedNotConfiguredReason}

	return CapacityReading{
		CPUMillicores: Meter{
			Used:        notConfiguredUsed,
			Requested:   Sample{Value: float64(requestedCPU), State: StateOK},
			Allocatable: Sample{Value: float64(allocatableCPU), State: StateOK},
			ObservedAt:  now,
		},
		MemoryBytes: Meter{
			Used:        notConfiguredUsed,
			Requested:   Sample{Value: float64(requestedMemory), State: StateOK},
			Allocatable: Sample{Value: float64(allocatableMemory), State: StateOK},
			ObservedAt:  now,
		},
	}, nil
}

// clientFor returns the kubernetes.Interface to read clusterKey through.
//
// When a test seam clientset is set it is always used. Otherwise this
// resolves the in-cluster config: KubernetesCapacity needs no configuration
// of its own, and reading the cluster this control plane already runs in
// needs no separate credential to resolve, unlike a remote managed cluster.
func (k *KubernetesCapacity) clientFor(clusterKey string) (kubernetes.Interface, error) {
	if k.clientset != nil {
		return k.clientset, nil
	}
	if k.clients == nil {
		return nil, fmt.Errorf("kubernetes capacity: no client available for cluster %q", clusterKey)
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("resolving in-cluster config for cluster %q: %w", clusterKey, err)
	}

	client, err := k.clients.For(clusterKey, kube.WithProtobufBothWays(cfg))
	if err != nil {
		return nil, fmt.Errorf("building kubernetes client for cluster %q: %w", clusterKey, err)
	}

	return client, nil
}

// sumAllocatable sums status.allocatable cpu and memory across every Node.
func sumAllocatable(ctx context.Context, client kubernetes.Interface) (cpuMillis, memoryBytes int64, err error) {
	continueToken := ""
	for {
		list, listErr := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{
			Limit:    capacityListPageSize,
			Continue: continueToken,
		})
		if listErr != nil {
			return 0, 0, fmt.Errorf("listing nodes: %w", listErr)
		}

		for i := range list.Items {
			allocatable := list.Items[i].Status.Allocatable
			cpuMillis += allocatable.Cpu().MilliValue()
			memoryBytes += allocatable.Memory().Value()
		}

		continueToken = list.Continue
		if continueToken == "" {
			return cpuMillis, memoryBytes, nil
		}
	}
}

// sumRequested sums container cpu and memory requests across every Pod in
// namespace (all namespaces when namespace is empty) that is actually
// consuming node capacity: scheduled and not in a terminal phase.
//
// This sums regular containers only. Kubernetes' effective request per pod
// is technically max(largest init container, sum of regular containers) —
// init containers are considered too, per pod resource accounting — but
// that refinement is left for a later increment; see the Task 5 report.
func sumRequested(ctx context.Context, client kubernetes.Interface, namespace string) (cpuMillis, memoryBytes int64, err error) {
	// Best-effort narrowing: reduces what the API server has to send back on
	// a real cluster. Correctness does not depend on the server honoring it —
	// podConsumesCapacity re-checks NodeName and phase on every item.
	selector := fields.OneTermNotEqualSelector("spec.nodeName", "").String()

	continueToken := ""
	for {
		list, listErr := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
			Limit:         capacityListPageSize,
			Continue:      continueToken,
			FieldSelector: selector,
		})
		if listErr != nil {
			return 0, 0, fmt.Errorf("listing pods: %w", listErr)
		}

		for i := range list.Items {
			pod := &list.Items[i]
			if !podConsumesCapacity(pod) {
				continue
			}
			for j := range pod.Spec.Containers {
				requests := pod.Spec.Containers[j].Resources.Requests
				cpuMillis += requests.Cpu().MilliValue()
				memoryBytes += requests.Memory().Value()
			}
		}

		continueToken = list.Continue
		if continueToken == "" {
			return cpuMillis, memoryBytes, nil
		}
	}
}

// podConsumesCapacity reports whether pod currently occupies node capacity:
// an unscheduled pod (empty Spec.NodeName) has not been placed anywhere, and
// a pod in a terminal phase (Succeeded or Failed) has released whatever it
// was using.
func podConsumesCapacity(pod *corev1.Pod) bool {
	if pod.Spec.NodeName == "" {
		return false
	}

	switch pod.Status.Phase {
	case corev1.PodSucceeded, corev1.PodFailed:
		return false
	case corev1.PodPending, corev1.PodRunning, corev1.PodUnknown:
		return true
	default:
		// No phase reported yet (a freshly admitted pod): Kubernetes has not
		// declared it terminal, so treat it as consuming until it does.
		return true
	}
}

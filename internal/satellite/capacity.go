package satellite

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/clusterprovider"
)

// NodeMetricsResource is the metrics.k8s.io resource the collector watches for
// live usage. Watching it is optional: the aggregated API is an add-on, and a
// cluster without it still reports requests and allocatable.
var NodeMetricsResource = schema.GroupVersionResource{
	Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodemetrics",
}

// nodeMetricsKind is the kind NodeMetrics objects carry. The satellite sees
// Applications and NodeMetrics through the same dynamic informer path, so the
// kind is the only thing that tells them apart.
const nodeMetricsKind = "NodeMetrics"

// nodePoolLabels lists the node-pool membership labels every managed provider
// stamps. Pool derivation reads whichever one is present, so a node can be
// grouped before the provider is known.
var nodePoolLabels = [...]string{
	"vke.vultr.com/node-pool",
	"cloud.google.com/gke-nodepool",
	"eks.amazonaws.com/nodegroup",
	"kubernetes.azure.com/agentpool",
}

// capacityLabelKeys are the node labels the compact projection retains. They
// are the inputs to pool grouping and topology reporting; nothing else on a node
// is kept, so a label an operator uses for their own bookkeeping never travels
// to the control plane.
//
// It is a package value, not a function, because every watched object passes
// through the compaction transform: rebuilding this slice per event would
// allocate on the hot path for a list that never changes.
var capacityLabelKeys = append(append([]string{}, nodePoolLabels[:]...),
	"node.kubernetes.io/instance-type",
	"topology.kubernetes.io/region",
	"topology.kubernetes.io/zone",
)

// capacityObservation is the per-node or per-pod input to resource accounting.
// It holds scalars only so an observation stays comparable: the state map
// decides whether anything changed with a plain struct comparison.
type capacityObservation struct {
	providerID             string
	poolName               string
	machineType            string
	allocatableCPUMillis   int64
	allocatableMemoryBytes int64
	requestedCPUMillis     int64
	requestedMemoryBytes   int64
	usedCPUMillis          int64
	usedMemoryBytes        int64
	// countsCapacity marks a scheduled, non-terminal pod. An unscheduled pod has
	// not been placed anywhere, and a terminal one has released what it held.
	countsCapacity bool
}

func (o *capacityObservation) projectNode(node *corev1.Node) {
	o.providerID = node.Spec.ProviderID
	o.poolName = nodePoolName(node.Labels)
	o.machineType = node.Labels["node.kubernetes.io/instance-type"]
	o.allocatableCPUMillis = node.Status.Allocatable.Cpu().MilliValue()
	o.allocatableMemoryBytes = node.Status.Allocatable.Memory().Value()
}

func (o *capacityObservation) projectPod(pod *corev1.Pod) {
	o.projectPodPlacement(pod.Spec.NodeName, pod.Status.Phase)
	for i := range pod.Spec.Containers {
		requests := pod.Spec.Containers[i].Resources.Requests
		o.requestedCPUMillis += requests.Cpu().MilliValue()
		o.requestedMemoryBytes += requests.Memory().Value()
	}
}

// projectPodPlacement decides whether a pod occupies node capacity without
// reading its container resources, so a compacted pod whose spec was stripped
// still contributes the right placement verdict.
func (o *capacityObservation) projectPodPlacement(nodeName string, phase corev1.PodPhase) {
	o.countsCapacity = nodeName != "" && phase != corev1.PodSucceeded && phase != corev1.PodFailed
}

// projectNodeMetrics reads one metrics.k8s.io NodeMetrics object and reports
// whether it carried usable usage.
//
// Both dimensions must parse. A reading with one good dimension and one broken
// one would publish a zero for the broken one, and zero usage is
// indistinguishable from an idle cluster; dropping the whole object leaves the
// meter honestly unknown instead.
func (o *capacityObservation) projectNodeMetrics(object *unstructured.Unstructured) bool {
	cpu, cpuOK := usageMillis(object.Object, "cpu")
	memory, memoryOK := usageBytes(object.Object, "memory")
	if !cpuOK || !memoryOK {
		return false
	}
	o.usedCPUMillis, o.usedMemoryBytes = cpu, memory
	return true
}

// nodePoolName returns whichever provider pool label a node carries.
func nodePoolName(labels map[string]string) string {
	for _, key := range nodePoolLabels {
		if value := labels[key]; value != "" {
			return value
		}
	}
	return ""
}

// compactNodeMetrics strips a NodeMetrics object to its usage. The object is
// small already, but the informer cache is shared with the rest of the process,
// so narrowing it here keeps the "no raw objects are retained" rule intact.
func compactNodeMetrics(nodeMetrics *unstructured.Unstructured) *unstructured.Unstructured {
	compacted := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": NodeMetricsResource.Group + "/" + NodeMetricsResource.Version,
		"kind":       nodeMetricsKind,
		"metadata":   map[string]any{"name": nodeMetrics.GetName()},
	}}
	if usage, _, err := unstructured.NestedMap(nodeMetrics.Object, "usage"); err == nil && len(usage) > 0 {
		compacted.Object["usage"] = usage
	}
	return compacted
}

// isNodeMetricsValue reports whether an unstructured object is a NodeMetrics
// rather than an Application.
func isNodeMetricsValue(object *unstructured.Unstructured) bool {
	return object.GetKind() == nodeMetricsKind &&
		object.GroupVersionKind().Group == NodeMetricsResource.Group
}

// compactPod keeps only what capacity accounting and inventory need. Container
// resources are retained; container specs are not, so environment variables and
// image references never enter the cache.
func compactPod(pod *corev1.Pod) *corev1.Pod {
	containers := make([]corev1.Container, 0, len(pod.Spec.Containers))
	for i := range pod.Spec.Containers {
		requests := pod.Spec.Containers[i].Resources.Requests
		if len(requests) == 0 {
			continue
		}
		containers = append(containers, corev1.Container{
			Resources: corev1.ResourceRequirements{Requests: requests.DeepCopy()},
		})
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: pod.Name, Namespace: pod.Namespace, UID: pod.UID},
		Spec:       corev1.PodSpec{NodeName: pod.Spec.NodeName, Containers: containers},
		Status:     corev1.PodStatus{Phase: pod.Status.Phase},
	}
}

// capacityBuilder folds per-object observations into the report shape. A
// cluster with no metrics API keeps usageKnown false, which is the honest
// answer: nothing measured usage, so nothing claims it was zero.
type capacityBuilder struct {
	facts             []clusterprovider.NodePoolFacts
	providerIDs       []string
	cpuUsed           int64
	memoryUsed        int64
	cpuRequested      int64
	memoryRequested   int64
	usageKnown        bool
	allocatableCPU    int64
	allocatableMemory int64
}

func (b *capacityBuilder) addNode(o *capacityObservation) {
	b.providerIDs = append(b.providerIDs, o.providerID)
	b.facts = append(b.facts, clusterprovider.NodePoolFacts{
		ProviderID:             o.providerID,
		PoolName:               o.poolName,
		MachineType:            o.machineType,
		AllocatableCPUMillis:   o.allocatableCPUMillis,
		AllocatableMemoryBytes: o.allocatableMemoryBytes,
	})
	b.allocatableCPU += o.allocatableCPUMillis
	b.allocatableMemory += o.allocatableMemoryBytes
}

func (b *capacityBuilder) addPod(o *capacityObservation) {
	if !o.countsCapacity {
		return
	}
	b.cpuRequested += o.requestedCPUMillis
	b.memoryRequested += o.requestedMemoryBytes
}

func (b *capacityBuilder) addNodeMetrics(o *capacityObservation) {
	b.cpuUsed += o.usedCPUMillis
	b.memoryUsed += o.usedMemoryBytes
	b.usageKnown = true
}

// build returns the report payload. Allocatable is summed as nodes are added so
// it always agrees with the pool breakdown beside it.
func (b *capacityBuilder) build() (clustersv1alpha1.SatelliteCapacity, []clustersv1alpha1.ClusterNodePool, string) {
	providerType := clusterprovider.DetectProviderIDs(b.providerIDs)
	capacity := clustersv1alpha1.SatelliteCapacity{
		CPUMillicores: clustersv1alpha1.SatelliteResourceUsage{
			Used: b.cpuUsed, Requested: b.cpuRequested,
			Allocatable: b.allocatableCPU, UsedKnown: b.usageKnown,
		},
		MemoryBytes: clustersv1alpha1.SatelliteResourceUsage{
			Used: b.memoryUsed, Requested: b.memoryRequested,
			Allocatable: b.allocatableMemory, UsedKnown: b.usageKnown,
		},
	}
	return capacity, clusterprovider.NodePoolsFromFacts(providerType, b.facts), providerType
}

func usageMillis(object map[string]any, dimension string) (int64, bool) {
	value, found, err := unstructured.NestedString(object, "usage", dimension)
	if err != nil || !found {
		return 0, false
	}
	return parseQuantityMillis(value)
}

func usageBytes(object map[string]any, dimension string) (int64, bool) {
	value, found, err := unstructured.NestedString(object, "usage", dimension)
	if err != nil || !found {
		return 0, false
	}
	return parseQuantityBytes(value)
}

// parseQuantityMillis parses a Kubernetes quantity as milli-units. metrics.k8s.io
// reports usage.cpu as a string ("250m", "2"), so the millisecond form is the
// only one that keeps sub-core readings.
func parseQuantityMillis(value string) (int64, bool) {
	quantity, err := resource.ParseQuantity(value)
	if err != nil {
		return 0, false
	}
	return quantity.MilliValue(), true
}

// parseQuantityBytes parses a Kubernetes quantity as whole bytes, which is the
// form usage.memory ("512Mi", "1Gi") is reported in.
func parseQuantityBytes(value string) (int64, bool) {
	quantity, err := resource.ParseQuantity(value)
	if err != nil {
		return 0, false
	}
	return quantity.Value(), true
}

package satellite

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

func capacityNode(name, providerID, poolLabel, machineType, cpu, memory string) *corev1.Node {
	labels := map[string]string{"node.kubernetes.io/instance-type": machineType}
	if poolLabel != "" {
		labels["vke.vultr.com/node-pool"] = poolLabel
	}
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name, UID: types.UID("uid-" + name), Labels: labels},
		Spec:       corev1.NodeSpec{ProviderID: providerID},
		Status: corev1.NodeStatus{
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse(cpu),
				corev1.ResourceMemory: resource.MustParse(memory),
			},
			Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
		},
	}
}

func capacityPod(name, nodeName string, phase corev1.PodPhase, cpu, memory string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "prod", UID: types.UID("uid-" + name)},
		Spec: corev1.PodSpec{
			NodeName: nodeName,
			Containers: []corev1.Container{{
				Name: "app",
				Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse(cpu),
					corev1.ResourceMemory: resource.MustParse(memory),
				}},
			}},
		},
		Status: corev1.PodStatus{Phase: phase},
	}
}

func nodeMetrics(name, cpu, memory string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "metrics.k8s.io/v1beta1",
		"kind":       "NodeMetrics",
		"metadata":   map[string]any{"name": name},
		"usage":      map[string]any{"cpu": cpu, "memory": memory},
	}}
}

func TestCapacitySumsAllocatableRequestsAndUsage(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "vultr://abc", "general", "vc2-2c-4gb", "2", "4Gi"))
	state.upsert(capacityNode("node-b", "vultr://def", "general", "vc2-2c-4gb", "2", "4Gi"))
	state.upsert(capacityPod("api", "node-a", corev1.PodRunning, "500m", "512Mi"))
	state.upsert(capacityPod("worker", "node-b", corev1.PodRunning, "250m", "256Mi"))
	state.upsert(nodeMetrics("node-a", "1000m", "1Gi"))
	state.upsert(nodeMetrics("node-b", "500m", "2Gi"))

	capacity, pools, providerType := state.capacitySnapshot()

	if providerType != "vultr" {
		t.Fatalf("provider type = %q, want vultr", providerType)
	}
	if !capacity.CPUMillicores.UsedKnown || !capacity.MemoryBytes.UsedKnown {
		t.Fatal("usage was measured, so UsedKnown must be true for both dimensions")
	}
	if got, want := capacity.CPUMillicores.Allocatable, int64(4000); got != want {
		t.Errorf("allocatable cpu = %d, want %d", got, want)
	}
	if got, want := capacity.CPUMillicores.Requested, int64(750); got != want {
		t.Errorf("requested cpu = %d, want %d", got, want)
	}
	if got, want := capacity.CPUMillicores.Used, int64(1500); got != want {
		t.Errorf("used cpu = %d, want %d", got, want)
	}
	if got, want := capacity.MemoryBytes.Allocatable, int64(8<<30); got != want {
		t.Errorf("allocatable memory = %d, want %d", got, want)
	}
	if got, want := capacity.MemoryBytes.Used, int64(3<<30); got != want {
		t.Errorf("used memory = %d, want %d", got, want)
	}

	if len(pools) != 1 {
		t.Fatalf("pools = %#v, want one grouped pool", pools)
	}
	if pools[0].Name != "general" || pools[0].NodeCount != 2 || pools[0].MachineType != "vc2-2c-4gb" {
		t.Errorf("pool = %#v", pools[0])
	}
	if pools[0].AllocatableCPUMillis != 4000 {
		t.Errorf("pool allocatable cpu = %d, want 4000", pools[0].AllocatableCPUMillis)
	}
}

func TestCapacityReportsUsageUnknownWithoutMetrics(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "", "", "", "4", "8Gi"))
	state.upsert(capacityPod("api", "node-a", corev1.PodRunning, "1", "1Gi"))

	capacity, _, _ := state.capacitySnapshot()

	if capacity.CPUMillicores.UsedKnown || capacity.MemoryBytes.UsedKnown {
		t.Fatal("no metrics API was observed, so usage must be reported unknown, not zero")
	}
	if capacity.CPUMillicores.Used != 0 {
		t.Errorf("used cpu = %d, want 0 alongside UsedKnown=false", capacity.CPUMillicores.Used)
	}
	if capacity.CPUMillicores.Requested != 1000 {
		t.Errorf("requested cpu = %d, want 1000", capacity.CPUMillicores.Requested)
	}
}

func TestCapacityIgnoresUnscheduledAndTerminalPods(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "", "", "", "4", "8Gi"))
	state.upsert(capacityPod("unscheduled", "", corev1.PodPending, "2", "4Gi"))
	state.upsert(capacityPod("finished", "node-a", corev1.PodSucceeded, "2", "4Gi"))
	state.upsert(capacityPod("failed", "node-a", corev1.PodFailed, "2", "4Gi"))
	state.upsert(capacityPod("running", "node-a", corev1.PodRunning, "250m", "128Mi"))

	capacity, _, _ := state.capacitySnapshot()

	if got, want := capacity.CPUMillicores.Requested, int64(250); got != want {
		t.Errorf("requested cpu = %d, want only the running pod's %d", got, want)
	}
	if got, want := capacity.MemoryBytes.Requested, int64(128<<20); got != want {
		t.Errorf("requested memory = %d, want only the running pod's %d", got, want)
	}
}

func TestCapacityDropsUnparsableMetrics(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "", "", "", "2", "4Gi"))
	state.upsert(nodeMetrics("node-a", "not-a-quantity", "1Gi"))

	capacity, _, _ := state.capacitySnapshot()

	if capacity.CPUMillicores.UsedKnown {
		t.Error("one parsable dimension arrived with one broken one; usage must not be claimed as measured")
	}
}

func TestCapacityIgnoresMetricsForUnknownNodes(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "", "", "", "2", "4Gi"))
	state.upsert(nodeMetrics("node-gone", "1500m", "1Gi"))

	capacity, _, _ := state.capacitySnapshot()

	if !capacity.CPUMillicores.UsedKnown || capacity.CPUMillicores.Used != 1500 {
		t.Fatalf("used cpu = %d (known=%v), want the reported 1500", capacity.CPUMillicores.Used, capacity.CPUMillicores.UsedKnown)
	}
}

func TestClearingNodeMetricsDropsUsage(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "", "", "", "2", "4Gi"))
	state.upsert(nodeMetrics("node-a", "1500m", "1Gi"))
	if !state.capacitySnapshotReady(t) {
		t.Fatal("usage should be known before the metrics API disappears")
	}

	state.clearKind(nodeMetricsKind)

	capacity, _, _ := state.capacitySnapshot()
	if capacity.CPUMillicores.UsedKnown {
		t.Fatal("usage must become unknown once the metrics observations are dropped")
	}
}

// capacitySnapshotReady reports whether usage is known. It exists to keep the
// two assertions above readable.
func (s *observationState) capacitySnapshotReady(t *testing.T) bool {
	t.Helper()
	capacity, _, _ := s.capacitySnapshot()
	return capacity.CPUMillicores.UsedKnown
}

func TestCapacityBoundAndSelection(t *testing.T) {
	state := newObservationState()
	state.upsert(capacityNode("node-a", "aws:///us-east-1a/i-1", "", "m5.large", "2", "8Gi"))
	state.upsert(capacityNode("node-b", "aws:///us-east-1a/i-2", "", "m5.large", "2", "8Gi"))

	_, pools, providerType := state.capacitySnapshot()
	if providerType != "eks" {
		t.Fatalf("provider type = %q, want eks", providerType)
	}
	if len(pools) != 1 || pools[0].Name != "m5.large" {
		t.Fatalf("pools without a provider label must group by instance type: %#v", pools)
	}
}

func TestCompactObjectPreservesCapacityInputs(t *testing.T) {
	node := capacityNode("node-a", "vultr://abc", "general", "vc2-2c-4gb", "2", "4Gi")
	compacted, err := compactObject(node)
	if err != nil {
		t.Fatal(err)
	}
	compactNode, ok := compacted.(*corev1.Node)
	if !ok {
		t.Fatalf("compacted node has type %T", compacted)
	}
	if compactNode.Spec.ProviderID != "vultr://abc" {
		t.Errorf("providerID was dropped: %q", compactNode.Spec.ProviderID)
	}
	if compactNode.Labels["vke.vultr.com/node-pool"] != "general" {
		t.Errorf("pool label was dropped: %#v", compactNode.Labels)
	}
	if compactNode.Status.Allocatable.Cpu().MilliValue() != 2000 {
		t.Errorf("allocatable cpu was dropped: %#v", compactNode.Status.Allocatable)
	}
	if _, retained := compactNode.Status.Allocatable[corev1.ResourceEphemeralStorage]; retained {
		t.Error("allocatable kept a dimension the fleet meter does not report")
	}

	pod := capacityPod("api", "node-a", corev1.PodRunning, "500m", "512Mi")
	pod.Spec.Containers[0].Env = []corev1.EnvVar{{Name: "TOKEN", Value: "environment-secret"}}
	compactedPod, err := compactObject(pod)
	if err != nil {
		t.Fatal(err)
	}
	compactPodValue, ok := compactedPod.(*corev1.Pod)
	if !ok {
		t.Fatalf("compacted pod has type %T", compactedPod)
	}
	if compactPodValue.Spec.Containers[0].Resources.Requests.Cpu().MilliValue() != 500 {
		t.Errorf("container requests were dropped: %#v", compactPodValue.Spec.Containers)
	}
	if len(compactPodValue.Spec.Containers[0].Env) != 0 {
		t.Error("compaction retained container environment")
	}
}

func TestCompactNodeMetricsKeepsOnlyUsage(t *testing.T) {
	metrics := nodeMetrics("node-a", "1500m", "1Gi")
	metrics.Object["metadata"] = map[string]any{
		"name":            "node-a",
		"resourceVersion": "12",
		"labels":          map[string]any{"sensitive": "label-secret"},
	}
	metrics.Object["timestamp"] = "2026-10-19T00:00:00Z"

	compacted, err := compactObject(metrics)
	if err != nil {
		t.Fatal(err)
	}
	object, ok := compacted.(*unstructured.Unstructured)
	if !ok {
		t.Fatalf("compacted metrics has type %T", compacted)
	}
	if _, found, _ := unstructured.NestedMap(object.Object, "usage"); !found {
		t.Fatal("usage was dropped")
	}
	if _, found, _ := unstructured.NestedMap(object.Object, "metadata", "labels"); found {
		t.Error("compaction retained metadata labels")
	}
	if got := object.GetName(); got != "node-a" {
		t.Errorf("name = %q, want node-a", got)
	}
}

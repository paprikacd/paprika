package arcobserver

import (
	"context"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Historical collection remains explicitly opt-in. The kube-system UID is a
// pinned cluster identity, not a guessed identity based on a display name.
type UsageConfig struct {
	ClusterID          string   `json:"clusterId"`
	ClusterUID         string   `json:"clusterUid"`
	DedicatedNodePools []string `json:"dedicatedNodePools,omitempty"`
}

type JobIdentity struct {
	Repository    string `json:"repository,omitempty"`
	WorkflowRunID int64  `json:"workflowRunId,omitempty"`
	JobID         string `json:"jobId,omitempty"`
	RunnerID      int64  `json:"runnerId,omitempty"`
	Provenance    string `json:"provenance"`
}

type ResourceObservation struct {
	UID                 string       `json:"uid"`
	Kind                string       `json:"kind"`
	Namespace           string       `json:"namespace,omitempty"`
	Phase               string       `json:"phase,omitempty"`
	ResourceVersion     string       `json:"resourceVersion"`
	CreatedAt           *time.Time   `json:"createdAt,omitempty"`
	DeletionRequestedAt *time.Time   `json:"deletionRequestedAt,omitempty"`
	RuntimeStartedAt    *time.Time   `json:"runtimeStartedAt,omitempty"`
	RuntimeFinishedAt   *time.Time   `json:"runtimeFinishedAt,omitempty"`
	OwnerUID            string       `json:"ownerUid,omitempty"`
	NodeUID             string       `json:"nodeUid,omitempty"`
	NodeClass           string       `json:"nodeClass,omitempty"`
	NodePool            string       `json:"nodePool,omitempty"`
	MachineType         string       `json:"machineType,omitempty"`
	PurchaseModel       string       `json:"purchaseModel,omitempty"`
	CPURequestMillis    int64        `json:"cpuRequestMillis,omitempty"`
	MemoryRequestBytes  int64        `json:"memoryRequestBytes,omitempty"`
	Job                 *JobIdentity `json:"job,omitempty"`
}

type UsageSnapshot struct {
	Schema                string                `json:"schema"`
	ClusterID             string                `json:"clusterId"`
	ClusterUID            string                `json:"clusterUid"`
	NodeInventoryComplete bool                  `json:"nodeInventoryComplete"`
	Resources             []ResourceObservation `json:"resources"`
}

var namespaceGVR = schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}
var nodeGVR = schema.GroupVersionResource{Version: "v1", Resource: "nodes"}

const nodePoolLabel = "cloud.google.com/gke-nodepool"

func validUsageConfig(c *UsageConfig) bool {
	if !identifier.MatchString(c.ClusterID) || !identifier.MatchString(c.ClusterUID) || len(c.DedicatedNodePools) > 2 {
		return false
	}
	seen := map[string]bool{}
	for _, p := range c.DedicatedNodePools {
		if !kubeName.MatchString(p) || seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}

func (c KubernetesCollector) collectUsage(ctx context.Context, s *Source, snap *Snapshot) (*UsageSnapshot, error) {
	ns, err := c.Client.Resource(namespaceGVR).Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		return nil, readError(err)
	}
	if string(ns.GetUID()) != c.Usage.ClusterUID {
		return nil, ErrIncomplete
	}
	controllerPods, err := c.controllerPods(ctx, s, snap.Controller)
	if err != nil {
		return nil, err
	}
	u := &UsageSnapshot{Schema: "arc-usage/v1", ClusterID: c.Usage.ClusterID, ClusterUID: c.Usage.ClusterUID, Resources: []ResourceObservation{}}
	for i := range snap.EphemeralRunners {
		u.Resources = append(u.Resources, runnerObservation(&snap.EphemeralRunners[i]))
	}
	pods, err := appendUsagePods(u, snap, controllerPods)
	if err != nil {
		return nil, err
	}
	nodes, complete, err := c.usageNodes(ctx, pods)
	if err != nil {
		return nil, err
	}
	u.NodeInventoryComplete = complete
	if err = attachNodes(u, nodes, pods, c.Usage); err != nil {
		return nil, err
	}
	if len(u.Resources) > 256 {
		return nil, ErrIncomplete
	}
	sort.Slice(u.Resources, func(i, j int) bool {
		return u.Resources[i].Kind+u.Resources[i].UID < u.Resources[j].Kind+u.Resources[j].UID
	})
	return u, nil
}

func (c KubernetesCollector) controllerPods(ctx context.Context, s *Source, d *unstructured.Unstructured) ([]unstructured.Unstructured, error) {
	raw, found, err := unstructured.NestedMap(d.Object, "spec", "selector")
	if err != nil || !found {
		return nil, ErrIncomplete
	}
	selector := &metav1.LabelSelector{}
	if runtime.DefaultUnstructuredConverter.FromUnstructured(raw, selector) != nil || len(selector.MatchLabels)+len(selector.MatchExpressions) == 0 || len(selector.MatchLabels)+len(selector.MatchExpressions) > 32 {
		return nil, ErrIncomplete
	}
	for _, expression := range selector.MatchExpressions {
		if len(expression.Values) > 32 {
			return nil, ErrIncomplete
		}
	}
	parsed, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return nil, ErrIncomplete
	}
	return c.list(ctx, podGVR, s.SystemNamespace, parsed.String())
}

func metadataObservation(o *unstructured.Unstructured, kind string) ResourceObservation {
	r := ResourceObservation{UID: string(o.GetUID()), Kind: kind, Namespace: o.GetNamespace(), ResourceVersion: o.GetResourceVersion(), Phase: str(o, "status", "phase")}
	created := o.GetCreationTimestamp()
	if !created.IsZero() {
		ts := created.UTC()
		r.CreatedAt = &ts
	}
	if deleted := o.GetDeletionTimestamp(); deleted != nil {
		ts := deleted.UTC()
		r.DeletionRequestedAt = &ts
	}
	return r
}

func runnerObservation(o *unstructured.Unstructured) ResourceObservation {
	r := metadataObservation(o, "runner")
	j := &JobIdentity{Repository: str(o, "status", "jobRepositoryName"), WorkflowRunID: number(o, "status", "workflowRunId"), JobID: str(o, "status", "jobId"), RunnerID: number(o, "status", "runnerId"), Provenance: "arc-status"}
	if j.Repository != "" || j.WorkflowRunID > 0 || j.JobID != "" {
		r.Job = j
	}
	return r
}

type observedPod struct {
	index int
	pod   *corev1.Pod
}

func appendPodObservations(u *UsageSnapshot, objects []unstructured.Unstructured, kind string) ([]observedPod, error) {
	pods := make([]observedPod, 0, len(objects))
	for i := range objects {
		o := &objects[i]
		r := metadataObservation(o, kind)
		pod := &corev1.Pod{}
		if runtime.DefaultUnstructuredConverter.FromUnstructured(o.Object, pod) != nil {
			return nil, ErrIncomplete
		}
		r.CPURequestMillis, r.MemoryRequestBytes = podRequests(pod)
		r.RuntimeStartedAt, r.RuntimeFinishedAt = podRuntimeTimes(pod)
		for _, ref := range o.GetOwnerReferences() {
			if ref.Controller != nil && *ref.Controller {
				r.OwnerUID = string(ref.UID)
			}
		}
		pods = append(pods, observedPod{index: len(u.Resources), pod: pod})
		u.Resources = append(u.Resources, r)
	}
	return pods, nil
}

func (c KubernetesCollector) usageNodes(ctx context.Context, pods []observedPod) (inventory map[string]*unstructured.Unstructured, completeInventory bool, collectionErr error) {
	nodes := map[string]*unstructured.Unstructured{}
	complete := false
	if len(c.Usage.DedicatedNodePools) > 0 {
		selector := nodePoolLabel + " in (" + strings.Join(c.Usage.DedicatedNodePools, ",") + ")"
		items, err := c.list(ctx, nodeGVR, "", selector)
		if err != nil {
			return nil, false, err
		}
		for i := range items {
			n := &items[i]
			nodes[n.GetName()] = n
		}
		complete = true
	}
	for _, p := range pods {
		name := p.pod.Spec.NodeName
		if name == "" || nodes[name] != nil {
			continue
		}
		if len(nodes) >= 32 {
			return nil, false, ErrIncomplete
		}
		n, err := c.Client.Resource(nodeGVR).Get(ctx, name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, false, readError(err)
		}
		nodes[name] = n
	}
	return nodes, complete, nil
}

func attachNodes(u *UsageSnapshot, nodes map[string]*unstructured.Unstructured, pods []observedPod, cfg *UsageConfig) error {
	if len(nodes) > 32 {
		return ErrIncomplete
	}
	for _, p := range pods {
		if n := nodes[p.pod.Spec.NodeName]; n != nil {
			u.Resources[p.index].NodeUID = string(n.GetUID())
		}
	}
	for _, n := range nodes {
		r := metadataObservation(n, "node")
		r.NodeClass = "shared"
		r.NodePool = n.GetLabels()[nodePoolLabel]
		// Selection proves configured pool membership; shared application nodes
		// are retained separately and never charged as newly incurred CI nodes.
		for _, pool := range cfg.DedicatedNodePools {
			if r.NodePool == pool {
				r.NodeClass = "dedicated-ci"
			}
		}
		r.MachineType = n.GetLabels()["node.kubernetes.io/instance-type"]
		r.PurchaseModel = "unknown"
		if n.GetLabels()["cloud.google.com/gke-spot"] == "true" {
			r.PurchaseModel = "spot"
		}
		u.Resources = append(u.Resources, r)
	}
	return nil
}

// Pod resource accounting follows scheduler requests: steady containers plus
// restartable init sidecars, maximum sequential init demand, and pod overhead.
func podRequests(p *corev1.Pod) (cpu, memory int64) {
	for i := range p.Spec.Containers {
		c := &p.Spec.Containers[i]
		cpu += c.Resources.Requests.Cpu().MilliValue()
		memory += c.Resources.Requests.Memory().Value()
	}
	var sideCPU, sideMemory, initCPU, initMemory int64
	for i := range p.Spec.InitContainers {
		c := &p.Spec.InitContainers[i]
		cCPU, cMemory := c.Resources.Requests.Cpu().MilliValue(), c.Resources.Requests.Memory().Value()
		if c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways {
			sideCPU += cCPU
			sideMemory += cMemory
		} else {
			initCPU = max(initCPU, sideCPU+cCPU)
			initMemory = max(initMemory, sideMemory+cMemory)
		}
	}
	cpu = max(cpu+sideCPU, initCPU)
	memory = max(memory+sideMemory, initMemory)
	if p.Spec.Resources != nil {
		if q, ok := p.Spec.Resources.Requests[corev1.ResourceCPU]; ok {
			cpu = q.MilliValue()
		}
		if q, ok := p.Spec.Resources.Requests[corev1.ResourceMemory]; ok {
			memory = q.Value()
		}
	}
	return cpu + p.Spec.Overhead.Cpu().MilliValue(), memory + p.Spec.Overhead.Memory().Value()
}

func containerRuntimeTimes(c *corev1.ContainerStatus) (start, finish time.Time, terminated bool) {
	if c.State.Running != nil {
		return c.State.Running.StartedAt.Time, time.Time{}, false
	}
	if c.State.Terminated != nil {
		return c.State.Terminated.StartedAt.Time, c.State.Terminated.FinishedAt.Time, true
	}
	return time.Time{}, time.Time{}, false
}
func podRuntimeTimes(p *corev1.Pod) (start, finish *time.Time) {
	finished := len(p.Status.ContainerStatuses) > 0
	for i := range p.Status.ContainerStatuses {
		began, ended, terminated := containerRuntimeTimes(&p.Status.ContainerStatuses[i])
		finished = finished && terminated
		if !began.IsZero() && (start == nil || began.Before(*start)) {
			ts := began.UTC()
			start = &ts
		}
		if !ended.IsZero() && (finish == nil || ended.After(*finish)) {
			ts := ended.UTC()
			finish = &ts
		}
	}
	if !finished {
		finish = nil
	}
	return
}

func appendUsagePods(u *UsageSnapshot, snap *Snapshot, controllerPods []unstructured.Unstructured) ([]observedPod, error) {
	pods := []observedPod{}
	lists := []struct {
		kind    string
		objects []unstructured.Unstructured
	}{{"runner-pod", snap.RunnerPods}, {"listener-pod", snap.SystemPods}, {"controller-pod", controllerPods}}
	for _, list := range lists {
		observed, err := appendPodObservations(u, list.objects, list.kind)
		if err != nil {
			return nil, err
		}
		pods = append(pods, observed...)
	}
	return pods, nil
}

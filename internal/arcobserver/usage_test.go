package arcobserver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
)

func usageFixture(t *testing.T) (KubernetesCollector, Snapshot) {
	t.Helper()
	snap := fixture(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	addWorker(&snap, "Running", "Running")
	for _, r := range []*unstructured.Unstructured{snap.RunnerSet, snap.Controller, &snap.RunnerPods[0], &snap.SystemPods[0], &snap.EphemeralRunners[0]} {
		r.SetResourceVersion("1")
	}
	set(&snap.EphemeralRunners[0], "example/infrastructure", "status", "jobRepositoryName")
	set(&snap.EphemeralRunners[0], int64(123), "status", "workflowRunId")
	set(&snap.EphemeralRunners[0], "456", "status", "jobId")
	set(&snap.EphemeralRunners[0], int64(7), "status", "runnerId")
	set(snap.Controller, map[string]any{"app": "controller"}, "spec", "selector", "matchLabels")
	cp := object("Pod", "systems", "controller-pod", "controller-pod-id")
	cp.SetAPIVersion("v1")
	cp.SetResourceVersion("1")
	cp.SetLabels(map[string]string{"app": "controller"})
	set(cp, "Running", "status", "phase")
	set(cp, "node-app", "spec", "nodeName")
	set(&snap.SystemPods[0], "node-app", "spec", "nodeName")
	set(&snap.RunnerPods[0], []any{map[string]any{"name": "runner", "image": "example", "resources": map[string]any{"requests": map[string]any{"cpu": "1", "memory": "1Gi"}}, "env": []any{map[string]any{"name": "SECRET", "value": "environment-canary"}}}}, "spec", "containers")
	ns := object("Namespace", "", "kube-system", "cluster-uid")
	ns.SetAPIVersion("v1")
	node := object("Node", "", "node-a", "node-id")
	node.SetAPIVersion("v1")
	node.SetResourceVersion("1")
	node.SetLabels(map[string]string{nodePoolLabel: "ci", "node.kubernetes.io/instance-type": "c4-standard-8", "cloud.google.com/gke-spot": "true"})
	app := object("Node", "", "node-app", "app-node-id")
	app.SetAPIVersion("v1")
	app.SetResourceVersion("1")
	app.SetLabels(map[string]string{nodePoolLabel: "apps"})
	objects := []runtime.Object{snap.RunnerSet, snap.Controller, &snap.RunnerPods[0], &snap.SystemPods[0], &snap.EphemeralRunners[0], cp, ns, node, app}
	kinds := map[schema.GroupVersionResource]string{runnerSetGVR: "AutoscalingRunnerSetList", runnerGVR: "EphemeralRunnerList", podGVR: "PodList", deploymentGVR: "DeploymentList", nodeGVR: "NodeList", namespaceGVR: "NamespaceList"}
	client := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), kinds, objects...)
	return KubernetesCollector{Client: client, Usage: &UsageConfig{ClusterID: "cluster", ClusterUID: "cluster-uid", DedicatedNodePools: []string{"ci"}}}, snap
}
func TestARCUsage_ProtocolProjectionRedactionAndReadBoundaries(t *testing.T) {
	c, snap := usageFixture(t)
	source := testSource()
	usage, err := c.collectUsage(context.Background(), &source, &snap)
	if err != nil {
		t.Fatal(err)
	}
	snap.Usage = usage
	o, err := Project(&source, &snap, snap.ObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	assertUsageRedaction(t, raw)
	if len(usage.Resources) != 6 || !usage.NodeInventoryComplete {
		t.Fatalf("incorrect resources: %+v", usage)
	}
	assertUsageResources(t, usage)
	client, ok := c.Client.(*fake.FakeDynamicClient)
	if !ok {
		t.Fatal("fixture client")
	}
	for _, a := range client.Actions() {
		if a.GetVerb() != "get" && a.GetVerb() != "list" {
			t.Fatal("write attempted")
		}
		if a.GetResource() == nodeGVR && a.GetVerb() == "list" {
			la, ok := a.(ktesting.ListAction)
			if !ok || la.GetListRestrictions().Labels.String() != nodePoolLabel+" in (ci)" {
				t.Fatal("unbounded node list")
			}
		}
	}
	golden := "testdata/arc-usage-observation.json"
	if os.Getenv("UPDATE_ARC_USAGE_FIXTURE") == "1" {
		if err = os.WriteFile(golden, append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	expected, err := os.ReadFile(golden)
	if err != nil || strings.TrimSpace(string(raw)) != strings.TrimSpace(string(expected)) {
		t.Fatal("wire protocol fixture changed", err)
	}
}
func TestARCUsage_IdentityDenialAndUnknownIDs(t *testing.T) {
	c, snap := usageFixture(t)
	source := testSource()
	c.Usage.ClusterUID = "other"
	if _, err := c.collectUsage(context.Background(), &source, &snap); !errors.Is(err, ErrIncomplete) {
		t.Fatal("wrong cluster accepted", err)
	}
	c.Usage.ClusterUID = "cluster-uid"
	client, ok := c.Client.(*fake.FakeDynamicClient)
	if !ok {
		t.Fatal("fixture client")
	}
	client.PrependReactor("get", "nodes", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "nodes"}, "fixture", errors.New("private-canary"))
	})
	if _, err := c.collectUsage(context.Background(), &source, &snap); !errors.Is(err, ErrDenied) || strings.Contains(err.Error(), "canary") {
		t.Fatal("node denial did not fail closed", err)
	}
	r := object("EphemeralRunner", "runners", "unknown", "unknown-id")
	if runnerObservation(r).Job != nil {
		t.Fatal("invented GitHub identity")
	}
}
func TestARCUsage_PodRequestsAndRuntimeTimes(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	requests := func(cpu, mem string) corev1.ResourceRequirements {
		return corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpu), corev1.ResourceMemory: resource.MustParse(mem)}}
	}
	p := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Resources: requests("1", "1Gi")}}, InitContainers: []corev1.Container{{RestartPolicy: &always, Resources: requests("500m", "512Mi")}, {Resources: requests("2", "2Gi")}}, Overhead: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m")}}}
	cpu, mem := podRequests(p)
	if cpu != 2600 || mem != 2560<<20 {
		t.Fatal("scheduler requests incorrect", cpu, mem)
	}
	at := time.Now().UTC().Truncate(time.Second)
	p.Status.ContainerStatuses = []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{StartedAt: metav1.NewTime(at), FinishedAt: metav1.NewTime(at.Add(time.Minute))}}}}
	start, finish := podRuntimeTimes(p)
	if start == nil || finish == nil || finish.Sub(*start) != time.Minute {
		t.Fatal("runtime timestamps lost")
	}
	p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{})
	_, finish = podRuntimeTimes(p)
	if finish != nil {
		t.Fatal("unfinished container inferred complete")
	}
}

func assertUsageResources(t *testing.T, usage *UsageSnapshot) {
	t.Helper()
	for _, r := range usage.Resources {
		if r.Kind == "runner" && (r.Job == nil || r.Job.WorkflowRunID != 123 || r.Job.JobID != "456" || r.Job.Provenance != "arc-status") {
			t.Fatal("actual ARC IDs not preserved")
		}
		if r.Kind == "runner-pod" && (r.OwnerUID != "runner-id" || r.NodeUID != "node-id" || r.CPURequestMillis != 1000 || r.MemoryRequestBytes != 1<<30) {
			t.Fatal("pod mapping lost")
		}
		if r.UID == "app-node-id" && r.NodeClass != "shared" {
			t.Fatal("shared app baseline misclassified")
		}
	}
}
func TestARCUsage_ControllerSelectorExpressionsExcludeOtherPods(t *testing.T) {
	c, snap := usageFixture(t)
	set(snap.Controller, []any{map[string]any{"key": "release", "operator": "In", "values": []any{"v2"}}}, "spec", "selector", "matchExpressions")
	cp := object("Pod", "systems", "v2-controller", "v2-uid")
	cp.SetAPIVersion("v1")
	cp.SetLabels(map[string]string{"app": "controller", "release": "v2"})
	if _, err := c.Client.Resource(podGVR).Namespace("systems").Create(context.Background(), cp, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	source := testSource()
	pods, err := c.controllerPods(context.Background(), &source, snap.Controller)
	if err != nil || len(pods) != 1 || string(pods[0].GetUID()) != "v2-uid" {
		t.Fatal("selector expression ignored", err, len(pods))
	}
}

func assertUsageRedaction(t *testing.T, raw []byte) {
	t.Helper()
	if strings.Contains(string(raw), "canary") || strings.Contains(string(raw), "jobWorkflowRef") || strings.Contains(string(raw), "githubToken") {
		t.Fatal("raw job/credential data leaked")
	}
}

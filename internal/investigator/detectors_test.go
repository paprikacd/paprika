package investigator

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func podManifest(status corev1.PodStatus) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]interface{}{}}
	u.SetKind("Pod")
	u.SetAPIVersion("v1")
	u.SetName("demo-pod")
	u.SetNamespace("demo-ns")
	u.Object["spec"] = map[string]interface{}{
		"containers": []interface{}{
			map[string]interface{}{"name": "app", "image": "demo/app:1"},
		},
	}
	// Marshal through converter round-trip so the detector can decode.
	return u
}

// We rely on fromUnstructured needing a meaningful object. Build a fully-formed
// Pod via runtime.NewScheme so detector tests stay representative.
func podFixture(t *testing.T, status corev1.PodStatus) *unstructured.Unstructured {
	t.Helper()
	pod := corev1.Pod{
		TypeMeta: metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "demo-pod", Namespace: "demo-ns"},
		Spec: corev1.PodSpec{Containers: []corev1.Container{
			{Name: "app", Image: "demo/app:1"},
		}},
		Status: status,
	}
	u, err := runtimeToUnstructured(&pod)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestCrashLoopDetector_FiresOnRestarts(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Pod", Name: "demo-pod", Namespace: "demo-ns"},
		LiveManifest: podFixture(t, corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name:         "app",
					RestartCount: 5,
					State:        corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
				},
			},
		}),
	}
	f, err := (&CrashLoopDetector{}).Detect(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 1 || f[0].Severity != SeverityCritical || f[0].ID != "crash_loop_app" {
		t.Fatalf("unexpected finding: %+v", f)
	}
}

func TestCrashLoopDetector_DoesNotFireOnHealthy(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Pod", Name: "demo-pod", Namespace: "demo-ns"},
		LiveManifest: podFixture(t, corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "app", RestartCount: 0, Ready: true},
			},
		}),
	}
	f, err := (&CrashLoopDetector{}).Detect(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 0 {
		t.Fatalf("did not expect finding, got %+v", f)
	}
}

func TestOOMKilledDetector_FiresOnTerminatedState(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Pod", Name: "demo-pod"},
		LiveManifest: podFixture(t, corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name: "app",
					LastTerminationState: corev1.ContainerState{
						Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137},
					},
				},
			},
		}),
	}
	f, err := (&OOMKilledDetector{}).Detect(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 1 || f[0].Severity != SeverityCritical {
		t.Fatalf("unexpected: %+v", f)
	}
}

func TestDeploymentReplicasDetector_ZeroReadyEscalates(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Deployment", Name: "demo-deploy", Namespace: "demo-ns"},
		LiveManifest: deployFixture(t, 3, 0),
	}
	f, err := (&DeploymentReplicasDriftDetector{}).Detect(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 1 || f[0].Severity != SeverityCritical {
		t.Fatalf("zero-ready should escalate to Critical, got %+v", f)
	}
	if f[0].Title != "Deployment has 0 ready replicas (outage)" {
		t.Fatalf("title: %q", f[0].Title)
	}
}

func TestDeploymentReplicasDetector_PartialReplicasIsWarning(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Deployment", Name: "demo-deploy", Namespace: "demo-ns"},
		LiveManifest: deployFixture(t, 3, 1),
	}
	f, err := (&DeploymentReplicasDriftDetector{}).Detect(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 1 || f[0].Severity != SeverityWarning {
		t.Fatalf("partial should be Warning, got %+v", f)
	}
}

func TestDeploymentReplicasDetector_NoDrift(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Deployment", Name: "demo-deploy"},
		LiveManifest: deployFixture(t, 3, 3),
	}
	f, err := (&DeploymentReplicasDriftDetector{}).Detect(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 0 {
		t.Fatalf("did not expect finding, got %+v", f)
	}
}

func TestConfigDriftDetector_FiresOnNonEmptyDiff(t *testing.T) {
	in := Input{Ref: ResourceRef{Name: "demo-deploy"}, Diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n"}
	f, _ := (&ConfigDriftDetector{}).Detect(context.Background(), in)
	if len(f) != 1 {
		t.Fatalf("expected drift finding, got %d", len(f))
	}
}

func TestConfigDriftDetector_NoFindingsForEmptyDiff(t *testing.T) {
	f, _ := (&ConfigDriftDetector{}).Detect(context.Background(), Input{Ref: ResourceRef{Name: "x"}})
	if len(f) != 0 {
		t.Fatalf("did not expect finding, got %d", len(f))
	}
}

func TestForbiddenRbacDetector_FiresOnForbiddenEvents(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Deployment", Name: "demo-deploy", Namespace: "demo-ns"},
		Events: []KubernetesEvent{
			{Type: "Warning", Reason: "Forbidden", Message: "cannot list pods", ObjectKind: "Deployment", ObjectName: "demo-deploy", ObjectNamespace: "demo-ns"},
		},
	}
	f, _ := (&ForbiddenRbacDetector{}).Detect(context.Background(), in)
	if len(f) != 1 || f[0].Severity != SeverityWarning {
		t.Fatalf("unexpected: %+v", f)
	}
}

func TestForbiddenRbacDetector_IgnoresOtherReasons(t *testing.T) {
	in := Input{
		Ref: ResourceRef{Kind: "Pod", Name: "demo-deploy"},
		Events: []KubernetesEvent{
			{Type: "Warning", Reason: "FailedScheduling", ObjectKind: "Pod", ObjectName: "demo-deploy"},
		},
	}
	f, _ := (&ForbiddenRbacDetector{}).Detect(context.Background(), in)
	if len(f) != 0 {
		t.Fatalf("did not expect finding")
	}
}

func TestImagePullDetector_FiresOnFailedEvents(t *testing.T) {
	in := Input{
		Ref:          ResourceRef{Kind: "Pod", Name: "demo-pod", Namespace: "demo-ns"},
		LiveManifest: podFixture(t, corev1.PodStatus{}),
		Events: []KubernetesEvent{
			{Type: "Warning", Reason: "Failed", Message: "ErrImagePull: image not found", ObjectKind: "Pod", ObjectName: "demo-pod", ObjectNamespace: "demo-ns"},
			{Type: "Warning", Reason: "BackOff", Message: "pull access denied", ObjectKind: "Pod", ObjectName: "demo-pod", ObjectNamespace: "demo-ns"},
		},
	}
	f, _ := (&ImagePullDetector{}).Detect(context.Background(), in)
	if len(f) != 1 || f[0].Severity != SeverityCritical || len(f[0].Evidence) != 2 {
		t.Fatalf("unexpected: %+v", f)
	}
}

func TestPendingSchedulingDetector_FiresOnPendingPhase(t *testing.T) {
	in := Input{
		Ref:          ResourceRef{Kind: "Pod", Name: "demo-pod", Namespace: "demo-ns"},
		LiveManifest: podPending(t, "Pending"),
		Events: []KubernetesEvent{
			{Type: "Warning", Reason: "FailedScheduling", Message: "0/3 nodes are available", ObjectKind: "Pod", ObjectName: "demo-pod"},
		},
	}
	f, _ := (&PendingSchedulingDetector{}).Detect(context.Background(), in)
	if len(f) != 1 || f[0].Severity != SeverityWarning {
		t.Fatalf("unexpected: %+v", f)
	}
}

func TestPendingSchedulingDetector_IgnoresRunning(t *testing.T) {
	in := Input{
		Ref:          ResourceRef{Kind: "Pod", Name: "demo-pod"},
		LiveManifest: podPending(t, "Running"),
		Events: []KubernetesEvent{
			{Type: "Warning", Reason: "FailedScheduling", ObjectKind: "Pod", ObjectName: "demo-pod"},
		},
	}
	f, _ := (&PendingSchedulingDetector{}).Detect(context.Background(), in)
	if len(f) != 0 {
		t.Fatalf("did not expect finding")
	}
}

func TestEndpointMismatchDetector_FiresWhenNoMatchingPods(t *testing.T) {
	svc := svcFixture(t, map[string]string{"app": "demo"})
	in := Input{Ref: ResourceRef{Kind: "Service", Name: "demo-svc", Namespace: "demo-ns"}, LiveManifest: svc}
	f, _ := (&EndpointMismatchDetector{}).Detect(context.Background(), in)
	if len(f) != 1 || f[0].Severity != SeverityInfo {
		t.Fatalf("expected info finding, got %+v", f)
	}
}

func TestEndpointMismatchDetector_SkipsWhenPodReferenced(t *testing.T) {
	svc := svcFixture(t, map[string]string{"app": "demo"})
	in := Input{
		Ref:          ResourceRef{Kind: "Service", Name: "demo-svc"},
		LiveManifest: svc,
		Events:       []KubernetesEvent{{ObjectKind: "Pod", ObjectName: "demo-pod-1"}},
	}
	f, _ := (&EndpointMismatchDetector{}).Detect(context.Background(), in)
	if len(f) != 0 {
		t.Fatalf("did not expect finding")
	}
}

// Helpers — see also registry_test.go.

func deployFixture(t *testing.T, replicas, ready int32) *unstructured.Unstructured {
	t.Helper()
	r := replicas
	d := appsv1Deployment("demo-deploy", "demo-ns", &r, ready)
	u, err := runtimeToUnstructured(&d)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func podPending(t *testing.T, phase corev1.PodPhase) *unstructured.Unstructured {
	t.Helper()
	pod := corev1.Pod{
		TypeMeta: metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "demo-pod", Namespace: "demo-ns"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "demo/app:1"}}},
		Status:     corev1.PodStatus{Phase: phase},
	}
	u, err := runtimeToUnstructured(&pod)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func svcFixture(t *testing.T, sel map[string]string) *unstructured.Unstructured {
	t.Helper()
	svc := corev1.Service{
		TypeMeta: metav1.TypeMeta{Kind: "Service", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "demo-svc", Namespace: "demo-ns"},
		Spec: corev1.ServiceSpec{
			Selector: sel,
			Ports:    []corev1.ServicePort{{Port: 80}},
		},
	}
	u, err := runtimeToUnstructured(&svc)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

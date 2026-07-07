package apiserver

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func newInvestigatorServer(t *testing.T, dynamicObjs []runtime.Object) *PaprikaServer {
	t.Helper()
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(s))

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase: "Degraded",
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "demo-deploy", Namespace: "test-ns", Status: "OutOfSync"},
			},
		},
	}
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(app).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
	dyn := dynamicfake.NewSimpleDynamicClient(s, dynamicObjs...)
	k8s := k8sfake.NewSimpleClientset()
	return NewPaprikaServer(c, nil, WithDynamicClient(dyn), WithK8sClient(k8s))
}

func TestInvestigate_AppNotFound(t *testing.T) {
	srv := newInvestigatorServer(t, nil)
	_, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "missing",
		ResourceKind:         "Deployment",
		ResourceName:         "demo-deploy",
		ResourceNamespace:    "test-ns",
	}))
	require.Error(t, err)
}

func TestInvestigate_DeploymentAllClear(t *testing.T) {
	tail := int32(3)
	srv := newInvestigatorServer(t, []runtime.Object{
		&appsv1.Deployment{
			TypeMeta:   metav1.TypeMeta{Kind: "Deployment", APIVersion: "apps/v1"},
			ObjectMeta: metav1.ObjectMeta{Name: "demo-deploy", Namespace: "test-ns"},
			Spec:       appsv1.DeploymentSpec{Replicas: &tail},
			Status:     appsv1.DeploymentStatus{Replicas: 3, ReadyReplicas: 3},
		},
	})
	_ = tail
	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Deployment",
		ResourceName:         "demo-deploy",
		ResourceNamespace:    "test-ns",
	}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)
	require.Equal(t, "All clear", resp.Msg.Summary)
	require.Equal(t, "deterministic", resp.Msg.Narrator)
}

func TestInvestigate_DeploymentZeroReadyCritical(t *testing.T) {
	tail := int32(3)
	srv := newInvestigatorServer(t, []runtime.Object{
		&appsv1.Deployment{
			TypeMeta:   metav1.TypeMeta{Kind: "Deployment", APIVersion: "apps/v1"},
			ObjectMeta: metav1.ObjectMeta{Name: "demo-deploy", Namespace: "test-ns"},
			Spec:       appsv1.DeploymentSpec{Replicas: &tail},
			Status:     appsv1.DeploymentStatus{Replicas: 3, ReadyReplicas: 0},
		},
	})
	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Deployment",
		ResourceName:         "demo-deploy",
		ResourceNamespace:    "test-ns",
	}))
	require.NoError(t, err)
	found := false
	for _, f := range resp.Msg.Findings {
		if f.Id == "deployment_replicas_demo-deploy" && f.Severity == paprikav1.Severity_CRITICAL { //nolint:staticcheck
			found = true
		}
	}
	require.True(t, found, "expected critical replicas drift finding; got %+v", resp.Msg.Findings)
}

func TestInvestigate_PodCrashLoop(t *testing.T) {
	tail := int32(5)
	srv := newInvestigatorServer(t, []runtime.Object{
		&corev1.Pod{
			TypeMeta: metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: "demo-pod", Namespace: "test-ns"},
			Spec: corev1.PodSpec{
				Containers: []corev1.Container{{Name: "app", Image: "demo:1"}},
			},
			Status: corev1.PodStatus{
				Phase: corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{
					{
						Name:         "app",
						RestartCount: tail,
						State:        corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
					},
				},
			},
		},
	})
	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "test-ns",
		ApplicationName:      "demo-app",
		ResourceKind:         "Pod",
		ResourceName:         "demo-pod",
		ResourceNamespace:    "test-ns",
	}))
	require.NoError(t, err)
	found := false
	for _, f := range resp.Msg.Findings {
		if f.Id == "crash_loop_app" && f.Severity == paprikav1.Severity_CRITICAL { //nolint:staticcheck
			found = true
		}
	}
	require.True(t, found, "expected CrashLoop finding; got %+v", resp.Msg.Findings)
}

func TestListInvestigatorPlugins(t *testing.T) {
	srv := newInvestigatorServer(t, nil)
	resp, err := srv.ListInvestigatorPlugins(context.Background(), connect.NewRequest(&paprikav1.ListInvestigatorPluginsRequest{}))
	require.NoError(t, err)
	want := map[string]bool{"manifest": false, "events": false, "logs": false}
	for _, det := range []struct {
		id, kind string
	}{{"crash_loop", "detector"}, {"oom_killed", "detector"}, {"deployment_replicas_drift", "detector"}} {
		want[det.id] = false
		_ = want
	}
	got := map[string]bool{}
	for _, p := range resp.Msg.Plugins {
		if p.Type == "source" {
			got[p.Name] = true
		}
	}
	require.True(t, got["manifest"], "expected manifest source in plugins")
	require.True(t, got["events"], "expected events source in plugins")
	require.True(t, got["logs"], "expected logs source in plugins")
	count := 0
	for _, p := range resp.Msg.Plugins {
		if p.Type == "detector" {
			count++
		}
	}
	require.Equal(t, 8, count, "8 detectors expected")
	for _, p := range resp.Msg.Plugins {
		if p.Type == "narrator" {
			require.Equal(t, "deterministic", p.Name)
		}
	}
}

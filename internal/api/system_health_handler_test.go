package apiserver

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlclientfake "sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestGetSystemHealthReportsHealthyControlPlane(t *testing.T) {
	t.Parallel()

	app := systemHealthApplication("tenant", "checkout", "payments", 1, 1, false)
	server := systemHealthServer(t, app, nil, 1, 0)

	response, err := server.GetSystemHealth(context.Background(), connect.NewRequest(&paprikav1.GetSystemHealthRequest{}))
	require.NoError(t, err)
	require.Equal(t, "healthy", response.Msg.GetStatus())
	require.Equal(t, uint64(1), response.Msg.GetApplicationsTotal())
	require.Equal(t, uint64(1), response.Msg.GetApplicationsHealthy())
	require.Zero(t, response.Msg.GetApplicationsStale())
	require.Zero(t, response.Msg.GetApplicationsReleaseRetriesExhausted())
	require.Zero(t, response.Msg.GetReleasesStuck())
	require.True(t, response.Msg.GetController().GetPresent())
	require.True(t, response.Msg.GetController().GetReady())
	require.False(t, response.Msg.GetFleetIndexDegraded())
	require.NotEmpty(t, response.Msg.GetChecks())
	for _, check := range response.Msg.GetChecks() {
		assert.Equal(t, "pass", check.GetStatus(), check.GetName())
	}
}

func TestGetSystemHealthReportsDegradedLagAndStuckRelease(t *testing.T) {
	t.Parallel()

	app := systemHealthApplication("tenant", "checkout", "payments", 3, 2, true)
	release := systemHealthRelease("tenant", "checkout-release", "checkout", pipelinesv1alpha1.ReleaseCanarying, time.Hour)
	release.Status.Phase = pipelinesv1alpha1.ReleaseCanarying
	server := systemHealthServer(t, app, release, 1, 2)

	response, err := server.GetSystemHealth(context.Background(), connect.NewRequest(&paprikav1.GetSystemHealthRequest{}))
	require.NoError(t, err)
	require.Equal(t, "degraded", response.Msg.GetStatus())
	require.Equal(t, uint64(1), response.Msg.GetApplicationsStale())
	require.Equal(t, uint64(1), response.Msg.GetApplicationsReleaseRetriesExhausted())
	require.Equal(t, uint64(1), response.Msg.GetReleasesStuck())
	require.Len(t, response.Msg.GetStaleApplications(), 1)
	require.Equal(t, uint64(1), response.Msg.GetStaleApplications()[0].GetLagGenerations())
	require.Len(t, response.Msg.GetStuckReleases(), 1)
	require.Equal(t, "Canarying", response.Msg.GetStuckReleases()[0].GetPhase())
	require.Equal(t, uint32(2), response.Msg.GetController().GetRestartCount())

	byName := map[string]string{}
	for _, check := range response.Msg.GetChecks() {
		byName[check.GetName()] = check.GetStatus()
	}
	assert.Equal(t, "warn", byName["application_reconcile"])
	assert.Equal(t, "warn", byName["release_retries"])
	assert.Equal(t, "warn", byName["releases_stuck"])
	assert.Equal(t, "warn", byName["controller_manager"])
}

func TestGetSystemHealthFailsWhenControllerNotReady(t *testing.T) {
	t.Parallel()

	app := systemHealthApplication("tenant", "checkout", "payments", 1, 1, false)
	server := systemHealthServer(t, app, nil, 0, 0)

	response, err := server.GetSystemHealth(context.Background(), connect.NewRequest(&paprikav1.GetSystemHealthRequest{}))
	require.NoError(t, err)
	require.Equal(t, "failed", response.Msg.GetStatus())
	require.False(t, response.Msg.GetController().GetReady())
}

func TestGetSystemHealthDoesNotFlagAwaitingApprovalAsStuck(t *testing.T) {
	t.Parallel()

	app := systemHealthApplication("tenant", "checkout", "payments", 1, 1, false)
	release := systemHealthRelease(
		"tenant", "checkout-release", "checkout", pipelinesv1alpha1.ReleaseAwaitingApproval, 2*time.Hour,
	)
	server := systemHealthServer(t, app, release, 1, 0)

	response, err := server.GetSystemHealth(context.Background(), connect.NewRequest(&paprikav1.GetSystemHealthRequest{}))
	require.NoError(t, err)
	require.Zero(t, response.Msg.GetReleasesStuck())
}

func TestGetSystemHealthValidatesStuckReleaseSeconds(t *testing.T) {
	t.Parallel()

	server := NewPaprikaServer(nil, nil)
	tests := map[string]struct {
		request  *connect.Request[paprikav1.GetSystemHealthRequest]
		wantCode connect.Code
	}{
		"nil request":      {request: nil, wantCode: connect.CodeInvalidArgument},
		"below minimum":    {request: connect.NewRequest(&paprikav1.GetSystemHealthRequest{StuckReleaseSeconds: 30}), wantCode: connect.CodeInvalidArgument},
		"above maximum":    {request: connect.NewRequest(&paprikav1.GetSystemHealthRequest{StuckReleaseSeconds: 86401}), wantCode: connect.CodeInvalidArgument},
		"default accepted": {request: connect.NewRequest(&paprikav1.GetSystemHealthRequest{}), wantCode: connect.CodeUnavailable},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := server.GetSystemHealth(context.Background(), test.request)
			require.Equal(t, test.wantCode, connect.CodeOf(err))
		})
	}
}

func systemHealthApplication(
	namespace, name, project string, generation, observedGeneration int64, retriesExhausted bool,
) *pipelinesv1alpha1.Application {
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace, Name: name, Generation: generation,
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{Project: project},
		Status: pipelinesv1alpha1.ApplicationStatus{
			ObservedGeneration: observedGeneration,
			Phase:              pipelinesv1alpha1.ApplicationHealthy,
		},
	}
	if retriesExhausted {
		app.Status.Conditions = []metav1.Condition{{
			Type: pipelinesv1alpha1.ConditionReleaseRetriesExhausted, Status: metav1.ConditionTrue,
			Reason: "Exhausted", LastTransitionTime: metav1.Now(),
		}}
	}
	return app
}

func systemHealthRelease(
	namespace, name, application string, phase pipelinesv1alpha1.ReleasePhase, age time.Duration,
) *pipelinesv1alpha1.Release {
	controller := true
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace, Name: name,
			CreationTimestamp: metav1.NewTime(time.Now().Add(-age)),
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(), Kind: "Application",
				Name: application, Controller: &controller,
			}},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{Phase: phase},
	}
}

func systemHealthServer(
	t *testing.T,
	app *pipelinesv1alpha1.Application,
	release *pipelinesv1alpha1.Release,
	readyReplicas int32,
	restarts int32,
) *PaprikaServer {
	t.Helper()

	objects := []client.Object{app}
	if release != nil {
		objects = append(objects, release)
	}
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	ctrlClient := ctrlclientfake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()

	replicas := int32(1)
	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "paprika-e2e", Name: "paprika-e2e-controller-manager",
			Labels: map[string]string{"control-plane": "controller-manager"},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"control-plane": "controller-manager"}},
		},
		Status: appsv1.DeploymentStatus{ReadyReplicas: readyReplicas, AvailableReplicas: readyReplicas},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "paprika-e2e", Name: "paprika-e2e-controller-manager-0",
			Labels: map[string]string{"control-plane": "controller-manager"},
		},
		Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{RestartCount: restarts}}},
	}
	k8sClient := k8sfake.NewSimpleClientset(deployment, pod)

	snapshot := buildSystemStatusSnapshot(t, 3, []fleet.ApplicationSummary{
		systemStatusApplication(app.Namespace, app.Name, app.Spec.Project, fleet.HealthHealthy, fleet.SyncStateSynced),
	})
	return NewPaprikaServer(
		ctrlClient, nil,
		WithFleetIndex(&systemStatusReader{snapshot: snapshot}),
		WithK8sClient(k8sClient),
		WithControlPlaneNamespace("paprika-e2e"),
	)
}

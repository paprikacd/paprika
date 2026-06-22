package apiserver

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/stretchr/testify/require"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlfake "sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/events"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func newPipelineTestScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return scheme
}

func newPipelineTestClient(objs ...client.Object) client.Client {
	return ctrlfake.NewClientBuilder().
		WithScheme(newPipelineTestScheme()).
		WithObjects(objs...).
		WithStatusSubresource(&pipelinesv1alpha1.Pipeline{}).
		Build()
}

func TestGetPipeline(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "test-pipe", Namespace: "default", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Spec: pipelinesv1alpha1.PipelineSpec{
				Steps: []pipelinesv1alpha1.PipelineStep{{Name: "build", Image: "golang:1.22"}},
			},
		},
	)

	srv := NewPaprikaServer(cl, nil)
	resp, err := srv.GetPipeline(context.Background(), connect.NewRequest(&paprikav1.GetPipelineRequest{
		Name: "test-pipe", Namespace: "default",
	}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg.Pipeline)
	require.Equal(t, "test-pipe", resp.Msg.Pipeline.Name)
	require.Len(t, resp.Msg.Pipeline.Steps, 1)
}

func TestRetryStep_IdempotencyGuard(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Status: pipelinesv1alpha1.PipelineStatus{
				StepStatuses: []pipelinesv1alpha1.StepStatus{
					{Name: "build", Phase: pipelinesv1alpha1.StepRunning},
				},
			},
		},
	)

	srv := NewPaprikaServer(cl, nil)
	_, err := srv.RetryStep(context.Background(), connect.NewRequest(
		&paprikav1.RetryStepRequest{
			PipelineName: "p", PipelineNamespace: "ns", StepName: "build",
		}))
	require.Error(t, err)
	connErr, ok := err.(*connect.Error)
	require.True(t, ok)
	require.Equal(t, connect.CodeFailedPrecondition, connErr.Code())
	require.Contains(t, connErr.Message(), "Running")
}

func TestRetryStep_Success(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Status: pipelinesv1alpha1.PipelineStatus{
				StepStatuses: []pipelinesv1alpha1.StepStatus{
					{Name: "build", Phase: pipelinesv1alpha1.StepFailed, CompletedAt: &metav1.Time{Time: time.Unix(1000, 0)}},
				},
			},
		},
	)
	broker := events.NewBroker(logr.Discard())
	srv := NewPaprikaServer(cl, broker)

	_, err := srv.RetryStep(context.Background(), connect.NewRequest(
		&paprikav1.RetryStepRequest{
			PipelineName: "p", PipelineNamespace: "ns", StepName: "build",
		}))
	require.NoError(t, err)

	var updated pipelinesv1alpha1.Pipeline
	require.NoError(t, cl.Get(context.Background(), client.ObjectKey{Name: "p", Namespace: "ns"}, &updated))
	require.Equal(t, pipelinesv1alpha1.StepPending, updated.Status.StepStatuses[0].Phase)
	require.Nil(t, updated.Status.StepStatuses[0].CompletedAt)
}

func TestSkipStep_Success(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Status: pipelinesv1alpha1.PipelineStatus{
				StepStatuses: []pipelinesv1alpha1.StepStatus{
					{Name: "build", Phase: pipelinesv1alpha1.StepPending},
				},
			},
		},
	)
	broker := events.NewBroker(logr.Discard())
	srv := NewPaprikaServer(cl, broker)

	_, err := srv.SkipStep(context.Background(), connect.NewRequest(
		&paprikav1.SkipStepRequest{
			PipelineName: "p", PipelineNamespace: "ns", StepName: "build",
		}))
	require.NoError(t, err)

	var updated pipelinesv1alpha1.Pipeline
	require.NoError(t, cl.Get(context.Background(), client.ObjectKey{Name: "p", Namespace: "ns"}, &updated))
	require.Equal(t, pipelinesv1alpha1.StepSkipped, updated.Status.StepStatuses[0].Phase)
	require.NotNil(t, updated.Status.StepStatuses[0].CompletedAt)
}

func TestCancelPipeline_Success(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Status: pipelinesv1alpha1.PipelineStatus{
				Phase: pipelinesv1alpha1.PipelineRunning,
				StepStatuses: []pipelinesv1alpha1.StepStatus{
					{Name: "build", Phase: pipelinesv1alpha1.StepRunning},
					{Name: "test", Phase: pipelinesv1alpha1.StepPending},
				},
			},
		},
	)
	k8sClient := fake.NewSimpleClientset()
	broker := events.NewBroker(logr.Discard())
	srv := NewPaprikaServer(cl, broker, WithK8sClient(k8sClient))

	_, err := srv.CancelPipeline(context.Background(), connect.NewRequest(
		&paprikav1.CancelPipelineRequest{
			Name: "p", Namespace: "ns",
		}))
	require.NoError(t, err)

	var updated pipelinesv1alpha1.Pipeline
	require.NoError(t, cl.Get(context.Background(), client.ObjectKey{Name: "p", Namespace: "ns"}, &updated))
	require.Equal(t, pipelinesv1alpha1.PipelineCancelled, updated.Status.Phase)
	require.Equal(t, pipelinesv1alpha1.StepCancelled, updated.Status.StepStatuses[0].Phase)
	require.NotNil(t, updated.Status.StepStatuses[0].CompletedAt)
}

func TestCancelPipeline_TerminalGuard(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Status: pipelinesv1alpha1.PipelineStatus{
				Phase: pipelinesv1alpha1.PipelineSucceeded,
			},
		},
	)
	srv := NewPaprikaServer(cl, nil)
	_, err := srv.CancelPipeline(context.Background(), connect.NewRequest(
		&paprikav1.CancelPipelineRequest{
			Name: "p", Namespace: "ns",
		}))
	require.Error(t, err)
	connErr := err.(*connect.Error)
	require.Equal(t, connect.CodeFailedPrecondition, connErr.Code())
}

func TestGetStepLogs_NoJob(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
		},
	)
	k8sClient := fake.NewSimpleClientset()
	srv := NewPaprikaServer(cl, nil, WithK8sClient(k8sClient))

	_, err := srv.GetStepLogs(context.Background(), connect.NewRequest(
		&paprikav1.GetStepLogsRequest{
			PipelineName: "p", PipelineNamespace: "ns", StepName: "build",
		}))
	require.Error(t, err)
	connErr := err.(*connect.Error)
	require.Equal(t, connect.CodeNotFound, connErr.Code())
}

func TestPublishPipelineEvent(t *testing.T) {
	cl := newPipelineTestClient(
		&pipelinesv1alpha1.Pipeline{
			ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns", Labels: map[string]string{"app.paprika.io/project": "default"}},
			Status: pipelinesv1alpha1.PipelineStatus{
				Phase: pipelinesv1alpha1.PipelineRunning,
				StepStatuses: []pipelinesv1alpha1.StepStatus{
					{Name: "build", Phase: pipelinesv1alpha1.StepPending},
				},
			},
		},
	)
	broker := events.NewBroker(logr.Discard())
	ctx := context.Background()
	ch := broker.Subscribe(ctx, "pipeline/ns/p")
	srv := NewPaprikaServer(cl, broker)

	_, err := srv.SkipStep(ctx, connect.NewRequest(
		&paprikav1.SkipStepRequest{
			PipelineName: "p", PipelineNamespace: "ns", StepName: "build",
		}))
	require.NoError(t, err)

	select {
	case evt := <-ch:
		require.Equal(t, events.TypePipeline, evt.Type)
	case <-time.After(2 * time.Second):
		t.Fatal("expected pipeline event")
	}
}

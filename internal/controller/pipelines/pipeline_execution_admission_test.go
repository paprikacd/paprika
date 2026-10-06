package pipelines

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/controller/pipelines/progress"
)

type pipelineAdmissionRunner struct {
	client client.Client
	calls  int
}

func (r *pipelineAdmissionRunner) RunPipeline(ctx context.Context, pipeline *api.Pipeline, onProgress progress.StepProgressCallback) ([]api.StepStatus, error) {
	r.calls++
	statuses := make([]api.StepStatus, 0, len(pipeline.Spec.Steps))
	for _, step := range pipeline.Spec.Steps {
		onProgress(ctx, pipeline, api.StepStatus{Name: step.Name, Phase: api.StepRunning})
		job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-%d", step.Name, r.calls),
			Namespace: pipeline.Namespace,
			Labels:    map[string]string{PipelineLabelKey: pipeline.Name},
		}}
		if err := r.client.Create(ctx, job); err != nil {
			return nil, err
		}
		status := api.StepStatus{Name: step.Name, Phase: api.StepSucceeded}
		statuses = append(statuses, status)
		onProgress(ctx, pipeline, status)
	}
	return statuses, nil
}

func newPipelineAdmissionFixture(t *testing.T, livePhase, cachedPhase api.PipelinePhase) (*PipelineReconciler, *pipelineAdmissionRunner, client.WithWatch, *api.Pipeline) {
	t.Helper()

	scheme := runtime.NewScheme()
	if err := api.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := batchv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	pipeline := &api.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name: "verification", Namespace: "default", UID: "same-pipeline-uid", Generation: 1,
			Finalizers: []string{pipelineFinalizer},
		},
		Spec: api.PipelineSpec{MaxParallel: 1, Steps: []api.PipelineStep{
			{Name: "upstream-health", Image: "busybox", Script: "true", Retry: 1},
			{Name: "upstream-identity", Image: "busybox", Script: "true", Depends: []string{"upstream-health"}, Retry: 1},
		}},
		Status: api.PipelineStatus{Phase: livePhase, ObservedGeneration: 1, LastExecutionID: "run-verification"},
	}
	if isTerminalPipelinePhase(livePhase) {
		pipeline.Status.StepStatuses = []api.StepStatus{
			{Name: "upstream-health", Phase: api.StepSucceeded},
			{Name: "upstream-identity", Phase: api.StepSucceeded},
		}
	}
	live := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&api.Pipeline{}).WithObjects(pipeline).Build()
	cached := interceptor.NewClient(live, interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, object client.Object, opts ...client.GetOption) error {
			if err := c.Get(ctx, key, object, opts...); err != nil {
				return err
			}
			if cachedPipeline, ok := object.(*api.Pipeline); ok {
				cachedPipeline.Status.Phase = cachedPhase
			}
			return nil
		},
	})
	runner := &pipelineAdmissionRunner{client: live}
	return &PipelineReconciler{client: cached, APIReader: live, Scheme: scheme, WorkflowEngine: runner}, runner, live, pipeline
}

func TestPipelineExecutionAdmissionDoesNotReplayTerminalStatus(t *testing.T) {
	t.Parallel()

	for _, phase := range []api.PipelinePhase{api.PipelineSucceeded, api.PipelineFailed, api.PipelineCancelled} {
		t.Run(string(phase), func(t *testing.T) {
			t.Parallel()
			r, runner, live, original := newPipelineAdmissionFixture(t, phase, api.PipelineRunning)
			req := ctrl.Request{NamespacedName: client.ObjectKeyFromObject(original)}
			for range 3 {
				if _, err := r.Reconcile(context.Background(), req); err != nil {
					t.Fatal(err)
				}
			}
			if runner.calls != 0 {
				t.Fatalf("replayed live %s pipeline from stale Running cache %d times", phase, runner.calls)
			}
			var jobs batchv1.JobList
			if err := live.List(context.Background(), &jobs); err != nil {
				t.Fatal(err)
			}
			if len(jobs.Items) != 0 {
				t.Fatalf("terminal pipeline created %d duplicate verification Jobs", len(jobs.Items))
			}
			var current api.Pipeline
			if err := live.Get(context.Background(), req.NamespacedName, &current); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(current.Status, original.Status) {
				t.Fatalf("terminal status was overwritten: got %+v, want %+v", current.Status, original.Status)
			}
		})
	}
}

func TestPipelineExecutionAdmissionRunsAuthoritativeNonterminalStatus(t *testing.T) {
	t.Parallel()

	for _, phase := range []api.PipelinePhase{"", api.PipelineRunning} {
		t.Run("phase="+string(phase), func(t *testing.T) {
			t.Parallel()
			r, runner, live, pipeline := newPipelineAdmissionFixture(t, phase, api.PipelineSucceeded)
			req := ctrl.Request{NamespacedName: client.ObjectKeyFromObject(pipeline)}
			if _, err := r.Reconcile(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if runner.calls != 1 {
				t.Fatalf("authoritative phase %q ran workflow %d times, want one", phase, runner.calls)
			}
			var current api.Pipeline
			if err := live.Get(context.Background(), req.NamespacedName, &current); err != nil {
				t.Fatal(err)
			}
			if current.Status.Phase != api.PipelineSucceeded || len(current.Status.StepStatuses) != 2 {
				t.Fatalf("normal execution did not persist complete verification: %+v", current.Status)
			}
			var jobs batchv1.JobList
			if err := live.List(context.Background(), &jobs); err != nil {
				t.Fatal(err)
			}
			if len(jobs.Items) != 2 {
				t.Fatalf("normal execution created %d Jobs, want one per step", len(jobs.Items))
			}
		})
	}
}

func TestPipelineExecutionAdmissionFailsClosedOnAuthoritativeReadError(t *testing.T) {
	t.Parallel()

	r, runner, live, pipeline := newPipelineAdmissionFixture(t, api.PipelineSucceeded, api.PipelineRunning)
	readErr := errors.New("authoritative Pipeline read unavailable")
	r.APIReader = interceptor.NewClient(live, interceptor.Funcs{
		Get: func(context.Context, client.WithWatch, client.ObjectKey, client.Object, ...client.GetOption) error {
			return readErr
		},
	})
	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(pipeline)})
	if !errors.Is(err, readErr) || runner.calls != 0 {
		t.Fatalf("failed authoritative read admitted execution: calls=%d, error=%v", runner.calls, err)
	}
	var current api.Pipeline
	if err := live.Get(context.Background(), client.ObjectKeyFromObject(pipeline), &current); err != nil {
		t.Fatal(err)
	}
	if current.Status.Phase != api.PipelineSucceeded {
		t.Fatalf("read failure replaced terminal phase with %s", current.Status.Phase)
	}
}

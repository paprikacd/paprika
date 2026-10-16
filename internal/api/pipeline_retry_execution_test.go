package apiserver

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	pb "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/engine"
)

func TestRetryStepTerminalPipelineExecutesFreshJobsAndPreservesPrerequisites(t *testing.T) {
	t.Parallel()
	old := metav1.NewTime(time.Unix(1000, 0))
	pipeline := &api.Pipeline{ObjectMeta: metav1.ObjectMeta{Name: "retry", Namespace: "ns", Generation: 1},
		Spec: api.PipelineSpec{MaxParallel: 1, Steps: []api.PipelineStep{
			{Name: "build", Image: "test", Script: "build"},
			{Name: "test", Image: "test", Script: "test", Depends: []string{"build"}, Retry: 1},
			{Name: "publish", Image: "test", Script: "publish", Depends: []string{"test"}},
		}}, Status: api.PipelineStatus{Phase: api.PipelineFailed, ObservedGeneration: 1, LastExecutionID: "old", LastExecutionTime: &old,
			StepStatuses: []api.StepStatus{{Name: "build", Phase: api.StepSucceeded, StartedAt: &old, CompletedAt: &old}, {Name: "test", Phase: api.StepFailed, StartedAt: &old, CompletedAt: &old, LogRef: "old"}, {Name: "publish", Phase: api.StepSkipped, CompletedAt: &old}}}}
	cl := newPipelineTestClient(pipeline)
	kube := fake.NewSimpleClientset()
	srv := NewPaprikaServer(cl, nil, WithK8sClient(kube), WithControlPlaneNamespace("jobs"))
	_, err := srv.RetryStep(t.Context(), connect.NewRequest(&pb.RetryStepRequest{PipelineName: pipeline.Name, PipelineNamespace: pipeline.Namespace, StepName: "test"}))
	require.NoError(t, err)
	var current api.Pipeline
	require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &current))
	require.Equal(t, api.PipelineRunning, current.Status.Phase, "controller terminal guard must admit execution")
	require.NotEqual(t, "old", current.Status.LastExecutionID)
	require.True(t, current.Status.LastExecutionTime.After(old.Time))
	for _, status := range current.Status.StepStatuses[1:] {
		require.Equal(t, api.StepPending, status.Phase)
		require.Nil(t, status.StartedAt)
		require.Nil(t, status.CompletedAt)
		require.Empty(t, status.LogRef)
	}
	var jobs []*batchv1.Job
	kube.PrependReactor("create", "jobs", func(action k8stesting.Action) (bool, runtime.Object, error) {
		creation, ok := action.(k8stesting.CreateAction)
		require.True(t, ok)
		job, ok := creation.GetObject().(*batchv1.Job)
		require.True(t, ok)
		jobs = append(jobs, job.DeepCopy())
		return false, nil, nil
	})
	watchCount := 0
	kube.PrependWatchReactor("jobs", func(_ k8stesting.Action) (bool, watch.Interface, error) {
		watchCount++
		result := batchv1.JobComplete
		if watchCount == 1 {
			result = batchv1.JobFailed // The explicit attempt gets its full configured retry budget.
		}
		watcher := watch.NewRaceFreeFake()
		watcher.Add(&batchv1.Job{Status: batchv1.JobStatus{Conditions: []batchv1.JobCondition{{Type: result, Status: corev1.ConditionTrue}}}})
		return true, watcher, nil
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	statuses, err := engine.NewWorkflowEngine(kube, "jobs").RunPipeline(ctx, &current, nil)
	require.NoError(t, err)
	require.Len(t, jobs, 3)
	require.Equal(t, "test", jobs[0].Labels[stepLabelKey])
	require.Equal(t, "test", jobs[1].Labels[stepLabelKey])
	require.Equal(t, "publish", jobs[2].Labels[stepLabelKey])
	require.NotEqual(t, jobs[0].Name, jobs[1].Name)
	require.EqualValues(t, 0, *jobs[0].Spec.BackoffLimit)
	require.Len(t, statuses, 3)
	for _, status := range statuses {
		require.Equal(t, api.StepSucceeded, status.Phase)
		if status.Name == "build" {
			require.Equal(t, old, *status.StartedAt, "successful prerequisite must not execute again")
		} else {
			require.True(t, status.StartedAt.After(old.Time))
		}
	}
}

func TestRetryStepRejectsUnsatisfiedPrerequisiteAndConcurrentRun(t *testing.T) {
	t.Parallel()
	for _, phase := range []api.PipelinePhase{api.PipelineFailed, api.PipelineRunning, api.PipelineSucceeded, "", "Pending"} {
		t.Run(string(phase), func(t *testing.T) {
			t.Parallel()
			pipeline := &api.Pipeline{
				ObjectMeta: metav1.ObjectMeta{Name: "retry", Namespace: "ns"},
				Spec: api.PipelineSpec{Steps: []api.PipelineStep{
					{Name: "first", Image: "test", Script: "first"},
					{Name: "second", Image: "test", Script: "second", Depends: []string{"first"}},
				}},
				Status: api.PipelineStatus{Phase: phase, StepStatuses: []api.StepStatus{
					{Name: "first", Phase: api.StepFailed}, {Name: "second", Phase: api.StepSkipped},
				}},
			}
			srv := NewPaprikaServer(newPipelineTestClient(pipeline), nil)
			_, err := srv.RetryStep(t.Context(), connect.NewRequest(&pb.RetryStepRequest{PipelineName: pipeline.Name, PipelineNamespace: pipeline.Namespace, StepName: "second"}))
			require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
		})
	}
}

func TestRetryStepRejectsUnexecutedGeneration(t *testing.T) {
	t.Parallel()
	pipeline := &api.Pipeline{ObjectMeta: metav1.ObjectMeta{Name: "retry", Namespace: "ns", Generation: 2},
		Spec: api.PipelineSpec{Steps: []api.PipelineStep{{Name: "test", Image: "test", Script: "changed"}}},
		Status: api.PipelineStatus{Phase: api.PipelineFailed, ObservedGeneration: 1,
			StepStatuses: []api.StepStatus{{Name: "test", Phase: api.StepFailed}}}}
	cl := newPipelineTestClient(pipeline)
	srv := NewPaprikaServer(cl, nil)
	_, err := srv.RetryStep(t.Context(), connect.NewRequest(&pb.RetryStepRequest{PipelineName: pipeline.Name, PipelineNamespace: pipeline.Namespace, StepName: "test"}))
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	var current api.Pipeline
	require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &current))
	require.Equal(t, pipeline.Status, current.Status)
}

func TestRetryStepRejectsCancelledExecutionsAndSteps(t *testing.T) {
	t.Parallel()
	for _, phases := range [][2]string{{"Cancelled", "Cancelled"}, {"Cancelled", "Failed"}, {"Failed", "Cancelled"}} {
		t.Run(phases[0]+"/"+phases[1], func(t *testing.T) {
			t.Parallel()
			pipeline := retryJobGuardPipeline()
			pipeline.Status.Phase = api.PipelinePhase(phases[0])
			pipeline.Status.StepStatuses[0].Phase = api.StepPhase(phases[1])
			cl := newPipelineTestClient(pipeline)
			srv := NewPaprikaServer(cl, nil, WithK8sClient(fake.NewSimpleClientset()), WithControlPlaneNamespace("jobs"))
			_, err := srv.RetryStep(t.Context(), connect.NewRequest(&pb.RetryStepRequest{PipelineName: pipeline.Name, PipelineNamespace: pipeline.Namespace, StepName: "test"}))
			require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
			var current api.Pipeline
			require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &current))
			require.Equal(t, pipeline.Status, current.Status)
		})
	}
}

func retryJobGuardPipeline() *api.Pipeline {
	return &api.Pipeline{ObjectMeta: metav1.ObjectMeta{Name: "retry", Namespace: "tenant", Generation: 1},
		Spec: api.PipelineSpec{Steps: []api.PipelineStep{{Name: "test", Image: "test", Script: "test"}}},
		Status: api.PipelineStatus{Phase: api.PipelineFailed, ObservedGeneration: 1,
			StepStatuses: []api.StepStatus{{Name: "test", Phase: api.StepFailed}}}}
}

func TestRetryStepRequiresPriorJobsStoppedInExecutionNamespace(t *testing.T) {
	t.Parallel()
	for _, state := range []string{"active", "pending", "terminating", "complete", "failed", "unrelated"} {
		t.Run(state, func(t *testing.T) {
			t.Parallel()
			pipeline := retryJobGuardPipeline()
			job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "prior", Namespace: "jobs", Labels: map[string]string{pipelineLabelKey: pipeline.Name}}}
			switch state {
			case "active":
				job.Status.Active = 1
			case "terminating":
				now := metav1.Now()
				job.DeletionTimestamp = &now
				job.Finalizers = []string{"test.example/retain"}
				job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
			case "complete":
				job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			case "failed":
				job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
			case "unrelated":
				job.Labels[pipelineLabelKey] = "another-pipeline"
			}
			cl := newPipelineTestClient(pipeline)
			kube := fake.NewSimpleClientset(job)
			srv := NewPaprikaServer(cl, nil, WithK8sClient(kube), WithControlPlaneNamespace("jobs"))
			_, err := srv.RetryStep(t.Context(), connect.NewRequest(&pb.RetryStepRequest{PipelineName: pipeline.Name, PipelineNamespace: pipeline.Namespace, StepName: "test"}))
			var current api.Pipeline
			require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &current))
			if state == "complete" || state == "failed" || state == "unrelated" {
				require.NoError(t, err)
				require.Equal(t, api.PipelineRunning, current.Status.Phase)
			} else {
				require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
				require.Equal(t, pipeline.Status, current.Status)
			}
		})
	}
}

func TestRetryStepFailsClosedWithoutPriorJobEvidence(t *testing.T) {
	t.Parallel()
	for _, unavailable := range []string{"client", "namespace", "list"} {
		t.Run(unavailable, func(t *testing.T) {
			t.Parallel()
			pipeline := retryJobGuardPipeline()
			cl := newPipelineTestClient(pipeline)
			kube := fake.NewSimpleClientset()
			opts := []ServerOption{WithK8sClient(kube), WithControlPlaneNamespace("jobs")}
			switch unavailable {
			case "client":
				opts = []ServerOption{WithControlPlaneNamespace("jobs")}
			case "namespace":
				opts = []ServerOption{WithK8sClient(kube)}
			case "list":
				kube.PrependReactor("list", "jobs", func(k8stesting.Action) (bool, runtime.Object, error) {
					return true, nil, errors.New("job API unavailable")
				})
			}
			srv := NewPaprikaServer(cl, nil, opts...)
			_, err := srv.RetryStep(t.Context(), connect.NewRequest(&pb.RetryStepRequest{PipelineName: pipeline.Name, PipelineNamespace: pipeline.Namespace, StepName: "test"}))
			require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
			var current api.Pipeline
			require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &current))
			require.Equal(t, pipeline.Status, current.Status)
		})
	}
}

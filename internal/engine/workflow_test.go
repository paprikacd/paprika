package engine

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/utils/ptr"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestResolveDAG(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		steps       []paprika.PipelineStep
		wantErr     bool
		wantBatches [][]string
	}{
		{
			name: "linear",
			steps: []paprika.PipelineStep{
				{Name: "build"},
				{Name: "test", Depends: []string{"build"}},
				{Name: "deploy", Depends: []string{"test"}},
			},
			wantBatches: [][]string{{"build"}, {"test"}, {"deploy"}},
		},
		{
			name: "fan out",
			steps: []paprika.PipelineStep{
				{Name: "build"},
				{Name: "test", Depends: []string{"build"}},
				{Name: "lint", Depends: []string{"build"}},
				{Name: "deploy", Depends: []string{"test", "lint"}},
			},
			wantBatches: [][]string{{"build"}, {"test", "lint"}, {"deploy"}},
		},
		{
			name: "no dependencies",
			steps: []paprika.PipelineStep{
				{Name: "build"},
				{Name: "test"},
				{Name: "lint"},
			},
			wantBatches: [][]string{{"build", "test", "lint"}},
		},
		{
			name: "cycle",
			steps: []paprika.PipelineStep{
				{Name: "a", Depends: []string{"b"}},
				{Name: "b", Depends: []string{"c"}},
				{Name: "c", Depends: []string{"a"}},
			},
			wantErr: true,
		},
		{
			name: "missing dependency",
			steps: []paprika.PipelineStep{
				{Name: "build", Depends: []string{"nonexistent"}},
			},
			wantErr: true,
		},
		{
			name: "diamond",
			steps: []paprika.PipelineStep{
				{Name: "build"},
				{Name: "test-left", Depends: []string{"build"}},
				{Name: "test-right", Depends: []string{"build"}},
				{Name: "deploy", Depends: []string{"test-left", "test-right"}},
			},
			wantBatches: [][]string{{"build"}, {"test-left", "test-right"}, {"deploy"}},
		},
		{
			name:        "nil steps",
			steps:       nil,
			wantBatches: [][]string{},
		},
		{
			name:        "empty steps",
			steps:       []paprika.PipelineStep{},
			wantBatches: [][]string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			batches, err := ResolveDAG(tt.steps)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(batches) != len(tt.wantBatches) {
				t.Fatalf("expected %d batches, got %d", len(tt.wantBatches), len(batches))
			}
			for i, want := range tt.wantBatches {
				if len(batches[i]) != len(want) {
					t.Fatalf("batch %d: expected %d steps, got %d", i, len(want), len(batches[i]))
				}
				got := make([]string, len(batches[i]))
				for j, step := range batches[i] {
					got[j] = step.Name
				}
				wantSorted := make([]string, len(want))
				copy(wantSorted, want)
				sort.Strings(got)
				sort.Strings(wantSorted)
				for j, name := range wantSorted {
					if got[j] != name {
						t.Fatalf("batch %d step %d: expected %q, got %q", i, j, name, got[j])
					}
				}
			}
		})
	}
}

func TestCreateStepJob(t *testing.T) {
	t.Parallel()

	step := func(name, image, script string, retry, timeout int) paprika.PipelineStep {
		return paprika.PipelineStep{Name: name, Image: image, Script: script, Retry: retry, Timeout: timeout}
	}

	tests := []struct {
		name      string
		step      paprika.PipelineStep
		wantCheck func(t *testing.T, job *batchv1.Job)
	}{
		{
			name: "default namespace and labels",
			step: step("build", "golang:1.22", "go build", 0, 0),
			wantCheck: func(t *testing.T, job *batchv1.Job) {
				if job.Namespace != "default" {
					t.Fatalf("expected namespace 'default', got %q", job.Namespace)
				}
				if job.Spec.Template.Spec.Containers[0].Image != "golang:1.22" {
					t.Fatalf("expected image 'golang:1.22', got %q", job.Spec.Template.Spec.Containers[0].Image)
				}
				if job.Labels["paprika.io/pipeline"] != "test-pipeline" {
					t.Fatalf("expected pipeline label 'test-pipeline', got %q", job.Labels["paprika.io/pipeline"])
				}
				if job.Labels["paprika.io/step"] != "build" {
					t.Fatalf("expected step label 'build', got %q", job.Labels["paprika.io/step"])
				}
			},
		},
		{
			name: "retry disables kube backoff",
			step: step("test", "golang:1.22", "go test", 2, 0),
			wantCheck: func(t *testing.T, job *batchv1.Job) {
				if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 0 {
					t.Fatalf("expected BackoffLimit 0 (retries handled by operator), got %v", job.Spec.BackoffLimit)
				}
			},
		},
		{
			name: "custom timeout",
			step: step("build", "golang:1.22", "go build", 0, 600),
			wantCheck: func(t *testing.T, job *batchv1.Job) {
				if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 600 {
					t.Fatalf("expected ActiveDeadlineSeconds 600, got %v", job.Spec.ActiveDeadlineSeconds)
				}
			},
		},
		{
			name: "default timeout",
			step: step("build", "golang:1.22", "go build", 0, 0),
			wantCheck: func(t *testing.T, job *batchv1.Job) {
				if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 3600 {
					t.Fatalf("expected default ActiveDeadlineSeconds 3600, got %v", job.Spec.ActiveDeadlineSeconds)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			fakeClient := fake.NewSimpleClientset()
			engine := NewWorkflowEngine(fakeClient, "default")

			job, err := engine.CreateStepJob(context.Background(), &tc.step, "test-pipeline")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			tc.wantCheck(t, job)
		})
	}
}

func TestNewWorkflowEngine(t *testing.T) {
	t.Parallel()

	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "paprika-system")

	if engine.Client != fakeClient {
		t.Fatal("expected client to match")
	}
	if engine.Namespace != "paprika-system" {
		t.Fatalf("expected namespace 'paprika-system', got %q", engine.Namespace)
	}
}

func TestExecuteStep_Command(t *testing.T) {
	t.Parallel()

	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "make build"}
	job, err := engine.ExecuteStep(context.Background(), &step, "test-pipeline")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	container := job.Spec.Template.Spec.Containers[0]
	if len(container.Command) != 2 || container.Command[0] != "sh" || container.Command[1] != "-c" {
		t.Fatalf("expected command 'sh -c', got %v", container.Command)
	}
	if len(container.Args) != 1 || container.Args[0] != "make build" {
		t.Fatalf("expected args 'make build', got %v", container.Args)
	}
}

func TestGetStepLogs_NoPods(t *testing.T) {
	t.Parallel()

	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	_, err := engine.GetStepLogs(context.Background(), "test-pipeline", "build")
	if err == nil {
		t.Fatal("expected error for missing pod, got nil")
	}
}

func TestCreateStepJob_UniqueNames(t *testing.T) {
	t.Parallel()

	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "go build"}
	names := make(map[string]struct{}, 100)
	for range 100 {
		job, err := engine.CreateStepJob(context.Background(), &step, "test-pipeline")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, exists := names[job.Name]; exists {
			t.Fatalf("duplicate job name: %s", job.Name)
		}
		names[job.Name] = struct{}{}
	}
}

func TestWatchJob_ContextCancellation(t *testing.T) {
	t.Parallel()

	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: "test-job", Namespace: "default"},
		Spec:       batchv1.JobSpec{ActiveDeadlineSeconds: ptr.To(int64(3600))},
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	result := engine.watchJob(ctx, job, "test-pipeline")
	elapsed := time.Since(start)

	if result.Phase != paprika.StepFailed {
		t.Fatalf("expected failed phase, got %v", result.Phase)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("watchJob did not respect context cancellation, took %v", elapsed)
	}
}

func TestRunPipeline_FailedStepDoesNotDeadlock(t *testing.T) {
	t.Parallel()

	fakeClient := fake.NewSimpleClientset()
	fakeClient.PrependReactor("create", "jobs", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("forced create failure")
	})
	engine := NewWorkflowEngine(fakeClient, "default")

	pipeline := &paprika.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: "test-pipeline"},
		Spec: paprika.PipelineSpec{
			Steps: []paprika.PipelineStep{
				{Name: "step1", Image: "golang:1.22", Script: "go build", Retry: 3},
				{Name: "step2", Image: "golang:1.22", Script: "go test", Retry: 3},
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := engine.RunPipeline(ctx, pipeline)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

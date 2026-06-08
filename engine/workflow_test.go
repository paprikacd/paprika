package engine

import (
	"context"
	"testing"

	"k8s.io/client-go/kubernetes/fake"

	paprika "github.com/benebsworth/paprika/api/v1alpha1"
)

func TestLinearDAG(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "build"},
		{Name: "test", Depends: []string{"build"}},
		{Name: "deploy", Depends: []string{"test"}},
	}
	batches, err := ResolveDAG(steps)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(batches) != 3 {
		t.Fatalf("expected 3 batches, got %d", len(batches))
	}
	if batches[0][0].Name != "build" {
		t.Fatalf("expected first batch 'build', got %v", batches[0][0].Name)
	}
	if batches[1][0].Name != "test" {
		t.Fatalf("expected second batch 'test', got %v", batches[1][0].Name)
	}
}

func TestFanOutDAG(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "build"},
		{Name: "test", Depends: []string{"build"}},
		{Name: "lint", Depends: []string{"build"}},
		{Name: "deploy", Depends: []string{"test", "lint"}},
	}
	batches, err := ResolveDAG(steps)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(batches) != 3 {
		t.Fatalf("expected 3 batches, got %d", len(batches))
	}
	if len(batches[1]) != 2 {
		t.Fatalf("expected 2 parallel steps in batch 2, got %d", len(batches[1]))
	}
}

func TestNoDepsDAG(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "build"},
		{Name: "test"},
		{Name: "lint"},
	}
	batches, err := ResolveDAG(steps)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(batches) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(batches))
	}
	if len(batches[0]) != 3 {
		t.Fatalf("expected 3 parallel steps, got %d", len(batches[0]))
	}
}

func TestCycleDetection(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "a", Depends: []string{"b"}},
		{Name: "b", Depends: []string{"c"}},
		{Name: "c", Depends: []string{"a"}},
	}
	_, err := ResolveDAG(steps)
	if err == nil {
		t.Fatal("expected cycle detection error, got nil")
	}
}

func TestMissingDependency(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "build", Depends: []string{"nonexistent"}},
	}
	_, err := ResolveDAG(steps)
	if err == nil {
		t.Fatal("expected error for missing dependency, got nil")
	}
}

func TestDiamondDAG(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "build"},
		{Name: "test-left", Depends: []string{"build"}},
		{Name: "test-right", Depends: []string{"build"}},
		{Name: "deploy", Depends: []string{"test-left", "test-right"}},
	}
	batches, err := ResolveDAG(steps)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(batches) != 3 {
		t.Fatalf("expected 3 batches, got %d", len(batches))
	}
	if len(batches[1]) != 2 {
		t.Fatalf("expected 2 steps in middle batch, got %d", len(batches[1]))
	}
}

func TestCreateStepJob_DefaultNamespace(t *testing.T) {
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "go build"}
	job, err := engine.CreateStepJob(context.Background(), step, "test-pipeline")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

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
}

func TestCreateStepJob_RetryLimit(t *testing.T) {
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "test", Image: "golang:1.22", Script: "go test", Retry: 2}
	job, err := engine.CreateStepJob(context.Background(), step, "test-pipeline")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 0 {
		t.Fatalf("expected BackoffLimit 0 (retries handled by operator), got %v", job.Spec.BackoffLimit)
	}
}

func TestCreateStepJob_Timeout(t *testing.T) {
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "go build", Timeout: 600}
	job, err := engine.CreateStepJob(context.Background(), step, "test-pipeline")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 600 {
		t.Fatalf("expected ActiveDeadlineSeconds 600, got %v", job.Spec.ActiveDeadlineSeconds)
	}
}

func TestCreateStepJob_DefaultTimeout(t *testing.T) {
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "go build"}
	job, err := engine.CreateStepJob(context.Background(), step, "test-pipeline")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 3600 {
		t.Fatalf("expected default ActiveDeadlineSeconds 3600, got %v", job.Spec.ActiveDeadlineSeconds)
	}
}

func TestNewWorkflowEngine(t *testing.T) {
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
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "make build"}
	job, err := engine.ExecuteStep(context.Background(), step, "test-pipeline")
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
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	_, err := engine.GetStepLogs(context.Background(), "test-pipeline", "build")
	if err == nil {
		t.Fatal("expected error for missing pod, got nil")
	}
}

func TestResolveDAG_EmptySteps(t *testing.T) {
	batches, err := ResolveDAG(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(batches) != 0 {
		t.Fatalf("expected 0 batches, got %d", len(batches))
	}

	batches, err = ResolveDAG([]paprika.PipelineStep{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(batches) != 0 {
		t.Fatalf("expected 0 batches, got %d", len(batches))
	}
}

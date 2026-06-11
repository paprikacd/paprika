package engine

import (
	"context"
	"fmt"
	"maps"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/utils/ptr"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Node represents a single step node in the workflow DAG.
type Node struct {
	Name      string
	DependsOn []string
	Step      paprika.PipelineStep
}

// Graph represents a directed acyclic graph of pipeline steps.
type Graph struct {
	Nodes map[string]*Node
}

// NewGraph creates a new Graph from a list of pipeline steps.
func NewGraph(steps []paprika.PipelineStep) *Graph {
	g := &Graph{Nodes: make(map[string]*Node)}
	for _, s := range steps {
		g.Nodes[s.Name] = &Node{
			Name:      s.Name,
			DependsOn: s.Depends,
			Step:      s,
		}
	}
	return g
}

// TopologicalSort performs a topological sort of the graph and returns batches of steps.
func (g *Graph) TopologicalSort() ([][]paprika.PipelineStep, error) {
	if err := g.validateNoUnknownDeps(); err != nil {
		return nil, err
	}

	if err := g.visitAllCycles(); err != nil {
		return nil, err
	}

	remaining := make(map[string]*Node)
	maps.Copy(remaining, g.Nodes)

	return g.buildBatches(remaining)
}

func (g *Graph) validateNoUnknownDeps() error {
	for _, n := range g.Nodes {
		for _, dep := range n.DependsOn {
			if _, exists := g.Nodes[dep]; !exists {
				return fmt.Errorf("step %q depends on unknown step %q", n.Name, dep)
			}
		}
	}
	return nil
}

func (g *Graph) visitAllCycles() error {
	visited := make(map[string]bool)
	for name := range g.Nodes {
		if err := g.detectCycle(name, make(map[string]bool), visited); err != nil {
			return err
		}
	}
	return nil
}

func (g *Graph) detectCycle(name string, path, visited map[string]bool) error {
	if path[name] {
		cycle := make([]string, 0, len(path))
		for k := range path {
			cycle = append(cycle, k)
		}
		return fmt.Errorf("cycle detected involving step %q (path: %v)", name, cycle)
	}
	if visited[name] {
		return nil
	}
	visited[name] = true
	path[name] = true
	for _, dep := range g.Nodes[name].DependsOn {
		if err := g.detectCycle(dep, path, visited); err != nil {
			return err
		}
	}
	delete(path, name)
	return nil
}

func (g *Graph) buildBatches(remaining map[string]*Node) ([][]paprika.PipelineStep, error) {
	var batches [][]paprika.PipelineStep
	for len(remaining) > 0 {
		var batch []paprika.PipelineStep
		for _, n := range remaining {
			ready := true
			for _, dep := range n.DependsOn {
				if _, done := remaining[dep]; done {
					ready = false
					break
				}
			}
			if ready {
				batch = append(batch, n.Step)
			}
		}
		if len(batch) == 0 {
			return nil, fmt.Errorf("stuck: no steps ready but %d remaining", len(remaining))
		}
		batches = append(batches, batch)
		for _, s := range batch {
			delete(remaining, s.Name)
		}
	}
	return batches, nil
}

// ResolveDAG resolves a list of pipeline steps into topological batches.
func ResolveDAG(steps []paprika.PipelineStep) ([][]paprika.PipelineStep, error) {
	g := NewGraph(steps)
	return g.TopologicalSort()
}

// WorkflowEngineImpl executes pipeline workflows by creating Kubernetes jobs.
type WorkflowEngineImpl struct {
	Client    kubernetes.Interface
	Namespace string
}

// NewWorkflowEngine creates a new WorkflowEngineImpl with the given Kubernetes client and namespace.
func NewWorkflowEngine(client kubernetes.Interface, namespace string) *WorkflowEngineImpl {
	return &WorkflowEngineImpl{
		Client:    client,
		Namespace: namespace,
	}
}

// RunPipeline executes all steps in a pipeline, respecting the DAG and parallelism.
func (e *WorkflowEngineImpl) RunPipeline(ctx context.Context, pipeline *paprika.Pipeline) ([]paprika.StepStatus, error) {
	batches, err := ResolveDAG(pipeline.Spec.Steps)
	if err != nil {
		return nil, fmt.Errorf("DAG resolution failed: %w", err)
	}

	maxParallel := pipeline.Spec.MaxParallel
	if maxParallel <= 0 {
		maxParallel = 10
	}

	var stepStatuses []paprika.StepStatus
	completed := make(map[string]bool)

	for _, batch := range batches {
		if err := e.executeBatch(ctx, batch, pipeline.Name, maxParallel, completed, &stepStatuses); err != nil {
			return stepStatuses, err
		}
	}

	return stepStatuses, nil
}

func (e *WorkflowEngineImpl) executeBatch(ctx context.Context, batch []paprika.PipelineStep, pipelineName string, maxParallel int, completed map[string]bool, stepStatuses *[]paprika.StepStatus) error {
	for i := 0; i < len(batch); i += maxParallel {
		end := min(i+maxParallel, len(batch))
		subBatch := batch[i:end]

		if err := e.executeSubBatch(ctx, subBatch, pipelineName, completed, stepStatuses); err != nil {
			return err
		}
	}
	return nil
}

func (e *WorkflowEngineImpl) executeSubBatch(ctx context.Context, batch []paprika.PipelineStep, pipelineName string, completed map[string]bool, stepStatuses *[]paprika.StepStatus) error {
	var mu sync.Mutex
	var wg sync.WaitGroup
	errCh := make(chan error, len(batch))

	for _, step := range batch {
		wg.Add(1)
		go func(s paprika.PipelineStep) {
			defer wg.Done()
			e.runStepJob(ctx, &s, pipelineName, completed, stepStatuses, &mu, errCh)
		}(step)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		return err
	}
	return nil
}

func (e *WorkflowEngineImpl) runStepJob(ctx context.Context, s *paprika.PipelineStep, pipelineName string, completed map[string]bool, stepStatuses *[]paprika.StepStatus, mu *sync.Mutex, errCh chan error) {
	for dep := range s.Depends {
		if completed[s.Depends[dep]] {
			continue
		}
		status := paprika.StepStatus{Name: s.Name, Phase: paprika.StepSkipped}
		mu.Lock()
		*stepStatuses = append(*stepStatuses, status)
		mu.Unlock()
		return
	}

	status := paprika.StepStatus{Name: s.Name, Phase: paprika.StepRunning}
	now := metav1.Now()
	status.StartedAt = &now

	job, err := e.CreateStepJob(ctx, s, pipelineName)
	if err != nil {
		status.Phase = paprika.StepFailed
		mu.Lock()
		*stepStatuses = append(*stepStatuses, status)
		mu.Unlock()
		errCh <- fmt.Errorf("step %q: failed to create job: %w", s.Name, err)
		return
	}

	stepResult := e.watchJob(ctx, job, pipelineName)
	status.CompletedAt = stepResult.CompletedAt
	status.Phase = stepResult.Phase
	status.LogRef = fmt.Sprintf("%s/%s/logs", pipelineName, s.Name)

	if stepResult.Phase == paprika.StepFailed && s.Retry > 0 {
		e.retryStep(ctx, s, pipelineName, &status, &now, errCh)
	}

	mu.Lock()
	*stepStatuses = append(*stepStatuses, status)
	completed[s.Name] = status.Phase == paprika.StepSucceeded
	mu.Unlock()

	if status.Phase == paprika.StepFailed {
		errCh <- fmt.Errorf("step %q: failed after %d retries", s.Name, s.Retry)
	}
}

func (e *WorkflowEngineImpl) retryStep(ctx context.Context, s *paprika.PipelineStep, pipelineName string, status *paprika.StepStatus, startedAt *metav1.Time, errCh chan error) {
	for attempt := 0; attempt < s.Retry; attempt++ {
		status.StartedAt = startedAt
		job, err := e.CreateStepJob(ctx, s, pipelineName)
		if err != nil {
			errCh <- fmt.Errorf("step %q: retry %d failed to create job: %w", s.Name, attempt+1, err)
			break
		}
		stepResult := e.watchJob(ctx, job, pipelineName)
		if stepResult.Phase == paprika.StepSucceeded {
			status.Phase = paprika.StepSucceeded
			break
		}
	}
}

type stepResult struct {
	Phase       paprika.StepPhase
	CompletedAt *metav1.Time
}

func (e *WorkflowEngineImpl) watchJob(ctx context.Context, job *batchv1.Job, _ string) stepResult {
	watcher, err := e.Client.BatchV1().Jobs(e.Namespace).Watch(ctx, metav1.SingleObject(metav1.ObjectMeta{
		Name:      job.Name,
		Namespace: e.Namespace,
	}))
	if err != nil {
		return stepResult{Phase: paprika.StepFailed}
	}
	defer watcher.Stop()

	timeout := time.After(24 * time.Hour)
	for {
		select {
		case event, ok := <-watcher.ResultChan():
			if !ok {
				return stepResult{Phase: paprika.StepFailed}
			}
			if result := processJobEvent(event); result != nil {
				return *result
			}
		case <-timeout:
			return stepResult{Phase: paprika.StepFailed}
		case <-ctx.Done():
			return stepResult{Phase: paprika.StepFailed}
		}
	}
}

func processJobEvent(event watch.Event) *stepResult {
	j, ok := event.Object.(*batchv1.Job)
	if !ok {
		return nil
	}
	for _, c := range j.Status.Conditions {
		if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
			now := metav1.Now()
			return &stepResult{Phase: paprika.StepSucceeded, CompletedAt: &now}
		}
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			now := metav1.Now()
			return &stepResult{Phase: paprika.StepFailed, CompletedAt: &now}
		}
	}
	return nil
}

// CreateStepJob creates a Kubernetes Job for a single pipeline step.
func (e *WorkflowEngineImpl) CreateStepJob(ctx context.Context, step *paprika.PipelineStep, pipelineName string) (*batchv1.Job, error) {
	timeoutSeconds := int64(step.Timeout)
	if timeoutSeconds <= 0 {
		timeoutSeconds = 3600
	}
	backoffLimit := int32(0)
	jobName := fmt.Sprintf("paprika-step-%s-%d", step.Name, time.Now().UnixMilli())

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: e.Namespace,
			Labels: map[string]string{
				"paprika.io/pipeline": pipelineName,
				"paprika.io/step":     step.Name,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:          &backoffLimit,
			ActiveDeadlineSeconds: &timeoutSeconds,
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: ptr.To(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{
						{
							Name:    step.Name,
							Image:   step.Image,
							Command: []string{"sh", "-c"},
							Args:    []string{step.Script},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: ptr.To(false),
								Capabilities: &corev1.Capabilities{
									Drop: []corev1.Capability{"ALL"},
								},
								RunAsNonRoot: ptr.To(true),
								RunAsUser:    ptr.To(int64(1000)),
								SeccompProfile: &corev1.SeccompProfile{
									Type: corev1.SeccompProfileTypeRuntimeDefault,
								},
							},
						},
					},
				},
			},
		},
	}

	created, err := e.Client.BatchV1().Jobs(e.Namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("create job %s: %w", jobName, err)
	}
	return created, nil
}

// GetStepLogs retrieves logs for a specific step in a pipeline.
func (e *WorkflowEngineImpl) GetStepLogs(ctx context.Context, pipelineName, stepName string) (string, error) {
	pods, err := e.Client.CoreV1().Pods(e.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("paprika.io/pipeline=%s,paprika.io/step=%s", pipelineName, stepName),
	})
	if err != nil {
		return "", fmt.Errorf("failed to list pods: %w", err)
	}
	if len(pods.Items) == 0 {
		return "", fmt.Errorf("no pods found for step %q in pipeline %q", stepName, pipelineName)
	}

	var logs []string
	for i := range pods.Items {
		log, err := e.Client.CoreV1().Pods(e.Namespace).GetLogs(pods.Items[i].Name, &corev1.PodLogOptions{}).DoRaw(ctx)
		if err != nil {
			continue
		}
		logs = append(logs, string(log))
	}

	return strings.Join(logs, "\n"), nil
}

// ExecuteStep creates a step job and returns it without watching.
func (e *WorkflowEngineImpl) ExecuteStep(ctx context.Context, step *paprika.PipelineStep, pipelineName string) (*batchv1.Job, error) {
	return e.CreateStepJob(ctx, step, pipelineName)
}

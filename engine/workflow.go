package engine

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/utils/ptr"

	paprika "github.com/benebsworth/paprika/api/v1alpha1"
)

type Node struct {
	Name      string
	DependsOn []string
	Step      paprika.PipelineStep
}

type Graph struct {
	Nodes map[string]*Node
}

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

func (g *Graph) TopologicalSort() ([][]paprika.PipelineStep, error) {
	inDegree := make(map[string]int)
	for _, n := range g.Nodes {
		if _, ok := inDegree[n.Name]; !ok {
			inDegree[n.Name] = 0
		}
		for _, dep := range n.DependsOn {
			if _, exists := g.Nodes[dep]; !exists {
				return nil, fmt.Errorf("step %q depends on unknown step %q", n.Name, dep)
			}
			inDegree[n.Name]++
		}
	}

	visited := make(map[string]bool)
	var detectCycles func(name string, path map[string]bool) error
	detectCycles = func(name string, path map[string]bool) error {
		if path[name] {
			var cycle []string
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
			if err := detectCycles(dep, path); err != nil {
				return err
			}
		}
		delete(path, name)
		return nil
	}
	for name := range g.Nodes {
		if err := detectCycles(name, make(map[string]bool)); err != nil {
			return nil, err
		}
	}

	var batches [][]paprika.PipelineStep
	remaining := make(map[string]*Node)
	for k, v := range g.Nodes {
		remaining[k] = v
	}

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

func ResolveDAG(steps []paprika.PipelineStep) ([][]paprika.PipelineStep, error) {
	g := NewGraph(steps)
	return g.TopologicalSort()
}

type WorkflowEngine struct {
	Client    kubernetes.Interface
	Namespace string
}

func NewWorkflowEngine(client kubernetes.Interface, namespace string) *WorkflowEngine {
	return &WorkflowEngine{
		Client:    client,
		Namespace: namespace,
	}
}

func (e *WorkflowEngine) RunPipeline(ctx context.Context, pipeline *paprika.Pipeline) ([]paprika.StepStatus, error) {
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

func (e *WorkflowEngine) executeBatch(ctx context.Context, batch []paprika.PipelineStep, pipelineName string, maxParallel int, completed map[string]bool, stepStatuses *[]paprika.StepStatus) error {
	for i := 0; i < len(batch); i += maxParallel {
		end := i + maxParallel
		if end > len(batch) {
			end = len(batch)
		}
		subBatch := batch[i:end]

		if err := e.executeSubBatch(ctx, subBatch, pipelineName, completed, stepStatuses); err != nil {
			return err
		}
	}
	return nil
}

func (e *WorkflowEngine) executeSubBatch(ctx context.Context, batch []paprika.PipelineStep, pipelineName string, completed map[string]bool, stepStatuses *[]paprika.StepStatus) error {
	var mu sync.Mutex
	var wg sync.WaitGroup
	errCh := make(chan error, len(batch))

	for _, step := range batch {
		wg.Add(1)
		go func(s paprika.PipelineStep) {
			defer wg.Done()

			for dep := range s.Depends {
				if !completed[s.Depends[dep]] {
					status := paprika.StepStatus{Name: s.Name, Phase: paprika.StepSkipped}
					mu.Lock()
					*stepStatuses = append(*stepStatuses, status)
					mu.Unlock()
					return
				}
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
				for attempt := 0; attempt < s.Retry; attempt++ {
					status.StartedAt = &now
					job, err := e.CreateStepJob(ctx, s, pipelineName)
					if err != nil {
						errCh <- fmt.Errorf("step %q: retry %d failed to create job: %w", s.Name, attempt+1, err)
						break
					}
					stepResult = e.watchJob(ctx, job, pipelineName)
					if stepResult.Phase == paprika.StepSucceeded {
						status.Phase = paprika.StepSucceeded
						break
					}
				}
			}

			mu.Lock()
			*stepStatuses = append(*stepStatuses, status)
			completed[s.Name] = status.Phase == paprika.StepSucceeded
			mu.Unlock()

			if status.Phase == paprika.StepFailed {
				errCh <- fmt.Errorf("step %q: failed after %d retries", s.Name, s.Retry)
			}
		}(step)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		return err
	}
	return nil
}

type stepResult struct {
	Phase       paprika.StepPhase
	CompletedAt *metav1.Time
}

func (e *WorkflowEngine) watchJob(ctx context.Context, job *batchv1.Job, pipelineName string) stepResult {
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
			j, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			for _, c := range j.Status.Conditions {
				if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
					now := metav1.Now()
					return stepResult{Phase: paprika.StepSucceeded, CompletedAt: &now}
				}
				if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
					now := metav1.Now()
					return stepResult{Phase: paprika.StepFailed, CompletedAt: &now}
				}
			}
		case <-timeout:
			return stepResult{Phase: paprika.StepFailed}
		case <-ctx.Done():
			return stepResult{Phase: paprika.StepFailed}
		}
	}
}

func (e *WorkflowEngine) CreateStepJob(ctx context.Context, step paprika.PipelineStep, pipelineName string) (*batchv1.Job, error) {
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

	return e.Client.BatchV1().Jobs(e.Namespace).Create(ctx, job, metav1.CreateOptions{})
}

func (e *WorkflowEngine) GetStepLogs(ctx context.Context, pipelineName, stepName string) (string, error) {
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
	for _, pod := range pods.Items {
		log, err := e.Client.CoreV1().Pods(e.Namespace).GetLogs(pod.Name, &corev1.PodLogOptions{}).DoRaw(ctx)
		if err != nil {
			continue
		}
		logs = append(logs, string(log))
	}

	return strings.Join(logs, "\n"), nil
}

func (e *WorkflowEngine) ExecuteStep(ctx context.Context, step paprika.PipelineStep, pipelineName string) (*batchv1.Job, error) {
	return e.CreateStepJob(ctx, step, pipelineName)
}

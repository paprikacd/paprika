package apiserver

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

const (
	pipelineLabelKey = "paprika.io/pipeline"
	stepLabelKey     = "paprika.io/step"
	jobNameLabelKey  = "job-name"
)

// GetPipeline returns a single pipeline by name and namespace.
func (s *PaprikaServer) GetPipeline(
	ctx context.Context,
	req *connect.Request[paprikav1.GetPipelineRequest],
) (*connect.Response[paprikav1.GetPipelineResponse], error) {
	var pipeline pipelinesv1alpha1.Pipeline
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &pipeline); err != nil {
		return nil, fmt.Errorf("getting pipeline: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &pipeline, auth.ResourcePipelines) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}
	return connect.NewResponse(&paprikav1.GetPipelineResponse{
		Pipeline: convertPipeline(&pipeline),
	}), nil
}

// RetryStep resets a failed or skipped step to Pending so the pipeline
// controller will execute it again.
func (s *PaprikaServer) RetryStep(
	ctx context.Context,
	req *connect.Request[paprikav1.RetryStepRequest],
) (*connect.Response[paprikav1.RetryStepResponse], error) {
	var pipeline pipelinesv1alpha1.Pipeline
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.PipelineNamespace, Name: req.Msg.PipelineName}, &pipeline); err != nil {
		return nil, fmt.Errorf("getting pipeline: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &pipeline, auth.ResourcePipelines) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}

	found := false
	for i, st := range pipeline.Status.StepStatuses {
		if st.Name != req.Msg.StepName {
			continue
		}
		if st.Phase != pipelinesv1alpha1.StepFailed && st.Phase != pipelinesv1alpha1.StepSkipped {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("cannot retry step %q in phase %s", req.Msg.StepName, st.Phase))
		}
		pipeline.Status.StepStatuses[i].Phase = pipelinesv1alpha1.StepPending
		pipeline.Status.StepStatuses[i].CompletedAt = nil
		found = true
		break
	}
	if !found {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("step %q not found", req.Msg.StepName))
	}

	if err := s.client.Status().Update(ctx, &pipeline); err != nil {
		return nil, fmt.Errorf("updating pipeline status: %w", err)
	}
	s.publishPipelineEvent(ctx, &pipeline, req.Msg.StepName)
	return connect.NewResponse(&paprikav1.RetryStepResponse{}), nil
}

// SkipStep marks a pending step as skipped.
func (s *PaprikaServer) SkipStep(
	ctx context.Context,
	req *connect.Request[paprikav1.SkipStepRequest],
) (*connect.Response[paprikav1.SkipStepResponse], error) {
	var pipeline pipelinesv1alpha1.Pipeline
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.PipelineNamespace, Name: req.Msg.PipelineName}, &pipeline); err != nil {
		return nil, fmt.Errorf("getting pipeline: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &pipeline, auth.ResourcePipelines) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}

	found := false
	now := metav1.Now()
	for i, st := range pipeline.Status.StepStatuses {
		if st.Name != req.Msg.StepName {
			continue
		}
		if st.Phase != pipelinesv1alpha1.StepPending {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("cannot skip step %q in phase %s", req.Msg.StepName, st.Phase))
		}
		pipeline.Status.StepStatuses[i].Phase = pipelinesv1alpha1.StepSkipped
		pipeline.Status.StepStatuses[i].CompletedAt = &now
		found = true
		break
	}
	if !found {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("step %q not found", req.Msg.StepName))
	}

	if err := s.client.Status().Update(ctx, &pipeline); err != nil {
		return nil, fmt.Errorf("updating pipeline status: %w", err)
	}
	s.publishPipelineEvent(ctx, &pipeline, req.Msg.StepName)
	return connect.NewResponse(&paprikav1.SkipStepResponse{}), nil
}

// CancelPipeline cancels a running pipeline and deletes its active Jobs.
func (s *PaprikaServer) CancelPipeline(
	ctx context.Context,
	req *connect.Request[paprikav1.CancelPipelineRequest],
) (*connect.Response[paprikav1.CancelPipelineResponse], error) {
	var pipeline pipelinesv1alpha1.Pipeline
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &pipeline); err != nil {
		return nil, fmt.Errorf("getting pipeline: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &pipeline, auth.ResourcePipelines) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}

	if pipeline.Status.Phase == pipelinesv1alpha1.PipelineSucceeded ||
		pipeline.Status.Phase == pipelinesv1alpha1.PipelineFailed ||
		pipeline.Status.Phase == pipelinesv1alpha1.PipelineCancelled {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("pipeline already in terminal phase %s", pipeline.Status.Phase))
	}

	pipeline.Status.Phase = pipelinesv1alpha1.PipelineCancelled
	now := metav1.Now()
	for i, st := range pipeline.Status.StepStatuses {
		if st.Phase == pipelinesv1alpha1.StepRunning {
			pipeline.Status.StepStatuses[i].Phase = pipelinesv1alpha1.StepCancelled
			pipeline.Status.StepStatuses[i].CompletedAt = &now
		}
	}

	if err := s.client.Status().Update(ctx, &pipeline); err != nil {
		return nil, fmt.Errorf("updating pipeline status: %w", err)
	}

	if s.k8sClient != nil {
		if err := s.k8sClient.BatchV1().Jobs(pipeline.Namespace).DeleteCollection(ctx,
			metav1.DeleteOptions{},
			metav1.ListOptions{LabelSelector: fmt.Sprintf("%s=%s", pipelineLabelKey, pipeline.Name)},
		); err != nil {
			return nil, fmt.Errorf("deleting pipeline jobs: %w", err)
		}
	}

	s.publishPipelineEvent(ctx, &pipeline, "")
	return connect.NewResponse(&paprikav1.CancelPipelineResponse{}), nil
}

// GetStepLogs returns the logs for a single pipeline step, preferring the most
// recent Job when a step has been retried.
func (s *PaprikaServer) GetStepLogs(
	ctx context.Context,
	req *connect.Request[paprikav1.GetStepLogsRequest],
) (*connect.Response[paprikav1.GetStepLogsResponse], error) {
	var pipeline pipelinesv1alpha1.Pipeline
	if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.PipelineNamespace, Name: req.Msg.PipelineName}, &pipeline); err != nil {
		return nil, fmt.Errorf("getting pipeline: %w", err)
	}
	if !s.authorizeProjectFromLabels(ctx, &pipeline, auth.ResourcePipelines) {
		return nil, connect.NewError(connect.CodePermissionDenied, auth.ErrUnauthorized)
	}
	if s.k8sClient == nil {
		return nil, connect.NewError(connect.CodeUnimplemented,
			fmt.Errorf("step logs are not available on this server"))
	}

	jobs, err := s.k8sClient.BatchV1().Jobs(req.Msg.PipelineNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s,%s=%s", pipelineLabelKey, req.Msg.PipelineName, stepLabelKey, req.Msg.StepName),
	})
	if err != nil {
		return nil, fmt.Errorf("listing step jobs: %w", err)
	}
	if len(jobs.Items) == 0 {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("step %q has not been executed", req.Msg.StepName))
	}

	sort.Slice(jobs.Items, func(i, j int) bool {
		return jobs.Items[i].CreationTimestamp.After(jobs.Items[j].CreationTimestamp.Time)
	})
	job := jobs.Items[0]

	pods, err := s.k8sClient.CoreV1().Pods(req.Msg.PipelineNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s", jobNameLabelKey, job.Name),
	})
	if err != nil {
		return nil, fmt.Errorf("listing job pods: %w", err)
	}
	if len(pods.Items) == 0 {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("logs for step %q are no longer available", req.Msg.StepName))
	}

	podLogOpts := &corev1.PodLogOptions{}
	if req.Msg.TailLines > 0 {
		tl := int64(min(req.Msg.TailLines, 10000))
		podLogOpts.TailLines = &tl
	}

	logStream, err := s.k8sClient.CoreV1().Pods(req.Msg.PipelineNamespace).GetLogs(pods.Items[0].Name, podLogOpts).Stream(ctx)
	if err != nil {
		return nil, fmt.Errorf("streaming step logs: %w", err)
	}
	defer logStream.Close()

	buf := new(strings.Builder)
	if _, err := io.Copy(buf, logStream); err != nil {
		return nil, fmt.Errorf("reading step logs: %w", err)
	}
	return connect.NewResponse(&paprikav1.GetStepLogsResponse{Logs: buf.String()}), nil
}

func (s *PaprikaServer) publishPipelineEvent(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, stepName string) {
	if s.broker == nil {
		return
	}
	phase := string(pipeline.Status.Phase)
	if stepName != "" {
		for _, st := range pipeline.Status.StepStatuses {
			if st.Name == stepName {
				phase = string(st.Phase)
				break
			}
		}
	}
	evt, err := events.NewEvent(events.TypePipeline, events.EventPayload{
		ResourceType: events.TypePipeline,
		Name:         stepName,
		Namespace:    pipeline.Namespace,
		Phase:        phase,
		Timestamp:    time.Now().UTC().Format(time.RFC3339),
	}, s.Clock)
	if err != nil {
		return
	}
	topic := fmt.Sprintf("pipeline/%s/%s", pipeline.Namespace, pipeline.Name)
	s.broker.Publish(ctx, topic, evt)
}

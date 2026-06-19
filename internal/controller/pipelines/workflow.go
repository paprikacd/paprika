// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	batchv1 "k8s.io/api/batch/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

//go:generate mockgen -destination=mocks/workflow_engine.go -package=mocks -typed . WorkflowEngine

// PipelineRunner executes a pipeline workflow.
type PipelineRunner interface {
	RunPipeline(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) ([]pipelinesv1alpha1.StepStatus, error)
}

// StepJobCreator creates a Kubernetes Job for a pipeline step.
type StepJobCreator interface {
	CreateStepJob(ctx context.Context, step *pipelinesv1alpha1.PipelineStep, pipelineName string) (*batchv1.Job, error)
}

// StepLogGetter retrieves logs for a pipeline step.
type StepLogGetter interface {
	GetStepLogs(ctx context.Context, pipelineName, stepName string) (string, error)
}

// WorkflowEngine executes pipeline workflows by creating Kubernetes jobs.
type WorkflowEngine interface {
	PipelineRunner
	StepJobCreator
	StepLogGetter
}

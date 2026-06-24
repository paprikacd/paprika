// Package progress defines callback types used by the pipeline controller
// and workflow engine to report step-level progress without introducing
// import cycles.
package progress

import (
	"context"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// StepProgressCallback is invoked by the workflow engine when a step changes phase.
type StepProgressCallback func(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, step pipelinesv1alpha1.StepStatus)

package pipelines

import (
	"context"
	"fmt"
	"sort"

	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const (
	PipelineLabelKey           = "paprika.io/pipeline"
	StepLabelKey               = "paprika.io/step"
	OutputLabelKey             = "paprika.io/output"
	ProducingStepAnnotationKey = "paprika.io/producing-step"
)

func GetArtifactsForPipelineStep(ctx context.Context, c client.Client, pipeline *pipelinesv1alpha1.Pipeline, stepName string) ([]pipelinesv1alpha1.Artifact, error) {
	list := &pipelinesv1alpha1.ArtifactList{}
	if err := c.List(ctx, list,
		client.InNamespace(pipeline.Namespace),
		client.MatchingLabels{
			PipelineLabelKey: pipeline.Name,
			StepLabelKey:     stepName,
		},
	); err != nil {
		return nil, fmt.Errorf("listing artifacts for pipeline step: %w", err)
	}

	artifacts := make([]pipelinesv1alpha1.Artifact, len(list.Items))
	copy(artifacts, list.Items)
	sort.Slice(artifacts, func(i, j int) bool {
		return artifacts[i].Name < artifacts[j].Name
	})
	return artifacts, nil
}

package pipelines

import (
	"context"
	"crypto/sha256"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const (
	PipelineLabelKey = "paprika.io/pipeline"
	StepLabelKey     = "paprika.io/step"
)

var invalidNameChar = regexp.MustCompile(`[^a-z0-9.-]`)

func sanitizeNamePart(part string) string {
	part = strings.ToLower(part)
	part = invalidNameChar.ReplaceAllString(part, "-")
	part = strings.Trim(part, "-.")
	return part
}

func BuildArtifactName(pipelineName, stepName, outputName string) string {
	pipeline := sanitizeNamePart(pipelineName)
	step := sanitizeNamePart(stepName)
	output := sanitizeNamePart(outputName)

	name := fmt.Sprintf("%s-%s-%s", pipeline, step, output)
	if len(name) <= 253 {
		return name
	}

	hash := sha256.Sum256([]byte(name))
	suffix := fmt.Sprintf("-%08x", hash[:4])
	maxPrefix := 253 - len(suffix)
	return name[:maxPrefix] + suffix
}

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

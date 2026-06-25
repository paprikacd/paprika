package pipelines

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestGetArtifactsForPipelineStep(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: "ci-pipeline", Namespace: "default"},
	}

	matching := []*pipelinesv1alpha1.Artifact{
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "alpha",
				Namespace: "default",
				Labels: map[string]string{
					PipelineLabelKey: pipeline.Name,
					StepLabelKey:     "build",
				},
			},
		},
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "beta",
				Namespace: "default",
				Labels: map[string]string{
					PipelineLabelKey: pipeline.Name,
					StepLabelKey:     "build",
				},
			},
		},
	}

	otherStep := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "gamma",
			Namespace: "default",
			Labels: map[string]string{
				PipelineLabelKey: pipeline.Name,
				StepLabelKey:     "test",
			},
		},
	}

	otherPipeline := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "delta",
			Namespace: "default",
			Labels: map[string]string{
				PipelineLabelKey: "other-pipeline",
				StepLabelKey:     "build",
			},
		},
	}

	otherNamespace := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "epsilon",
			Namespace: "other",
			Labels: map[string]string{
				PipelineLabelKey: pipeline.Name,
				StepLabelKey:     "build",
			},
		},
	}

	objs := []client.Object{
		pipeline,
		matching[0],
		matching[1],
		otherStep,
		otherPipeline,
		otherNamespace,
	}
	c := newTestClient(t, objs...)

	t.Run("returns matching artifacts sorted by name", func(t *testing.T) {
		t.Parallel()
		artifacts, err := GetArtifactsForPipelineStep(ctx, c, pipeline, "build")
		require.NoError(t, err)
		require.Len(t, artifacts, 2)
		assert.Equal(t, "alpha", artifacts[0].Name)
		assert.Equal(t, "beta", artifacts[1].Name)
	})

	t.Run("returns empty when step has no artifacts", func(t *testing.T) {
		t.Parallel()
		artifacts, err := GetArtifactsForPipelineStep(ctx, c, pipeline, "missing")
		require.NoError(t, err)
		assert.Empty(t, artifacts)
	})
}

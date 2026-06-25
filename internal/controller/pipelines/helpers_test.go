package pipelines

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestBuildArtifactName(t *testing.T) {
	t.Parallel()

	t.Run("concatenates sanitized components", func(t *testing.T) {
		t.Parallel()
		name := BuildArtifactName("MyPipeline", "build_Step", "docker-image")
		assert.Equal(t, "mypipeline-build-step-docker-image", name)
	})

	t.Run("sanitizes invalid characters", func(t *testing.T) {
		t.Parallel()
		name := BuildArtifactName("pipeline@prod", "step/one", "output_name!")
		assert.Equal(t, "pipeline-prod-step-one-output-name", name)
	})

	t.Run("trims leading and trailing separators", func(t *testing.T) {
		t.Parallel()
		name := BuildArtifactName("-pipeline-", ".step.", "-output-")
		assert.Equal(t, "pipeline-step-output", name)
	})

	t.Run("fits long names within 253 characters", func(t *testing.T) {
		t.Parallel()
		pipeline := strings.Repeat("a", 100)
		step := strings.Repeat("b", 100)
		output := strings.Repeat("c", 100)
		name := BuildArtifactName(pipeline, step, output)
		assert.LessOrEqual(t, len(name), 253)
		assert.Regexp(t, `^[a-z0-9.-]+-[a-f0-9]{8}$`, name)
	})

	t.Run("hash is deterministic for the same input", func(t *testing.T) {
		t.Parallel()
		pipeline := strings.Repeat("a", 100)
		step := strings.Repeat("b", 100)
		output := strings.Repeat("c", 100)
		first := BuildArtifactName(pipeline, step, output)
		second := BuildArtifactName(pipeline, step, output)
		assert.Equal(t, first, second)
	})

	t.Run("preserves short name unchanged", func(t *testing.T) {
		t.Parallel()
		name := BuildArtifactName("p", "s", "o")
		assert.Equal(t, "p-s-o", name)
	})
}

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

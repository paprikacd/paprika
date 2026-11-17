package engine

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/client-go/kubernetes/fake"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestStepJobLabelsIncludePipelineNamespace(t *testing.T) {
	t.Parallel()
	e := NewWorkflowEngine(fake.NewSimpleClientset(), "paprika-system")
	step := &paprika.PipelineStep{Name: "deepcheck", Image: "busybox", Script: "true"}

	job, err := e.createStepJob(t.Context(), step, "tests-abc", "tenant")
	require.NoError(t, err)
	want := map[string]string{StepPipelineLabelKey: "tests-abc", StepPipelineNamespaceLabelKey: "tenant", StepNameLabelKey: "deepcheck"}
	require.Equal(t, want, job.Labels)
	require.Equal(t, want, job.Spec.Template.Labels, "pods carry the same labels so GetStepLogs keeps working")
	require.Equal(t, "paprika-system", job.Namespace)
}

func TestCreateStepJobWithoutNamespaceOmitsNamespaceLabel(t *testing.T) {
	t.Parallel()
	e := NewWorkflowEngine(fake.NewSimpleClientset(), "paprika-system")
	job, err := e.CreateStepJob(t.Context(), &paprika.PipelineStep{Name: "s", Image: "busybox", Script: "true"}, "p")
	require.NoError(t, err)
	require.NotContains(t, job.Labels, StepPipelineNamespaceLabelKey)
	require.Equal(t, "p", job.Labels[StepPipelineLabelKey])
}

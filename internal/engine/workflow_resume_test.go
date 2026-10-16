package engine

import (
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestRunPipelineResumePreservesUnrelatedFailures(t *testing.T) {
	t.Parallel()
	pipeline := &api.Pipeline{ObjectMeta: metav1.ObjectMeta{Name: "resume", Generation: 1},
		Spec:   api.PipelineSpec{Steps: []api.PipelineStep{{Name: "retained", Image: "test", Script: "must-not-run"}, {Name: "dependent", Image: "test", Script: "must-not-run", Depends: []string{"retained"}}}},
		Status: api.PipelineStatus{ObservedGeneration: 1, StepStatuses: []api.StepStatus{{Name: "retained", Phase: api.StepFailed}, {Name: "dependent", Phase: api.StepSkipped}}}}
	kube := fake.NewSimpleClientset()
	statuses, err := NewWorkflowEngine(kube, "jobs").RunPipeline(t.Context(), pipeline, nil)
	require.NoError(t, err)
	require.Len(t, statuses, 2)
	require.Equal(t, api.StepFailed, statuses[0].Phase)
	require.Equal(t, api.StepSkipped, statuses[1].Phase)
	jobs, err := kube.BatchV1().Jobs("jobs").List(t.Context(), metav1.ListOptions{})
	require.NoError(t, err)
	require.Empty(t, jobs.Items, "an unrelated failed branch must not be retried implicitly")
}

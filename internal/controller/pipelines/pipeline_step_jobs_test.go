package pipelines

import (
	"testing"

	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

func stepJob(name string, labels map[string]string) *batchv1.Job {
	return &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "paprika-system", UID: types.UID(name + "-uid"), Labels: labels}}
}

func TestPipelineDeletionDeletesOnlyItsStepJobs(t *testing.T) {
	t.Parallel()
	now := metav1.Now()
	pipeline := &api.Pipeline{ObjectMeta: metav1.ObjectMeta{
		Name: "app-promotion-tests-abc", Namespace: "tenant", DeletionTimestamp: &now, Finalizers: []string{pipelineFinalizer},
	}}
	k8s := k8sfake.NewSimpleClientset(
		stepJob("own", engine.StepJobLabels("app-promotion-tests-abc", "tenant", "deepcheck")),
		stepJob("legacy", map[string]string{engine.StepPipelineLabelKey: "app-promotion-tests-abc", engine.StepNameLabelKey: "signin"}),
		stepJob("same-name-other-namespace", engine.StepJobLabels("app-promotion-tests-abc", "other", "deepcheck")),
		stepJob("other-pipeline", engine.StepJobLabels("app-promotion-tests-def", "tenant", "deepcheck")),
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "elsewhere", Namespace: "tenant", Labels: engine.StepJobLabels("app-promotion-tests-abc", "tenant", "x")}},
	)
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).Build()
	r := &PipelineReconciler{client: c, Scheme: scheme, K8sClient: k8s, Namespace: "paprika-system"}

	var live api.Pipeline
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &live))
	require.NoError(t, r.handlePipelineDeletion(t.Context(), &live))

	remaining, err := k8s.BatchV1().Jobs("paprika-system").List(t.Context(), metav1.ListOptions{})
	require.NoError(t, err)
	names := make([]string, 0, len(remaining.Items))
	for _, j := range remaining.Items {
		names = append(names, j.Name)
	}
	require.ElementsMatch(t, []string{"same-name-other-namespace", "other-pipeline"}, names)
	_, err = k8s.BatchV1().Jobs("tenant").Get(t.Context(), "elsewhere", metav1.GetOptions{})
	require.NoError(t, err, "only the operator namespace holds step jobs")

	err = c.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &live)
	require.Error(t, err, "the finalizer is removed once the jobs are gone")
}

func TestPipelineDeletionWithoutJobClientStillReleasesFinalizer(t *testing.T) {
	t.Parallel()
	now := metav1.Now()
	pipeline := &api.Pipeline{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "tenant", DeletionTimestamp: &now, Finalizers: []string{pipelineFinalizer}}}
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).Build()
	r := &PipelineReconciler{client: c, Scheme: scheme}
	var live api.Pipeline
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(pipeline), &live))
	require.NoError(t, r.handlePipelineDeletion(t.Context(), &live))
}

package pipelines

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

func historyApp(name string) *api.Application {
	return &api.Application{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "prod", UID: "app-uid"},
		Spec: api.ApplicationSpec{Trigger: &api.ApplicationTrigger{Type: api.ApplicationTriggerPromotion,
			Tests: &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "check", Image: "busybox", Script: "true"}}}}},
	}
}

func historyPipeline(app *api.Application, suffix string, age int, phase api.PipelinePhase) api.Pipeline {
	return api.Pipeline{
		ObjectMeta: metav1.ObjectMeta{
			Name: promotionPipelinePrefix(app) + suffix, Namespace: app.Namespace,
			CreationTimestamp: metav1.NewTime(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).Add(-time.Duration(age) * time.Hour)),
			Labels:            map[string]string{engine.ApplicationNameLabelKey: app.Name},
			Annotations:       map[string]string{promotionReleaseUIDAnnotation: "release-" + suffix},
			OwnerReferences:   []metav1.OwnerReference{{APIVersion: api.GroupVersion.String(), Kind: "Application", Name: app.Name, UID: app.UID, Controller: ptr(true)}},
		},
		Status: api.PipelineStatus{Phase: phase},
	}
}

func prunedNames(pruned []*api.Pipeline) []string {
	names := make([]string, 0, len(pruned))
	for _, p := range pruned {
		names = append(names, p.Name)
	}
	return names
}

func TestPromotionPipelinesToPruneKeepsHistoryAndProtectedPipelines(t *testing.T) {
	t.Parallel()
	app := historyApp("api-prod")
	app.Status.Promotion = &api.ApplicationPromotionStatus{VerificationPipelineRef: promotionPipelinePrefix(app) + "referenced"}

	var pipelines []api.Pipeline
	for i := 0; i < 14; i++ {
		pipelines = append(pipelines, historyPipeline(app, fmt.Sprintf("%012d", i), i, api.PipelineSucceeded))
	}
	pipelines = append(pipelines,
		historyPipeline(app, "referenced", 100, api.PipelineFailed),
		historyPipeline(app, "running0000", 200, api.PipelineRunning),
		historyPipeline(app, "pending0000", 300, ""),
	)
	foreign := historyPipeline(app, "foreign00000", 400, api.PipelineSucceeded)
	foreign.OwnerReferences[0].UID = "other-uid"
	build := historyPipeline(app, "build0000000", 500, api.PipelineSucceeded)
	build.Name = "api-prod-build-xyz"
	unannotated := historyPipeline(app, "noannot00000", 600, api.PipelineSucceeded)
	unannotated.Annotations = nil
	pipelines = append(pipelines, foreign, build, unannotated)

	pruned := prunedNames(promotionPipelinesToPrune(app, pipelines))
	want := []string{}
	for i := 10; i < 14; i++ {
		want = append(want, promotionPipelinePrefix(app)+fmt.Sprintf("%012d", i))
	}
	require.ElementsMatch(t, want, pruned, "only the oldest finished promotion pipelines beyond the history limit are pruned")
}

func TestPromotionPipelinesToPruneProtectsCurrentCandidateName(t *testing.T) {
	t.Parallel()
	app := historyApp("api-prod")
	app.Status.Promotion = &api.ApplicationPromotionStatus{SourceApplicationUID: "src", SourceReleaseUID: "rel"}
	current, err := promotionPipelineName(app)
	require.NoError(t, err)
	var pipelines []api.Pipeline
	for i := 0; i < 11; i++ {
		pipelines = append(pipelines, historyPipeline(app, fmt.Sprintf("%012d", i), i, api.PipelineSucceeded))
	}
	old := historyPipeline(app, "x", 1000, api.PipelineSucceeded)
	old.Name = current
	pipelines = append(pipelines, old)
	pruned := prunedNames(promotionPipelinesToPrune(app, pipelines))
	require.NotContains(t, pruned, current, "deleting the current candidate's pipeline would rerun its tests")
	require.Equal(t, []string{promotionPipelinePrefix(app) + fmt.Sprintf("%012d", 10)}, pruned)
}

func TestPromotionPipelinePrefixMatchesLongApplicationNames(t *testing.T) {
	t.Parallel()
	app := historyApp(strings.Repeat("a", 60))
	app.Status.Promotion = &api.ApplicationPromotionStatus{SourceApplicationUID: "src", SourceReleaseUID: "rel"}
	name, err := promotionPipelineName(app)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(name, promotionPipelinePrefix(app)), "%q must start with %q", name, promotionPipelinePrefix(app))
	require.Len(t, name, len(promotionPipelinePrefix(app))+12)
}

func TestPruneOldPromotionPipelinesDeletesFromCluster(t *testing.T) {
	t.Parallel()
	app := historyApp("api-prod")
	objects := []client.Object{app}
	for i := 0; i < 12; i++ {
		p := historyPipeline(app, fmt.Sprintf("%012d", i), i, api.PipelineSucceeded)
		objects = append(objects, &p)
	}
	r := newPromotionTestReconciler(t, objects...)
	deleted, err := r.pruneOldPromotionPipelines(t.Context(), app)
	require.NoError(t, err)
	require.Equal(t, 2, deleted)
	var list api.PipelineList
	require.NoError(t, r.client.List(t.Context(), &list, client.InNamespace(app.Namespace)))
	require.Len(t, list.Items, maxPromotionPipelineHistory)

	noTests := historyApp("api-prod")
	noTests.Spec.Trigger = nil
	deleted, err = r.pruneOldPromotionPipelines(t.Context(), noTests)
	require.NoError(t, err)
	require.Zero(t, deleted)
}

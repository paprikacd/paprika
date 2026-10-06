package pipelines

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/health"
	"github.com/benebsworth/paprika/internal/syncwindow"
)

func TestAcceptedPromotionHealthPolicyPersistsAfterPendingRemoval(t *testing.T) {
	app := triggerPolicyApp(api.ApplicationTriggerPromotion)
	check := api.HealthCheck{Name: "accepted", Expression: "app.parameters.version == 'accepted'", Interval: "30s"}
	app.Spec.Parameters = map[string]string{"version": "accepted"}
	app.Spec.HealthChecks = []api.HealthCheck{check}
	app.Status.ReleaseRef = "accepted-release"
	app.Status.AcceptedDeployment = app.Spec.DeepCopy()
	app.Spec.Parameters["version"] = "pending"
	app.Spec.HealthChecks = nil
	r := triggerPolicyReconciler(t, app)
	r.HealthEval = health.NewCELEvaluator()
	r.now = func() time.Time { return promotionTestNow }

	require.NoError(t, r.reconcileHealthStatus(context.Background(), app))
	require.Equal(t, api.HealthHealthy, app.Status.Health)
	require.Len(t, app.Status.HealthChecks, 1)
	require.Equal(t, check.Name, app.Status.HealthChecks[0].Name)
	require.Equal(t, health.MeasurementHash(check), app.Status.HealthChecks[0].ConfigurationHash)
	require.Nil(t, app.Spec.HealthChecks)
	require.Equal(t, "pending", app.Spec.Parameters["version"])
	require.Equal(t, 30*time.Second, nextHealthObservation(app, promotionTestNow))
	var persisted api.Application
	require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(app), &persisted))
	require.Equal(t, app.Status.HealthChecks, persisted.Status.HealthChecks)
	require.Equal(t, "accepted-release", persisted.Status.ReleaseRef)
}

func TestPromotionSourceReadyRequiresAcceptedHealthAndAnalysisPolicy(t *testing.T) {
	for _, policy := range []string{"health check", "analysis"} {
		t.Run(policy, func(t *testing.T) {
			_, upstream, release := promotionFixture()
			upstream.Spec.Trigger = &api.ApplicationTrigger{Type: api.ApplicationTriggerPromotion}
			if policy == "health check" {
				upstream.Spec.HealthChecks = []api.HealthCheck{{Name: "accepted", Expression: "false"}}
			} else {
				upstream.Spec.AnalysisTemplates = []api.AnalysisTemplateRef{{Name: "accepted"}}
			}
			upstream.Status.AcceptedDeployment = upstream.Spec.DeepCopy()
			upstream.Spec.HealthChecks = nil
			upstream.Spec.AnalysisTemplates = nil
			require.Error(t, promotionSourceReady(upstream, release, promotionTestNow), "pending policy removal must not authorize downstream promotion")
		})
	}
}

func TestAcceptedPromotionAnalysisPolicyKeepsRunAndFailureAction(t *testing.T) {
	app := triggerPolicyApp(api.ApplicationTriggerPromotion)
	app.Spec.AnalysisTemplates = []api.AnalysisTemplateRef{{Name: "accepted", IntervalSeconds: 30, Args: map[string]string{"environment": "accepted"}, OnFailure: &api.FailureAction{Action: rollbackAction}}}
	app.Status = api.ApplicationStatus{Phase: api.ApplicationHealthy, ReleaseRef: "accepted-release", AcceptedDeployment: app.Spec.DeepCopy()}
	app.Spec.AnalysisTemplates = []api.AnalysisTemplateRef{{Name: "pending", IntervalSeconds: 1}}
	run := &api.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{Name: analysisRunName(app.Name, "accepted"), Namespace: app.Namespace, Labels: map[string]string{engine.ApplicationNameLabelKey: app.Name}},
		Spec:       api.AnalysisRunSpec{TemplateRef: "accepted", ApplicationRef: app.Name, IntervalSeconds: 30, Args: map[string]string{"environment": "accepted"}},
		Status:     api.AnalysisRunStatus{Phase: api.AnalysisRunFailed, Results: []api.AnalysisRunResult{{Passed: false, CheckedAt: &metav1.Time{Time: promotionTestNow}}}},
	}
	release := &api.Release{ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, Status: api.ReleaseStatus{Phase: api.ReleaseComplete}}
	r := triggerPolicyReconciler(t, app, run, release)
	ctx := context.Background()

	require.NoError(t, r.reconcileAnalysisRuns(ctx, app))
	var existing api.AnalysisRun
	require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(run), &existing))
	require.EqualValues(t, 30, existing.Spec.IntervalSeconds)
	require.True(t, apierrors.IsNotFound(r.client.Get(ctx, client.ObjectKey{Name: analysisRunName(app.Name, "pending"), Namespace: app.Namespace}, &api.AnalysisRun{})))
	require.Len(t, app.Status.AnalysisResults, 1)
	require.Equal(t, "accepted", app.Status.AnalysisResults[0].Name)
	require.True(t, meta.IsStatusConditionTrue(app.Status.Conditions, "AnalysisFailed"))
	require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(release), release))
	require.NotEmpty(t, release.Annotations[rollbackAnnotation])
	require.Equal(t, "pending", app.Spec.AnalysisTemplates[0].Name)
}

func TestAcceptedPromotionSelfHealPolicyIgnoresPendingEdits(t *testing.T) {
	blockingWindow := []api.SyncWindow{{Kind: api.SyncWindowBlock, Schedule: "* * * * *", Duration: "2m"}}
	for _, test := range []struct {
		name     string
		accepted func(*api.ApplicationSpec)
		pending  func(*api.ApplicationSpec)
		resync   bool
	}{
		{name: "accepted policy survives pending disable", pending: func(spec *api.ApplicationSpec) { spec.SelfHeal = nil; spec.SyncPolicy = api.SyncManual }, resync: true},
		{name: "pending policy cannot enable repair", accepted: func(spec *api.ApplicationSpec) { spec.SelfHeal = nil }},
		{name: "pending automatic policy cannot bypass accepted manual", accepted: func(spec *api.ApplicationSpec) { spec.SyncPolicy = api.SyncManual }},
		{name: "pending window removal cannot bypass accepted block", accepted: func(spec *api.ApplicationSpec) { spec.SyncWindows = blockingWindow }, pending: func(spec *api.ApplicationSpec) { spec.SyncWindows = nil }},
		{name: "candidate admission window does not change repair policy", pending: func(spec *api.ApplicationSpec) { spec.SyncWindows = blockingWindow }, resync: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := triggerPolicyApp(api.ApplicationTriggerPromotion)
			app.Spec.SelfHeal = &api.SelfHealConfig{AutoSyncOnDrift: true}
			if test.accepted != nil {
				test.accepted(&app.Spec)
			}
			app.Status = api.ApplicationStatus{Phase: api.ApplicationHealthy, ReleaseRef: "accepted-release", OutOfSync: 1, AcceptedDeployment: app.Spec.DeepCopy()}
			if test.pending != nil {
				test.pending(&app.Spec)
			}
			release := &api.Release{ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, Status: api.ReleaseStatus{Phase: api.ReleaseComplete}}
			r := triggerPolicyReconciler(t, app, release)
			r.now = func() time.Time { return promotionTestNow }
			r.SyncWindowEvaluator = syncwindow.NewEvaluator()
			require.NoError(t, r.reconcileSelfHeal(context.Background(), app))
			require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(release), release))
			if test.resync {
				require.NotEmpty(t, release.Annotations[resyncAnnotation])
				require.NotNil(t, app.Status.LastSelfHealTime)
				require.True(t, meta.IsStatusConditionTrue(app.Status.Conditions, selfHealConditionType))
			} else {
				require.Empty(t, release.Annotations[resyncAnnotation])
			}
		})
	}
}

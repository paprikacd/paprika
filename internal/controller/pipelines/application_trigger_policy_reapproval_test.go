package pipelines

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
	"github.com/benebsworth/paprika/internal/source"
)

// Present stale informer health without changing the API's candidate identity.
// This models the cache lag between an approval and the next delivery reconcile.
type cachedPromotionSourceClient struct {
	client.Client
	source *api.Application
}

func (c *cachedPromotionSourceClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if c.source != nil && key == client.ObjectKeyFromObject(c.source) {
		if app, ok := obj.(*api.Application); ok {
			*app = *c.source.DeepCopy()
			return nil
		}
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

func secondManualPromotionFixture(t *testing.T) (*ApplicationReconciler, *api.Application, *api.Application, *api.Release, *api.Release) {
	t.Helper()
	app, upstream, upstreamRelease := promotionFixture()
	app.Spec.SyncPolicy = api.SyncManual
	app.Spec.Stages = []api.ApplicationPromotionStage{{Name: "prod"}}
	app.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "verify", Image: "busybox:1.37", Script: "true"}}}
	app.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 1}}
	oldRevision := strings.Repeat("a", 40)
	startedAt := metav1.NewTime(promotionTestNow.Add(-5 * time.Second))
	app.Status = api.ApplicationStatus{
		Phase: api.ApplicationHealthy, SourceRevision: oldRevision, SourceHash: oldRevision + ":old-tree", ReleaseRef: "accepted-release",
		AcceptedDeployment: app.Spec.DeepCopy(),
		Promotion: &api.ApplicationPromotionStatus{
			Phase: "AwaitingApproval", Revision: promotionTestRevision,
			SourceApplication:    api.ApplicationReference{Name: upstream.Name, Namespace: upstream.Namespace},
			SourceApplicationUID: string(upstream.UID), SourceRelease: upstreamRelease.Name, SourceReleaseUID: string(upstreamRelease.UID),
			VerificationStartedAt: &startedAt,
		},
	}
	configurationHash, err := promotionVerificationConfigHash(app)
	require.NoError(t, err)
	app.Status.Promotion.VerificationConfigHash = configurationHash
	app.Annotations = map[string]string{promotionApprovalAnnotation: string(upstreamRelease.UID)}
	acceptedRelease := &api.Release{
		ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: app.Namespace, UID: "accepted-release-uid", Annotations: map[string]string{sourceRevisionAnnotation: oldRevision}},
		Status:     api.ReleaseStatus{Phase: api.ReleaseComplete},
	}
	check := api.HealthCheck{Name: "upstream-http", Expression: "true", Interval: "2s"}
	upstream.Spec.HealthChecks = []api.HealthCheck{check}
	checkedAt := metav1.NewTime(promotionTestNow)
	upstream.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: &checkedAt}}
	r := newPromotionTestReconciler(t)
	pipeline, err := r.promotionTestPipeline(app)
	require.NoError(t, err)
	pipeline.Generation = 1
	pipeline.Status = api.PipelineStatus{Phase: api.PipelineSucceeded, ObservedGeneration: 1, StepStatuses: []api.StepStatus{{Name: "verify", Phase: api.StepSucceeded}}}
	app.Status.Promotion.VerificationPipelineRef = pipeline.Name
	r = newPromotionTestReconciler(t, app, upstream, upstreamRelease, acceptedRelease, pipeline)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: promotionTestRevision + ":new-tree", Revision: promotionTestRevision}}
	return r, app, upstream, upstreamRelease, acceptedRelease
}

func TestTriggerPolicySecondManualApprovalSurvivesCachedUpstreamReadiness(t *testing.T) {
	ctx := context.Background()
	r, app, upstream, upstreamRelease, acceptedRelease := secondManualPromotionFixture(t)
	key := client.ObjectKeyFromObject(app)
	now := promotionTestNow
	r.now = func() time.Time { return now }
	result, err := r.reconcilePromotionTrigger(ctx, app)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "Ready", app.Status.Promotion.Phase)
	require.Empty(t, app.Annotations[promotionApprovalAnnotation], "the exact second candidate token is consumed once")

	stale := upstream.DeepCopy()
	staleCheck := metav1.NewTime(promotionTestNow.Add(-time.Minute))
	stale.Status.HealthChecks[0].CheckedAt = &staleCheck
	cache := &cachedPromotionSourceClient{Client: r.client, source: stale}
	r.client = cache
	app = getPromotionTestApp(t, r, key)
	_, err = r.reconcileApp(ctx, app)
	require.NoError(t, err)
	require.Equal(t, "Ready", app.Status.Promotion.Phase)
	require.Equal(t, acceptedRelease.Name, app.Status.ReleaseRef, "stale upstream health must hold the currently accepted release")
	require.Equal(t, api.ReleaseComplete, r.getCurrentReleasePhase(ctx, app))
	require.Nil(t, app.Status.Promotion.VerificationStartedAt, "observed stale health must invalidate the completed observation window")

	cache.source = upstream
	app = getPromotionTestApp(t, r, key)
	_, err = r.reconcileApp(ctx, app)
	require.NoError(t, err)
	require.Equal(t, acceptedRelease.Name, app.Status.ReleaseRef, "fresh health starts a new window while retaining the accepted release")
	require.Equal(t, api.ReleaseComplete, r.getCurrentReleasePhase(ctx, app))
	require.NotNil(t, app.Status.Promotion.VerificationStartedAt)
	require.WithinDuration(t, now, app.Status.Promotion.VerificationStartedAt.Time, 0)
	require.Empty(t, app.Annotations[promotionApprovalAnnotation], "the consumed approval survives the new health window")
	now = now.Add(time.Second)
	upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(now)
	app = getPromotionTestApp(t, r, key)
	_, err = r.reconcileApp(ctx, app)
	require.NoError(t, err)
	require.Empty(t, app.Status.ReleaseRef, "the old release is superseded before shared deployment intent changes")
	var superseded api.Release
	require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(acceptedRelease), &superseded))
	require.Equal(t, api.ReleaseSuperseded, superseded.Status.Phase)

	cache.source = stale
	for range 3 {
		app = getPromotionTestApp(t, r, key)
		_, err = r.reconcileApp(ctx, app)
		require.NoError(t, err)
		require.Equal(t, "Ready", app.Status.Promotion.Phase, "unchanged candidate and target retain the consumed authorization across cached reads")
		require.Nil(t, app.Status.Promotion.VerificationStartedAt, "readiness interruption after superseding must also restart the observation window")
		require.Equal(t, strings.Repeat("a", 40), app.Status.SourceRevision)
		require.Empty(t, app.Status.ReleaseRef, "stale upstream health must also hold admission after superseding")
		require.Empty(t, app.Annotations[promotionApprovalAnnotation])
	}
	cache.source = upstream
	app = getPromotionTestApp(t, r, key)
	_, err = r.reconcileApp(ctx, app)
	require.NoError(t, err)
	require.Equal(t, "Ready", app.Status.Promotion.Phase)
	require.Empty(t, app.Status.ReleaseRef, "admission waits for the entire new observation window")
	require.NotNil(t, app.Status.Promotion.VerificationStartedAt)
	require.WithinDuration(t, now, app.Status.Promotion.VerificationStartedAt.Time, 0)
	now = now.Add(time.Second)
	upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(now)
	app = getPromotionTestApp(t, r, key)
	_, err = r.reconcileApp(ctx, app)
	require.NoError(t, err)
	app = getPromotionTestApp(t, r, key)
	require.Equal(t, "Promoting", app.Status.Promotion.Phase)
	require.Equal(t, promotionTestRevision, app.Status.SourceRevision)
	require.NotEmpty(t, app.Status.ReleaseRef)
	newReleaseName := app.Status.ReleaseRef
	var promoted api.Release
	require.NoError(t, r.client.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: newReleaseName}, &promoted))
	require.Equal(t, promotionTestRevision, promoted.Annotations[sourceRevisionAnnotation])
	require.Equal(t, string(upstreamRelease.UID), promoted.Annotations[promotionReleaseUIDAnnotation])
	for range 3 {
		app = getPromotionTestApp(t, r, key)
		_, err = r.reconcileApp(ctx, app)
		require.NoError(t, err)
		require.Equal(t, newReleaseName, app.Status.ReleaseRef, "repeated reconciles must not replay or replace the authorized deployment")
	}
	var releases api.ReleaseList
	require.NoError(t, r.client.List(ctx, &releases, client.InNamespace(app.Namespace)))
	require.Len(t, releases.Items, 2, "exactly the old and new audited target releases exist")
}

func TestTriggerPolicyBlockedReadyCandidateCannotDirectlyActivate(t *testing.T) {
	r, app, _, _, acceptedRelease := secondManualPromotionFixture(t)
	app.Status.Promotion.Phase = "Ready"
	app.Status.Conditions = []metav1.Condition{{Type: promotionReadyCondition, Status: metav1.ConditionFalse, Reason: "UpstreamNotReady"}}
	result, err := r.beginVerifiedPromotion(context.Background(), app)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, acceptedRelease.Name, app.Status.ReleaseRef)
	require.Equal(t, strings.Repeat("a", 40), app.Status.SourceRevision)
	require.Equal(t, api.ReleaseComplete, r.getCurrentReleasePhase(context.Background(), app))
}

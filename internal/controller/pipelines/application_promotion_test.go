package pipelines

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	kptr "k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

const promotionTestRevision = "0123456789abcdef0123456789abcdef01234567"

var promotionTestNow = time.Date(2026, time.October, 6, 1, 0, 0, 0, time.UTC)

func promotionFixture() (*api.Application, *api.Application, *api.Release) {
	upstream := &api.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api-dev", Namespace: "dev", UID: "dev-uid", Generation: 1},
		Spec:       api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/api.git", Path: "env/dev"}},
		Status: api.ApplicationStatus{
			ObservedGeneration: 1, Phase: api.ApplicationHealthy, Synced: true,
			ReleaseRef: "dev-release", Revision: promotionTestRevision,
			DeploymentObservation: &api.ApplicationDeploymentObservation{Release: "dev-release", ReleaseUID: "release-uid", Revision: promotionTestRevision, ObservedGeneration: 1, ObservedAt: metav1.NewTime(promotionTestNow)},
			Conditions:            []metav1.Condition{{Type: string(api.ApplicationHealthy), Status: metav1.ConditionTrue, LastTransitionTime: metav1.NewTime(promotionTestNow.Add(-time.Second))}},
			Resources:             []api.ResourceSync{{Kind: "Deployment", Name: "api", Namespace: "dev", Status: "Synced"}},
			ResourceHealth:        []api.ResourceHealth{{Kind: "Deployment", Name: "api", Namespace: "dev", Health: "Healthy"}},
		},
	}
	release := &api.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "dev-release", Namespace: "dev", UID: "release-uid", Generation: 1,
			Annotations:     map[string]string{sourceRevisionAnnotation: promotionTestRevision},
			OwnerReferences: []metav1.OwnerReference{{APIVersion: api.GroupVersion.String(), Kind: "Application", Name: upstream.Name, UID: upstream.UID, Controller: kptr.To(true)}},
		},
		Status: api.ReleaseStatus{ObservedGeneration: 1, Phase: api.ReleaseComplete},
	}
	target := &api.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api-stg", Namespace: "stg", UID: "stg-uid", Generation: 1},
		Spec: api.ApplicationSpec{
			Source:  api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/api", Revision: "main", Path: "env/stg"},
			Trigger: &api.ApplicationTrigger{Type: api.ApplicationTriggerPromotion, From: &api.ApplicationReference{Name: upstream.Name, Namespace: upstream.Namespace}},
		},
	}
	return target, upstream, release
}

func newPromotionTestReconciler(t *testing.T, objects ...client.Object) *ApplicationReconciler {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&api.Application{}, &api.Pipeline{}, &api.Release{}).WithObjects(objects...).Build()
	return &ApplicationReconciler{client: c, Scheme: scheme, now: func() time.Time { return promotionTestNow }}
}

func getPromotionTestApp(t *testing.T, r *ApplicationReconciler, key client.ObjectKey) *api.Application {
	t.Helper()
	var app api.Application
	require.NoError(t, r.client.Get(context.Background(), key, &app))
	return &app
}

func TestPromotionSourceReady(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*api.Application, *api.Release)
	}{
		{"application generation stale", func(a *api.Application, _ *api.Release) { a.Generation++ }},
		{"application not healthy", func(a *api.Application, _ *api.Release) { a.Status.Phase = api.ApplicationPromoting }},
		{"not synced", func(a *api.Application, _ *api.Release) { a.Status.Synced = false }},
		{"drift", func(a *api.Application, _ *api.Release) { a.Status.OutOfSync = 1 }},
		{"diff unavailable", func(a *api.Application, _ *api.Release) { markApplicationDiffUnavailable(a) }},
		{"release in progress", func(_ *api.Application, r *api.Release) { r.Status.Phase = api.ReleaseVerifying }},
		{"release generation stale", func(_ *api.Application, r *api.Release) { r.Generation++ }},
		{"wrong owner", func(_ *api.Application, r *api.Release) { r.OwnerReferences[0].UID = "other-uid" }},
		{"release identity missing", func(_ *api.Application, r *api.Release) { r.UID = "" }},
		{"unpinned revision", func(a *api.Application, r *api.Release) {
			a.Status.Revision = "main"
			r.Annotations[sourceRevisionAnnotation] = "main"
		}},
		{"deployed revision mismatch", func(a *api.Application, _ *api.Release) { a.Status.Revision = strings.Repeat("a", 40) }},
		{"deployment observation missing", func(a *api.Application, _ *api.Release) { a.Status.DeploymentObservation = nil }},
		{"deployment observation old release", func(a *api.Application, _ *api.Release) {
			a.Status.DeploymentObservation.ReleaseUID = "old-release-uid"
		}},
		{"deployment observation old revision", func(a *api.Application, _ *api.Release) {
			a.Status.DeploymentObservation.Revision = strings.Repeat("a", 40)
		}},
		{"deployment observation old generation", func(a *api.Application, _ *api.Release) { a.Status.DeploymentObservation.ObservedGeneration = 0 }},
		{"deployment observation stale", func(a *api.Application, _ *api.Release) {
			a.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(-3 * time.Minute))
		}},
		{"deployment observation future", func(a *api.Application, _ *api.Release) {
			a.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(time.Second))
		}},
		{"no managed resources", func(a *api.Application, _ *api.Release) { a.Status.Resources = nil }},
		{"resource missing", func(a *api.Application, _ *api.Release) { a.Status.Resources[0].Status = "Missing" }},
		{"resource health unobserved", func(a *api.Application, _ *api.Release) { a.Status.ResourceHealth = nil }},
		{"resource health progressing", func(a *api.Application, _ *api.Release) { a.Status.ResourceHealth[0].Health = "Progressing" }},
		{"overall health unknown", func(a *api.Application, _ *api.Release) { a.Status.Health = api.HealthUnknown }},
		{"health check unobserved", func(a *api.Application, _ *api.Release) {
			a.Spec.HealthChecks = []api.HealthCheck{{Name: "health", Expression: "true"}}
		}},
		{"health check belongs to prior deployment", func(a *api.Application, _ *api.Release) {
			check := api.HealthCheck{Name: "health", Expression: "true", Interval: "30s"}
			a.Spec.HealthChecks = []api.HealthCheck{check}
			a.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: kptr.To(metav1.NewTime(promotionTestNow.Add(-2 * time.Second)))}}
		}},
		{"health check missing deployment epoch", func(a *api.Application, _ *api.Release) {
			check := api.HealthCheck{Name: "health", Expression: "true", Interval: "30s"}
			a.Spec.HealthChecks = []api.HealthCheck{check}
			a.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: kptr.To(metav1.NewTime(promotionTestNow))}}
			a.Status.Conditions = nil
		}},
		{"health check stale", func(a *api.Application, _ *api.Release) {
			check := api.HealthCheck{Name: "health", Expression: "true", Interval: "30s"}
			a.Spec.HealthChecks = []api.HealthCheck{check}
			a.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: kptr.To(metav1.NewTime(promotionTestNow.Add(-time.Minute)))}}
		}},
		{"analysis unobserved", func(a *api.Application, _ *api.Release) {
			a.Spec.AnalysisTemplates = []api.AnalysisTemplateRef{{Name: "errors"}}
		}},
		{"analysis belongs to prior deployment", func(a *api.Application, _ *api.Release) {
			a.Spec.AnalysisTemplates = []api.AnalysisTemplateRef{{Name: "errors"}}
			a.Status.AnalysisResults = []api.AnalysisResult{{Name: "errors", Phase: api.AnalysisRunSuccessful, Passed: true, CheckedAt: kptr.To(metav1.NewTime(promotionTestNow.Add(-2 * time.Second)))}}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, upstream, release := promotionFixture()
			require.NoError(t, promotionSourceReady(upstream, release, promotionTestNow))
			test.mutate(upstream, release)
			require.Error(t, promotionSourceReady(upstream, release, promotionTestNow))
		})
	}
	t.Run("current healthy check", func(t *testing.T) {
		_, upstream, release := promotionFixture()
		check := api.HealthCheck{Name: "health", Expression: "true", Interval: "30s"}
		upstream.Spec.HealthChecks = []api.HealthCheck{check}
		upstream.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: kptr.To(metav1.NewTime(promotionTestNow))}}
		require.NoError(t, promotionSourceReady(upstream, release, promotionTestNow))
	})
}

func TestPromotionSourceObservationRespectsPollInterval(t *testing.T) {
	t.Parallel()
	_, upstream, release := promotionFixture()
	upstream.Spec.Source.PollInterval = "5m"
	upstream.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(-10 * time.Minute))
	require.NoError(t, promotionSourceReady(upstream, release, promotionTestNow))
	upstream.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(-16 * time.Minute))
	require.Error(t, promotionSourceReady(upstream, release, promotionTestNow))
}

func TestReconcilePromotionCandidateProvenanceAndPin(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	r := newPromotionTestReconciler(t, target, upstream, release)
	result, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	require.Equal(t, api.ApplicationReference{Name: upstream.Name, Namespace: upstream.Namespace}, target.Status.Promotion.SourceApplication)
	require.Equal(t, string(upstream.UID), target.Status.Promotion.SourceApplicationUID)
	require.Equal(t, release.Name, target.Status.Promotion.SourceRelease)
	require.Equal(t, string(release.UID), target.Status.Promotion.SourceReleaseUID)
	require.Equal(t, promotionTestRevision, target.Status.Promotion.Revision)
	require.Empty(t, target.Status.SourceRevision, "verification must not activate a new deployment before sync admission")
	require.Nil(t, target.Status.AcceptedDeployment)
	require.NotEmpty(t, target.Status.Promotion.VerificationConfigHash)
	require.Equal(t, "main", target.Spec.Source.Revision)
	persisted := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	expectedStatus, err := json.Marshal(target.Status.Promotion)
	require.NoError(t, err)
	persistedStatus, err := json.Marshal(persisted.Status.Promotion)
	require.NoError(t, err)
	require.JSONEq(t, string(expectedStatus), string(persistedStatus))
	persisted.Status.SourceHash = "resolved-target-path-hash"
	require.NoError(t, r.client.Status().Update(context.Background(), persisted))
	result, err = r.reconcilePromotionTrigger(context.Background(), persisted)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "resolved-target-path-hash", persisted.Status.SourceHash, "Ready must not repeatedly invalidate target resolution")
}

func TestPromotionVerificationPipelineIsCandidateBoundAndResumable(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "curlimages/curl", Script: "curl -f https://dev.example.test/healthz"}}, MaxParallel: 1}
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	name := target.Status.Promotion.VerificationPipelineRef
	require.NotEmpty(t, name)
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(ctx, types.NamespacedName{Name: name, Namespace: target.Namespace}, &pipeline))
	require.True(t, metav1.IsControlledBy(&pipeline, target))
	require.Equal(t, string(release.UID), pipeline.Annotations[promotionReleaseUIDAnnotation])
	require.Contains(t, pipeline.Spec.Steps[0].Script, "export PAPRIKA_PROMOTION_REVISION='"+promotionTestRevision+"'")
	require.Contains(t, pipeline.Spec.Steps[0].Script, "export PAPRIKA_PROMOTION_SOURCE_NAMESPACE='dev'")
	// A new reconciler resumes the same Pipeline rather than creating another.
	r = &ApplicationReconciler{client: r.client, Scheme: r.Scheme, now: r.now}
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	var pipelines api.PipelineList
	require.NoError(t, r.client.List(ctx, &pipelines))
	require.Len(t, pipelines.Items, 1)
	require.Equal(t, name, target.Status.Promotion.VerificationPipelineRef)
	pipeline.Status.Phase = api.PipelineSucceeded
	pipeline.Status.ObservedGeneration = pipeline.Generation
	pipeline.Status.StepStatuses = []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}
	require.NoError(t, r.client.Status().Update(ctx, &pipeline))
	result, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
}

func TestPromotionTestFailureLatchesUntilNewRelease(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "test"}}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(ctx, types.NamespacedName{Name: target.Status.Promotion.VerificationPipelineRef, Namespace: target.Namespace}, &pipeline))
	pipeline.Status.Phase = api.PipelineFailed
	require.NoError(t, r.client.Status().Update(ctx, &pipeline))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	target.Spec.Trigger.Tests.Steps[0].Script = "fixed-test"
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	var pipelines api.PipelineList
	require.NoError(t, r.client.List(ctx, &pipelines))
	require.Len(t, pipelines.Items, 1)
	// A different completed release supplies a fresh verification attempt.
	newRelease := release.DeepCopy()
	newRelease.Name, newRelease.UID, newRelease.ResourceVersion = "dev-release-2", "release-uid-2", ""
	require.NoError(t, r.client.Create(ctx, newRelease))
	upstream.Status.ReleaseRef = newRelease.Name
	upstream.Status.DeploymentObservation.Release = newRelease.Name
	upstream.Status.DeploymentObservation.ReleaseUID = string(newRelease.UID)
	require.NoError(t, r.client.Status().Update(ctx, upstream))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.Equal(t, string(newRelease.UID), target.Status.Promotion.SourceReleaseUID)
	require.NoError(t, r.client.List(ctx, &pipelines))
	require.Len(t, pipelines.Items, 2)
}

func TestPromotionApprovalRequiresExactCandidateUID(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.SyncPolicy = api.SyncManual
	target.Annotations = map[string]string{manualSyncAnnotation: "1", promotionApprovalAnnotation: "old-release-uid"}
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	require.Empty(t, target.Status.SourceRevision)
	persisted := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	persisted.Annotations[promotionApprovalAnnotation] = string(release.UID)
	require.NoError(t, r.client.Update(ctx, persisted))
	result, err = r.reconcilePromotionTrigger(ctx, persisted)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "Ready", persisted.Status.Promotion.Phase)
	require.Empty(t, persisted.Status.SourceRevision, "approval records readiness; the delivery path activates the revision")
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Empty(t, fresh.Annotations[promotionApprovalAnnotation])
	require.Equal(t, "1", fresh.Annotations[manualSyncAnnotation], "ordinary manual sync is independent of candidate approval")
}

func TestPromotionWaitingPreservesExistingDeployment(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Status.ReleaseRef, target.Status.SourceRevision, target.Status.SourceHash = "stg-old-release", strings.Repeat("a", 40), "old-hash"
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "test"}}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	result, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.Nil(t, result, "existing deployment should continue native health reconciliation")
	require.Equal(t, strings.Repeat("a", 40), target.Status.SourceRevision)
	require.Equal(t, "old-hash", target.Status.SourceHash)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
}

func TestPromotionRejectsChangedUpstreamDuringVerification(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "test"}}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	upstream.Status.ReleaseRef = "new-in-flight-release"
	require.NoError(t, r.client.Status().Update(ctx, upstream))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	require.Equal(t, string(release.UID), target.Status.Promotion.SourceReleaseUID)
	require.Empty(t, target.Status.SourceRevision)
}

func TestPromotionGateFailureIsLatched(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer server.Close()
	target, upstream, release := promotionFixture()
	target.Spec.Trigger.Gates = []api.GateConfig{{Type: "smoke-test", Endpoint: server.URL, Timeout: 1}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	_, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	require.Contains(t, target.Status.Promotion.Message, "HTTP 503")
	require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition))
	target.Spec.Trigger.Gates = nil
	_, err = r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
}

func TestPromotionReadyRevalidatesHealthAndVerificationConfig(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	upstream.Status.ResourceHealth[0].Health = "Degraded"
	require.NoError(t, r.client.Status().Update(ctx, upstream))
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result, "an unhealthy upstream must block deployment admission")
	require.Equal(t, "Ready", target.Status.Promotion.Phase, "a temporary health hold retains verified authorization")
	require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition))
	upstream.Status.ResourceHealth[0].Health = "Healthy"
	require.NoError(t, r.client.Status().Update(ctx, upstream))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	require.True(t, meta.IsStatusConditionTrue(target.Status.Conditions, promotionReadyCondition), "health recovery restores admission readiness")
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "new-tests", Image: "test", Script: "test"}}}
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase, "test edits require fresh verification")
}

func TestPromotionApprovedCandidateSurvivesTemporaryUpstreamHealthHold(t *testing.T) {
	t.Parallel()
	for _, releaseRef := range []string{"stg-old-release", ""} {
		t.Run("accepted release "+releaseRef, func(t *testing.T) {
			t.Parallel()
			ctx := t.Context()
			target, upstream, release := promotionFixture()
			target.Spec.SyncPolicy = api.SyncManual
			target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "test"}}}
			target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 1}}
			target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
			target.Status.ReleaseRef = releaseRef
			target.Status.SourceRevision, target.Status.SourceHash = strings.Repeat("a", 40), "accepted-hash"
			target.Status.AcceptedDeployment = target.Spec.DeepCopy()
			r := newPromotionTestReconciler(t, target, upstream, release)
			_, err := r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			var pipeline api.Pipeline
			require.NoError(t, r.client.Get(ctx, types.NamespacedName{Namespace: target.Namespace, Name: target.Status.Promotion.VerificationPipelineRef}, &pipeline))
			pipeline.Status.Phase = api.PipelineSucceeded
			pipeline.Status.ObservedGeneration = pipeline.Generation
			pipeline.Status.StepStatuses = []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}
			require.NoError(t, r.client.Status().Update(ctx, &pipeline))
			_, err = r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			r.now = func() time.Time { return promotionTestNow.Add(time.Second) }
			result, err := r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			require.Nil(t, result)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			verified := target.Status.Promotion.DeepCopy()
			accepted := target.Status.AcceptedDeployment.DeepCopy()
			upstream.Status.ResourceHealth[0].Health = "Degraded"
			require.NoError(t, r.client.Status().Update(ctx, upstream))
			for range 3 {
				target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
				require.Empty(t, target.Annotations[promotionApprovalAnnotation], "the single candidate approval was consumed")
				result, err = r.reconcilePromotionTrigger(ctx, target)
				require.NoError(t, err)
				require.NotNil(t, result, "temporary upstream failure must hold admission even with an accepted release")
				require.Equal(t, "Ready", target.Status.Promotion.Phase)
				require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition))
				require.Equal(t, verified.VerificationConfigHash, target.Status.Promotion.VerificationConfigHash)
				require.Equal(t, verified.VerificationStartedAt.Time.UTC(), target.Status.Promotion.VerificationStartedAt.Time.UTC())
				require.Equal(t, verified.VerificationPipelineRef, target.Status.Promotion.VerificationPipelineRef)
				require.Equal(t, releaseRef, target.Status.ReleaseRef)
				require.Equal(t, strings.Repeat("a", 40), target.Status.SourceRevision)
				require.Equal(t, "accepted-hash", target.Status.SourceHash)
				require.Equal(t, accepted, target.Status.AcceptedDeployment)
			}
			upstream.Status.ResourceHealth[0].Health = "Healthy"
			require.NoError(t, r.client.Status().Update(ctx, upstream))
			target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			result, err = r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			require.Nil(t, result, "the unchanged verified candidate resumes without another approval")
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.True(t, meta.IsStatusConditionTrue(target.Status.Conditions, promotionReadyCondition))
			require.Equal(t, verified.VerificationStartedAt.Time.UTC(), target.Status.Promotion.VerificationStartedAt.Time.UTC())
			var pipelines api.PipelineList
			require.NoError(t, r.client.List(ctx, &pipelines))
			require.Len(t, pipelines.Items, 1, "health recovery reuses successful verification")
			persisted := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			require.True(t, meta.IsStatusConditionTrue(persisted.Status.Conditions, promotionReadyCondition), "readiness recovery must persist before delivery admission")
		})
	}
}

func TestPromotionHealthHoldDoesNotAuthorizeEditedTarget(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	target, upstream, release := promotionFixture()
	target.Spec.SyncPolicy = api.SyncManual
	target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
	r := newPromotionTestReconciler(t, target, upstream, release)
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	upstream.Status.ResourceHealth[0].Health = "Degraded"
	require.NoError(t, r.client.Status().Update(ctx, upstream))
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Spec.Parameters = map[string]string{"image.tag": "changed"}
	target.Generation++
	require.NoError(t, r.client.Update(ctx, target))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase, "an edited target cannot retain the prior authorization during a health hold")
	upstream.Status.ResourceHealth[0].Health = "Healthy"
	require.NoError(t, r.client.Status().Update(ctx, upstream))
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition))
}

func TestPromotionBlocksRepositoryMismatch(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Source.RepoURL = "https://example.test/other.git"
	r := newPromotionTestReconciler(t, target, upstream, release)
	result, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Nil(t, target.Status.Promotion)
	require.Empty(t, target.Status.SourceRevision)
}

func TestPromotionPipelineNameIncludesTestConfiguration(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "test", Image: "test", Script: "first"}}}
	target.Status.Promotion = &api.ApplicationPromotionStatus{SourceApplicationUID: string(upstream.UID), SourceReleaseUID: string(release.UID)}
	first, err := promotionPipelineName(target)
	require.NoError(t, err)
	target.Spec.Trigger.Tests.Steps[0].Script = "second"
	second, err := promotionPipelineName(target)
	require.NoError(t, err)
	require.NotEqual(t, first, second)
}

func TestPromotionDurationGateResumesWithoutBlocking(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 60}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	started := time.Now()
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Less(t, time.Since(started), time.Second, "duration gate must requeue rather than sleep")
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.Equal(t, promotionTestNow, target.Status.Promotion.VerificationStartedAt.Time.UTC())
	configurationHash := target.Status.Promotion.VerificationConfigHash
	// The persisted start survives controller recreation and repeated polls.
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	r = &ApplicationReconciler{client: r.client, Scheme: r.Scheme, now: func() time.Time { return promotionTestNow.Add(30 * time.Second) }}
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, promotionTestNow, target.Status.Promotion.VerificationStartedAt.Time.UTC())
	require.Equal(t, configurationHash, target.Status.Promotion.VerificationConfigHash)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	r.now = func() time.Time { return promotionTestNow.Add(time.Minute) }
	result, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
}

func TestPromotionManualPolicyChangeInvalidatesReadyApproval(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	target.Spec.SyncPolicy = api.SyncManual
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
}

func TestPromotionDetectsRuntimeReferenceCycle(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	upstream.Spec.Trigger = &api.ApplicationTrigger{Type: api.ApplicationTriggerPromotion, From: &api.ApplicationReference{Name: target.Name, Namespace: target.Namespace}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	result, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Nil(t, target.Status.Promotion)
	condition := meta.FindStatusCondition(target.Status.Conditions, promotionReadyCondition)
	require.NotNil(t, condition)
	require.Equal(t, "InvalidPromotionChain", condition.Reason)
	require.Contains(t, condition.Message, "cycle")
}

func TestPromotionReadyDeploymentEditRequiresFreshApproval(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		edit func(*api.Application)
	}{
		{"parameters", func(app *api.Application) { app.Spec.Parameters["image.tag"] = "changed" }},
		{"target cluster", func(app *api.Application) { app.Spec.Stages[0].Cluster.Name = "other-cluster" }},
		{"source path", func(app *api.Application) { app.Spec.Source.Path = "env/other" }},
		{"source values", func(app *api.Application) { app.Spec.Source.ValuesFile = "replicaCount: 99" }},
		{"target namespace", func(app *api.Application) { app.Spec.Source.TargetNamespace = "other-namespace" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			target, upstream, release := promotionFixture()
			target.Spec.SyncPolicy = api.SyncManual
			target.Spec.Parameters = map[string]string{"image.tag": "accepted"}
			target.Spec.Stages = []api.ApplicationPromotionStage{{Name: "stg", Cluster: api.ClusterRef{Name: "stg-cluster"}}}
			target.Status.AcceptedDeployment = target.Spec.DeepCopy()
			target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
			r := newPromotionTestReconciler(t, target, upstream, release)
			ctx := context.Background()
			_, err := r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.NotNil(t, target.Status.AcceptedDeployment)
			accepted := target.Status.AcceptedDeployment.DeepCopy()
			target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			test.edit(target)
			target.Generation++
			require.NoError(t, r.client.Update(ctx, target))
			result, err := r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			require.NotNil(t, result)
			require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
			require.Equal(t, accepted, target.Status.AcceptedDeployment, "waiting target edits must not mutate accepted deployment intent")
			target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			if target.Annotations == nil {
				target.Annotations = map[string]string{}
			}
			target.Annotations[promotionApprovalAnnotation] = string(release.UID)
			require.NoError(t, r.client.Update(ctx, target))
			_, err = r.reconcilePromotionTrigger(ctx, target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.Equal(t, accepted, target.Status.AcceptedDeployment, "fresh approval still waits for delivery admission before activation")
		})
	}
}

func TestPromotionApprovalRejectsStaleTargetSpecification(t *testing.T) {
	t.Parallel()
	for _, editGeneration := range []bool{true, false} {
		t.Run(map[bool]string{true: "generation changed", false: "specification hash changed"}[editGeneration], func(t *testing.T) {
			t.Parallel()
			target, upstream, release := promotionFixture()
			target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
			r := newPromotionTestReconciler(t, target, upstream, release)
			ctx := context.Background()
			latest := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			if editGeneration {
				latest.Generation++
			} else {
				latest.Spec.Parameters = map[string]string{"replicaCount": "99"}
			}
			require.NoError(t, r.client.Update(ctx, latest))
			require.Error(t, r.consumePromotionApproval(ctx, target, string(release.UID)))
			fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			require.Equal(t, string(release.UID), fresh.Annotations[promotionApprovalAnnotation], "stale approval must remain unconsumed")
		})
	}
}

func TestPromotionAutoAcceptanceRejectsTargetEditDuringGate(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	var r *ApplicationReconciler
	gateEditErrors := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		latest := &api.Application{}
		gateEditErr := r.client.Get(request.Context(), client.ObjectKeyFromObject(target), latest)
		if gateEditErr == nil {
			latest.Generation++
			latest.Spec.Parameters = map[string]string{"replicaCount": "99"}
			gateEditErr = r.client.Update(request.Context(), latest)
		}
		gateEditErrors <- gateEditErr
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target.Spec.Trigger.Gates = []api.GateConfig{{Type: "smoke-test", Endpoint: server.URL, Timeout: 1}}
	r = newPromotionTestReconciler(t, target, upstream, release)
	_, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, <-gateEditErrors)
	require.ErrorContains(t, err, "specification changed")
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Equal(t, "Verifying", fresh.Status.Promotion.Phase)
	require.Nil(t, fresh.Status.AcceptedDeployment)
	require.Empty(t, fresh.Status.SourceRevision)
}

func TestCompletedPromotionKeepsAcceptedDeploymentForSameUpstream(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.Parameters = map[string]string{"image.tag": "accepted"}
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	// Simulate the delivery path activating the admitted candidate.
	target.Status.AcceptedDeployment = target.Spec.DeepCopy()
	target.Status.SourceRevision = target.Status.Promotion.Revision
	target.Status.Promotion.Phase = "Complete"
	require.NoError(t, r.client.Status().Update(ctx, target))
	target.Spec.Parameters["image.tag"] = "waiting-next-candidate"
	require.NoError(t, r.client.Update(ctx, target))
	_, err = r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "Complete", target.Status.Promotion.Phase)
	require.Equal(t, "accepted", target.Status.AcceptedDeployment.Parameters["image.tag"])
}

func TestPromotionUsesUpstreamAcceptedRepository(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	upstream.Spec.Trigger = &api.ApplicationTrigger{Type: api.ApplicationTriggerPromotion, From: &api.ApplicationReference{Name: "origin"}}
	upstream.Status.AcceptedDeployment = upstream.Spec.DeepCopy()
	upstream.Spec.Source.RepoURL = "https://example.test/next-desired-repository.git"
	origin := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "origin", Namespace: upstream.Namespace}}
	r := newPromotionTestReconciler(t, target, upstream, release, origin)
	result, err := r.reconcilePromotionTrigger(context.Background(), target)
	require.NoError(t, err)
	require.Nil(t, result)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	require.Equal(t, promotionTestRevision, target.Status.Promotion.Revision)
	require.Equal(t, "https://example.test/next-desired-repository.git", upstream.Spec.Source.RepoURL)
}

func TestPromotionSpecEditExpiresPendingApproval(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFixture()
	target.Spec.SyncPolicy = api.SyncManual
	r := newPromotionTestReconciler(t, target, upstream, release)
	ctx := context.Background()
	_, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	previousHash := target.Status.Promotion.VerificationConfigHash
	// Authorize the pending intent, then edit it before the controller sees
	// the annotation. The old UID token must not authorize the new parameters.
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
	require.NoError(t, r.client.Update(ctx, target))
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Spec.Parameters = map[string]string{"replicaCount": "99"}
	target.Generation++
	require.NoError(t, r.client.Update(ctx, target))
	result, err := r.reconcilePromotionTrigger(ctx, target)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	require.NotEqual(t, previousHash, target.Status.Promotion.VerificationConfigHash)
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Empty(t, fresh.Annotations[promotionApprovalAnnotation])
	require.Empty(t, fresh.Status.SourceRevision)
	fresh.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
	require.NoError(t, r.client.Update(ctx, fresh))
	_, err = r.reconcilePromotionTrigger(ctx, fresh)
	require.NoError(t, err)
	require.Equal(t, "Ready", fresh.Status.Promotion.Phase)
}

func TestPromotionReadyRetryDoesNotRestoreSupersededReleaseRef(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	target, _, _ := promotionFixture()
	target.Status.Promotion = &api.ApplicationPromotionStatus{Phase: "Ready"}
	r := newPromotionTestReconciler(t)
	statusWrites := 0
	r.client = fake.NewClientBuilder().WithScheme(r.Scheme).WithStatusSubresource(&api.Application{}).WithObjects(target).WithInterceptorFuncs(interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if err := c.Get(ctx, key, obj, opts...); err != nil {
				return err
			}
			if statusWrites == 0 {
				app, ok := obj.(*api.Application)
				require.True(t, ok)
				app.Status.ReleaseRef = "superseded-release"
			}
			return nil
		},
		SubResourceUpdate: func(ctx context.Context, c client.Client, subresource string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
			statusWrites++
			if statusWrites == 1 {
				return apierrors.NewConflict(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "applications"}, target.Name, errors.New("stale cached release reference"))
			}
			return c.SubResource(subresource).Update(ctx, obj, opts...)
		},
	}).Build()
	require.NoError(t, r.persistReadyPromotion(ctx, target))
	require.Equal(t, 2, statusWrites)
	require.Empty(t, target.Status.ReleaseRef, "a retry must preserve the current API release reference instead of an earlier cached value")
	persisted := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Empty(t, persisted.Status.ReleaseRef)
}

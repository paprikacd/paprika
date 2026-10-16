package pipelines

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

func TestPromotionFinalRevalidationWaitsAndRestartsWindow(t *testing.T) {
	t.Parallel()
	for _, interruption := range []string{"stale health", "application read", "release read", "missing release"} {
		t.Run(interruption, func(t *testing.T) {
			t.Parallel()
			target, upstream, release := promotionFixture()
			target.Spec.SyncPolicy = api.SyncManual
			target.Spec.Stages = []api.ApplicationPromotionStage{{Name: "stg"}}
			target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "true"}}}
			check := api.HealthCheck{Name: "current-health", Expression: "true", Interval: "2s"}
			upstream.Spec.HealthChecks = []api.HealthCheck{check}
			upstream.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: ptrToPromotionTime(promotionTestNow)}}
			var interrupt, armed atomic.Bool
			armed.Store(true)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				interrupt.Store(armed.Load()) // Only the final read, after the real gate, loses evidence.
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 10}, {Type: "smoke-test", Endpoint: server.URL, Timeout: 1}}
			r := newPromotionTestReconciler(t, target, upstream, release)
			now := promotionTestNow
			r.now = func() time.Time { return now }
			base, ok := r.client.(client.WithWatch)
			require.True(t, ok)
			r.client = interceptor.NewClient(base, interceptor.Funcs{Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				if interrupt.Load() && key == client.ObjectKeyFromObject(release) {
					switch interruption {
					case "release read":
						return errors.New("temporary Release read unavailable")
					case "missing release":
						return apierrors.NewNotFound(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "releases"}, release.Name)
					}
				}
				if interrupt.Load() && key == client.ObjectKeyFromObject(upstream) && interruption == "application read" {
					return errors.New("temporary Application read unavailable")
				}
				if err := c.Get(ctx, key, obj, opts...); err != nil {
					return err
				}
				if app, ok := obj.(*api.Application); ok && interrupt.Load() && key == client.ObjectKeyFromObject(upstream) && interruption == "stale health" {
					app.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(promotionTestNow)
				}
				return nil
			}})
			_, err := r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			pipelineName := target.Status.Promotion.VerificationPipelineRef
			var pipeline api.Pipeline
			require.NoError(t, base.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: pipelineName}, &pipeline))
			pipeline.Status.Phase, pipeline.Status.ObservedGeneration = api.PipelineSucceeded, pipeline.Generation
			pipeline.Status.StepStatuses = []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}
			require.NoError(t, base.Status().Update(t.Context(), &pipeline))
			target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
			require.NoError(t, base.Update(t.Context(), target))
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			refresh := func(offset time.Duration) {
				now = promotionTestNow.Add(offset)
				upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(now)
				require.NoError(t, base.Status().Update(t.Context(), upstream))
			}
			refresh(10 * time.Second)
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.True(t, interrupt.Load(), "the initial admission read must succeed before the gate triggers the final-read interruption")
			require.Equal(t, "Verifying", target.Status.Promotion.Phase)
			require.Nil(t, target.Status.Promotion.VerificationStartedAt)
			require.Nil(t, target.Status.AcceptedDeployment)
			require.Equal(t, string(release.UID), target.Annotations[promotionApprovalAnnotation], "a failed final check cannot consume approval")
			require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition))
			interrupt.Store(false)
			armed.Store(false)
			for _, offset := range []time.Duration{20 * time.Second, 29 * time.Second} {
				refresh(offset)
				_, err = r.reconcilePromotionTrigger(t.Context(), target)
				require.NoError(t, err)
				require.Equal(t, "Verifying", target.Status.Promotion.Phase)
				require.Nil(t, target.Status.AcceptedDeployment)
			}
			refresh(30 * time.Second)
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.Empty(t, target.Annotations[promotionApprovalAnnotation])
			require.Equal(t, pipelineName, target.Status.Promotion.VerificationPipelineRef)
			var pipelines api.PipelineList
			require.NoError(t, base.List(t.Context(), &pipelines))
			require.Len(t, pipelines.Items, 1, "temporary readiness loss must not rerun successful verification Jobs")
			result, err := r.beginVerifiedPromotion(t.Context(), target)
			require.NoError(t, err)
			require.Nil(t, result)
			require.NotNil(t, target.Status.AcceptedDeployment)
			require.Equal(t, promotionTestRevision, target.Status.SourceRevision)
		})
	}
}

func TestPromotionFinalRevalidationRejectsConfirmedIdentityChanges(t *testing.T) {
	t.Parallel()
	for _, change := range []string{"application UID", "release UID", "revision", "release reference"} {
		t.Run(change, func(t *testing.T) {
			t.Parallel()
			target, upstream, release := promotionFixture()
			r := newPromotionTestReconciler(t, target, upstream, release)
			require.NoError(t, r.preparePromotionCandidate(t.Context(), target))
			switch change {
			case "application UID":
				upstream.UID = "replacement-source"
				require.NoError(t, r.client.Update(t.Context(), upstream))
			case "release UID":
				release.UID = "replacement-release"
				require.NoError(t, r.client.Update(t.Context(), release))
			case "revision":
				release.Annotations[sourceRevisionAnnotation] = strings.Repeat("b", 40)
				require.NoError(t, r.client.Update(t.Context(), release))
			case "release reference":
				upstream.Status.ReleaseRef = "new-release"
				require.NoError(t, r.client.Status().Update(t.Context(), upstream))
			}
			hash, err := promotionVerificationConfigHash(target)
			require.NoError(t, err)
			_, err = r.completePromotionVerification(t.Context(), target, hash)
			require.NoError(t, err)
			require.Equal(t, "Failed", target.Status.Promotion.Phase)
			require.Equal(t, "UpstreamCandidateChanged", meta.FindStatusCondition(target.Status.Conditions, promotionReadyCondition).Reason)
			require.Nil(t, target.Status.AcceptedDeployment)
		})
	}
}

func TestPromotionApprovedCandidateRetainsAuthorizationAcrossUnavailableSource(t *testing.T) {
	t.Parallel()
	for _, unavailable := range []string{"application read", "release read", "missing release"} {
		t.Run(unavailable, func(t *testing.T) {
			t.Parallel()
			target, upstream, release := promotionFixture()
			target.Spec.SyncPolicy = api.SyncManual
			target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 1}}
			target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
			r := newPromotionTestReconciler(t, target, upstream, release)
			now := promotionTestNow
			r.now = func() time.Time { return now }
			_, err := r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			now = now.Add(time.Second)
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.Empty(t, target.Annotations[promotionApprovalAnnotation])
			base, ok := r.client.(client.WithWatch)
			require.True(t, ok)
			r.client = interceptor.NewClient(base, interceptor.Funcs{Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				if key == client.ObjectKeyFromObject(upstream) && unavailable == "application read" {
					return errors.New("temporary Application read unavailable")
				}
				if key == client.ObjectKeyFromObject(release) {
					if unavailable == "missing release" {
						return apierrors.NewNotFound(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "releases"}, release.Name)
					}
					if unavailable == "release read" {
						return errors.New("temporary Release read unavailable")
					}
				}
				return c.Get(ctx, key, obj, opts...)
			}})
			result, err := r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.NotNil(t, result)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.Nil(t, target.Status.Promotion.VerificationStartedAt)
			require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition))
			r.client = base
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.True(t, meta.IsStatusConditionFalse(target.Status.Conditions, promotionReadyCondition), "authorization persists, but the fresh full window still blocks admission")
			now = now.Add(time.Second)
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.True(t, meta.IsStatusConditionTrue(target.Status.Conditions, promotionReadyCondition))
			require.Empty(t, target.Annotations[promotionApprovalAnnotation], "a temporary read failure does not require another approval")
		})
	}
}

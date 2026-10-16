package pipelines

import (
	"context"
	"testing"
	"time"

	"github.com/onsi/ginkgo/v2"
	"github.com/onsi/gomega"
	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

func TestPromotionHealthObservationFreshness(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name, interval string
		age            time.Duration
		fresh          bool
	}{
		{"just after due", "5s", 5001 * time.Millisecond, true},
		{"just before stale", "5s", 9999 * time.Millisecond, true},
		{"two periods stale", "5s", 10 * time.Second, false},
		{"future observation", "5s", -time.Millisecond, false},
		{"default interval grace", "", 59999 * time.Millisecond, true},
		{"default interval stale", "", time.Minute, false},
		{"scheduler floor grace", "100ms", 1999 * time.Millisecond, true},
		{"scheduler floor stale", "100ms", 2 * time.Second, false},
		{"large interval avoids overflow", "2000000h", 2400000 * time.Hour, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			check := api.HealthCheck{Name: "health", Expression: "true", Interval: test.interval}
			result := &api.HealthCheckResult{ConfigurationHash: health.MeasurementHash(check), CheckedAt: ptrToPromotionTime(promotionTestNow.Add(-test.age))}
			require.Equal(t, test.fresh, promotionHealthResultFresh(check, result, promotionTestNow))
			if test.age >= applicationHealthCheckInterval(test.interval) {
				require.False(t, configuredHealthResultFresh(check, result, promotionTestNow), "promotion grace must not delay the next real probe")
			}
		})
	}
}

func TestPromotionSLOHealthObservationFreshness(t *testing.T) {
	t.Parallel()
	check := api.HealthCheck{Name: "uptime", Interval: "10s", Expression: "true", HTTPProbe: &api.HTTPProbe{URL: "https://example.test/healthz", Timeout: 1}, SLO: &api.AvailabilitySLO{Window: "1h", TargetPercentage: 99.9}}
	checkedAt := promotionTestNow.Add(9 * time.Second)
	result := &api.HealthCheckResult{ConfigurationHash: health.MeasurementHash(check), CheckedAt: ptrToPromotionTime(checkedAt)}
	// The previous bucket's actual sample remains usable while the next probe is
	// being published; the evaluator must still collect the new bucket's sample.
	now := promotionTestNow.Add(11 * time.Second)
	require.False(t, configuredHealthResultFresh(check, result, now))
	require.True(t, promotionHealthResultFresh(check, result, now))
	require.True(t, promotionHealthResultFresh(check, result, checkedAt.Add(19999*time.Millisecond)))
	require.False(t, promotionHealthResultFresh(check, result, checkedAt.Add(20*time.Second)))
	for _, invalid := range []string{"interval", "window", "target", "probe"} {
		t.Run(invalid, func(t *testing.T) {
			copyCheck := check
			copySLO := *check.SLO
			copyCheck.SLO = &copySLO
			switch invalid {
			case "interval":
				copyCheck.Interval = "5s"
			case "window":
				copyCheck.SLO.Window = "2h"
			case "target":
				copyCheck.SLO.TargetPercentage = 100
			case "probe":
				copyCheck.HTTPProbe = nil
			}
			copyResult := *result
			copyResult.ConfigurationHash = health.MeasurementHash(copyCheck)
			require.False(t, promotionHealthResultFresh(copyCheck, &copyResult, now), "invalid SLO contracts must fail closed even with a matching hash")
		})
	}
}

func TestPromotionHealthObservationGraceRetainsEvidenceGuards(t *testing.T) {
	t.Parallel()
	for _, invalid := range []string{"missing result", "missing timestamp", "changed configuration", "future observation", "before deployment", "degraded", "unknown"} {
		t.Run(invalid, func(t *testing.T) {
			t.Parallel()
			_, upstream, release := promotionFixture()
			check := api.HealthCheck{Name: "health", Expression: "true", Interval: "5s"}
			upstream.Spec.HealthChecks = []api.HealthCheck{check}
			upstream.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: ptrToPromotionTime(promotionTestNow)}}
			switch invalid {
			case "missing result":
				upstream.Status.HealthChecks = nil
			case "missing timestamp":
				upstream.Status.HealthChecks[0].CheckedAt = nil
			case "changed configuration":
				upstream.Spec.HealthChecks[0].Expression = "false"
			case "future observation":
				upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(promotionTestNow.Add(time.Millisecond))
			case "before deployment":
				upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(promotionTestNow.Add(-2 * time.Second))
			case "degraded":
				upstream.Status.HealthChecks[0].Status = api.HealthDegraded
			case "unknown":
				upstream.Status.HealthChecks[0].Status = api.HealthUnknown
			}
			require.Error(t, promotionSourceReady(upstream, release, promotionTestNow))
		})
	}
}

func promotionFreshnessFixture() (*api.Application, *api.Application, *api.Release) {
	target, upstream, release := promotionFixture()
	target.Spec.Stages = []api.ApplicationPromotionStage{{Name: "stg"}}
	upstream.Spec.Stages = []api.ApplicationPromotionStage{{Name: "dev"}}
	target.Spec.SyncPolicy = api.SyncManual
	target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 5}}
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "true"}}}
	check := api.HealthCheck{Name: "health", Expression: "true", Interval: "5s"}
	upstream.Spec.HealthChecks = []api.HealthCheck{check}
	upstream.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, ConfigurationHash: health.MeasurementHash(check), CheckedAt: ptrToPromotionTime(promotionTestNow)}}
	upstream.Status.Conditions[0].Reason = "DeploymentHealthy"
	upstream.Status.Conditions[0].Message = "The current deployed release is healthy."
	return target, upstream, release
}

func TestPromotionObservedUnhealthyResultRestartsWindow(t *testing.T) {
	t.Parallel()
	target, upstream, release := promotionFreshnessFixture()
	r := newPromotionTestReconciler(t, target, upstream, release)
	now := promotionTestNow
	r.now = func() time.Time { return now }
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	pipelineName := target.Status.Promotion.VerificationPipelineRef
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: pipelineName}, &pipeline))
	pipeline.Status = api.PipelineStatus{Phase: api.PipelineSucceeded, ObservedGeneration: pipeline.Generation, StepStatuses: []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}}
	require.NoError(t, r.client.Status().Update(t.Context(), &pipeline))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	now = promotionTestNow.Add(5001 * time.Millisecond)
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
	require.NoError(t, r.client.Update(t.Context(), target))
	now = promotionTestNow.Add(6 * time.Second)
	upstream.Status.HealthChecks[0].Status = api.HealthDegraded
	upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(now)
	require.NoError(t, r.client.Status().Update(t.Context(), upstream))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.Nil(t, target.Status.Promotion.VerificationStartedAt)
	require.Equal(t, string(release.UID), target.Annotations[promotionApprovalAnnotation])
	upstream.Status.HealthChecks[0].Status = api.HealthHealthy
	now = promotionTestNow.Add(7 * time.Second)
	upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(now)
	require.NoError(t, r.client.Status().Update(t.Context(), upstream))
	for _, offset := range []time.Duration{7 * time.Second, 11999 * time.Millisecond} {
		now = promotionTestNow.Add(offset)
		_, err = r.reconcilePromotionTrigger(t.Context(), target)
		require.NoError(t, err)
		require.Equal(t, "Verifying", target.Status.Promotion.Phase)
		require.Nil(t, target.Status.AcceptedDeployment)
	}
	now = promotionTestNow.Add(12001 * time.Millisecond)
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	require.True(t, target.Status.Promotion.VerificationStartedAt.Time.Equal(promotionTestNow.Add(7*time.Second)))
	require.Empty(t, target.Annotations[promotionApprovalAnnotation])
	require.Equal(t, pipelineName, target.Status.Promotion.VerificationPipelineRef)
}

var _ = ginkgo.Describe("Promotion health observation freshness", func() {
	ginkgo.It("keeps a manual candidate and successful Pipeline across the refresh boundary before exact UID approval", func() {
		testContext := context.Background()
		target, upstream, release := promotionFreshnessFixture()
		upstream.Name, upstream.Namespace, upstream.UID, upstream.Generation = "freshness-source", "default", "", 0
		upstreamStatus := upstream.Status.DeepCopy()
		upstream.Status = api.ApplicationStatus{}
		gomega.Expect(k8sClient.Create(testContext, upstream)).To(gomega.Succeed())
		ginkgo.DeferCleanup(func() { gomega.Expect(k8sClient.Delete(testContext, upstream)).To(gomega.Succeed()) })
		release.Name, release.Namespace, release.UID, release.Generation = "freshness-source-release", "default", "", 0
		release.Spec.Target = "dev"
		release.OwnerReferences[0].Name, release.OwnerReferences[0].UID = upstream.Name, upstream.UID
		release.Status = api.ReleaseStatus{}
		gomega.Expect(k8sClient.Create(testContext, release)).To(gomega.Succeed())
		ginkgo.DeferCleanup(func() { gomega.Expect(k8sClient.Delete(testContext, release)).To(gomega.Succeed()) })
		release.Status = api.ReleaseStatus{Phase: api.ReleaseComplete, ObservedGeneration: release.Generation}
		gomega.Expect(k8sClient.Status().Update(testContext, release)).To(gomega.Succeed())
		upstream.Status = *upstreamStatus
		upstream.Status.ReleaseRef, upstream.Status.ObservedGeneration = release.Name, upstream.Generation
		upstream.Status.Resources[0].Namespace, upstream.Status.ResourceHealth[0].Namespace = "default", "default"
		upstream.Status.DeploymentObservation.Release, upstream.Status.DeploymentObservation.ReleaseUID = release.Name, string(release.UID)
		upstream.Status.DeploymentObservation.ObservedGeneration = upstream.Generation
		gomega.Expect(k8sClient.Status().Update(testContext, upstream)).To(gomega.Succeed())
		target.Name, target.Namespace, target.UID, target.Generation = "freshness-target", "default", "", 0
		target.Spec.Trigger.From = &api.ApplicationReference{Name: upstream.Name, Namespace: upstream.Namespace}
		gomega.Expect(k8sClient.Create(testContext, target)).To(gomega.Succeed())
		ginkgo.DeferCleanup(func() { gomega.Expect(k8sClient.Delete(testContext, target)).To(gomega.Succeed()) })
		now := promotionTestNow
		r := &ApplicationReconciler{client: k8sClient, Scheme: k8sClient.Scheme(), now: func() time.Time { return now }}
		_, err := r.reconcilePromotionTrigger(testContext, target)
		gomega.Expect(err).NotTo(gomega.HaveOccurred())
		pipelineName := target.Status.Promotion.VerificationPipelineRef
		var pipeline api.Pipeline
		gomega.Expect(k8sClient.Get(testContext, client.ObjectKey{Namespace: target.Namespace, Name: pipelineName}, &pipeline)).To(gomega.Succeed())
		ginkgo.DeferCleanup(func() { gomega.Expect(k8sClient.Delete(testContext, &pipeline)).To(gomega.Succeed()) })
		pipeline.Status = api.PipelineStatus{Phase: api.PipelineSucceeded, ObservedGeneration: pipeline.Generation, StepStatuses: []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}}
		gomega.Expect(k8sClient.Status().Update(testContext, &pipeline)).To(gomega.Succeed())
		_, err = r.reconcilePromotionTrigger(testContext, target)
		gomega.Expect(err).NotTo(gomega.HaveOccurred())
		for _, offset := range []time.Duration{5001 * time.Millisecond, 9999 * time.Millisecond} {
			now = promotionTestNow.Add(offset)
			_, err = r.reconcilePromotionTrigger(testContext, target)
			gomega.Expect(err).NotTo(gomega.HaveOccurred())
			gomega.Expect(target.Status.Promotion.Phase).To(gomega.Equal("AwaitingApproval"))
			gomega.Expect(target.Status.Promotion.VerificationStartedAt.Time.Equal(promotionTestNow)).To(gomega.BeTrue())
			gomega.Expect(target.Status.Promotion.VerificationPipelineRef).To(gomega.Equal(pipelineName))
		}
		gomega.Expect(k8sClient.Get(testContext, client.ObjectKeyFromObject(target), target)).To(gomega.Succeed())
		target.Annotations = map[string]string{promotionApprovalAnnotation: "different-release-uid"}
		gomega.Expect(k8sClient.Update(testContext, target)).To(gomega.Succeed())
		_, err = r.reconcilePromotionTrigger(testContext, target)
		gomega.Expect(err).NotTo(gomega.HaveOccurred())
		gomega.Expect(target.Status.Promotion.Phase).To(gomega.Equal("AwaitingApproval"))
		gomega.Expect(target.Annotations[promotionApprovalAnnotation]).To(gomega.Equal("different-release-uid"))
		// Publish the next actual probe, then approve just as that sample is due.
		upstream.Status.HealthChecks[0].CheckedAt = ptrToPromotionTime(promotionTestNow.Add(10 * time.Second))
		gomega.Expect(k8sClient.Status().Update(testContext, upstream)).To(gomega.Succeed())
		now = promotionTestNow.Add(15001 * time.Millisecond)
		gomega.Expect(k8sClient.Get(testContext, client.ObjectKeyFromObject(target), target)).To(gomega.Succeed())
		target.Annotations[promotionApprovalAnnotation] = string(release.UID)
		gomega.Expect(k8sClient.Update(testContext, target)).To(gomega.Succeed())
		_, err = r.reconcilePromotionTrigger(testContext, target)
		gomega.Expect(err).NotTo(gomega.HaveOccurred())
		var persisted api.Application
		gomega.Expect(k8sClient.Get(testContext, client.ObjectKeyFromObject(target), &persisted)).To(gomega.Succeed())
		gomega.Expect(persisted.Status.Promotion.Phase).To(gomega.Equal("Ready"))
		gomega.Expect(persisted.Status.Promotion.SourceReleaseUID).To(gomega.Equal(string(release.UID)))
		gomega.Expect(persisted.Status.Promotion.VerificationStartedAt.Time.Equal(promotionTestNow)).To(gomega.BeTrue())
		gomega.Expect(persisted.Status.Promotion.VerificationPipelineRef).To(gomega.Equal(pipelineName))
		gomega.Expect(persisted.Annotations).NotTo(gomega.HaveKey(promotionApprovalAnnotation))
		var pipelines api.PipelineList
		gomega.Expect(k8sClient.List(context.Background(), &pipelines, client.InNamespace(target.Namespace), client.MatchingLabels{"app.paprika.io/name": target.Name})).To(gomega.Succeed())
		gomega.Expect(pipelines.Items).To(gomega.HaveLen(1))
		gomega.Expect(pipelines.Items[0].UID).To(gomega.Equal(pipeline.UID))
	})
})

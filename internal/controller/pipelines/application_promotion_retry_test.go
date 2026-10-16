package pipelines

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const promotionRetryTestToken = "a84a301c-40bb-4e59-a59a-405e4ce18751" // #nosec G101 -- public test attempt UUID, not a credential.

func failedPromotionRetryFixture(t *testing.T) (*ApplicationReconciler, *api.Application, string) {
	t.Helper()
	target, upstream, release := promotionFixture()
	target.Spec.SyncPolicy = api.SyncManual
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "false"}}}
	r := newPromotionTestReconciler(t, target, upstream, release)
	r.Namespace, r.K8sClient = "jobs", k8sfake.NewSimpleClientset()
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	name := target.Status.Promotion.VerificationPipelineRef
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: name}, &pipeline))
	pipeline.Status.Phase = api.PipelineFailed
	require.NoError(t, r.client.Status().Update(t.Context(), &pipeline))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	return r, getPromotionTestApp(t, r, client.ObjectKeyFromObject(target)), name
}

func TestPromotionExplicitRetryRunsFreshPipelineAndRequiresFreshApproval(t *testing.T) {
	t.Parallel()
	r, target, previous := failedPromotionRetryFixture(t)
	uid := target.Status.Promotion.SourceReleaseUID
	target.Spec.Trigger.Tests.Steps[0].Script = "true"
	target.Annotations = map[string]string{promotionApprovalAnnotation: uid, syncAnnotation: "generic", manualSyncAnnotation: "generic"}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase, "a spec edit or manual sync cannot retry verification")
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations[promotionRetryAnnotation] = uid + ":" + promotionRetryTestToken
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.Equal(t, promotionRetryTestToken, target.Status.Promotion.VerificationAttempt)
	require.Empty(t, target.Annotations[promotionApprovalAnnotation])
	require.Empty(t, target.Annotations[promotionRetryAnnotation])
	require.NotEqual(t, previous, target.Status.Promotion.VerificationPipelineRef)
	require.Nil(t, target.Status.Promotion.VerificationStartedAt)
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: target.Status.Promotion.VerificationPipelineRef}, &pipeline))
	require.Equal(t, promotionRetryTestToken, pipeline.Annotations[promotionRetryAnnotation])
	require.Equal(t, target.Status.Promotion.VerificationConfigHash, pipeline.Annotations["paprika.io/promotion-verification-config"])
	pipeline.Status.Phase, pipeline.Status.ObservedGeneration = api.PipelineSucceeded, pipeline.Generation
	pipeline.Status.StepStatuses = []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}
	require.NoError(t, r.client.Status().Update(t.Context(), &pipeline))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	require.Nil(t, target.Status.AcceptedDeployment)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionApprovalAnnotation: uid}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
}

func TestPromotionRetryRejectsWrongCandidateAndReplay(t *testing.T) {
	t.Parallel()
	r, target, _ := failedPromotionRetryFixture(t)
	target.Annotations = map[string]string{promotionRetryAnnotation: "different-release:" + promotionRetryTestToken}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	require.Empty(t, target.Status.Promotion.VerificationAttempt)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: target.Status.Promotion.VerificationPipelineRef}, &pipeline))
	pipeline.Status.Phase = api.PipelineFailed
	require.NoError(t, r.client.Status().Update(t.Context(), &pipeline))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Failed", target.Status.Promotion.Phase)
	var pipelines api.PipelineList
	require.NoError(t, r.client.List(t.Context(), &pipelines))
	require.Len(t, pipelines.Items, 2, "replaying a consumed token must not create another attempt")
}

func TestPromotionRetryRemembersOlderAttemptsWithoutTestPipeline(t *testing.T) {
	t.Parallel()
	r, target, _ := failedPromotionRetryFixture(t)
	target.Spec.Trigger.Tests = nil
	require.NoError(t, r.client.Update(t.Context(), target))
	for _, token := range []string{promotionRetryTestToken, "d71681b2-c130-4a62-b6cb-7605b6cfc220"} {
		target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + token}
		require.NoError(t, r.client.Update(t.Context(), target))
		require.NoError(t, r.reconcilePromotionRetry(t.Context(), target))
		target.Status.Promotion.Phase = "Failed"
		require.NoError(t, r.client.Status().Update(t.Context(), target))
	}
	last := target.Status.Promotion.VerificationAttempt
	target.Spec.Parameters = map[string]string{"tenant": "same-candidate-new-intent"}
	target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken}
	require.NoError(t, r.client.Update(t.Context(), target))
	require.NoError(t, r.reconcilePromotionRetry(t.Context(), target))
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Equal(t, "Failed", fresh.Status.Promotion.Phase)
	require.Equal(t, last, fresh.Status.Promotion.VerificationAttempt)
	require.Len(t, fresh.Status.Promotion.ConsumedVerificationAttempts, 2)
}

func TestPromotionRetryLimitDoesNotEvictReplayHistory(t *testing.T) {
	t.Parallel()
	r, target, _ := failedPromotionRetryFixture(t)
	for i := range promotionRetryLimit {
		target.Status.Promotion.ConsumedVerificationAttempts = append(target.Status.Promotion.ConsumedVerificationAttempts, fmt.Sprintf("00000000-0000-4000-8000-%012d", i))
	}
	require.NoError(t, r.client.Status().Update(t.Context(), target))
	target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken}
	require.NoError(t, r.client.Update(t.Context(), target))
	require.ErrorContains(t, r.reconcilePromotionRetry(t.Context(), target), "all 32")
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Equal(t, "Failed", fresh.Status.Promotion.Phase)
	require.Len(t, fresh.Status.Promotion.ConsumedVerificationAttempts, promotionRetryLimit)
	require.Empty(t, fresh.Status.Promotion.VerificationAttempt)
}

func TestPromotionRetryRequiresPriorVerificationJobsStopped(t *testing.T) {
	t.Parallel()
	for _, state := range []string{"active", "pending", "terminating", "complete", "failed", "client", "namespace", "list"} {
		t.Run(state, func(t *testing.T) {
			t.Parallel()
			r, target, previous := failedPromotionRetryFixture(t)
			job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "old-verification", Namespace: "jobs", Labels: map[string]string{"paprika.io/pipeline": previous}}}
			switch state {
			case "active":
				job.Status.Active = 1
			case "terminating":
				now := metav1.Now()
				job.DeletionTimestamp, job.Finalizers = &now, []string{"test.example/retain"}
				job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
			case "complete":
				job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			case "failed":
				job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
			}
			kube := k8sfake.NewSimpleClientset(job)
			r.K8sClient = kube
			switch state {
			case "client":
				r.K8sClient = nil
			case "namespace":
				r.Namespace = ""
			case "list":
				kube.PrependReactor("list", "jobs", func(k8stesting.Action) (bool, runtime.Object, error) {
					return true, nil, errors.New("Job API unavailable")
				})
			}
			target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken}
			require.NoError(t, r.client.Update(t.Context(), target))
			err := r.reconcilePromotionRetry(t.Context(), target)
			fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			if state == "complete" || state == "failed" {
				require.NoError(t, err)
				require.Equal(t, "Verifying", fresh.Status.Promotion.Phase)
				require.Equal(t, promotionRetryTestToken, fresh.Status.Promotion.VerificationAttempt)
			} else {
				require.Error(t, err)
				require.Equal(t, "Failed", fresh.Status.Promotion.Phase)
				require.Equal(t, previous, fresh.Status.Promotion.VerificationPipelineRef)
				require.Empty(t, fresh.Status.Promotion.VerificationAttempt)
			}
		})
	}
}

func TestPromotionRetryRejectsConcurrentIntentChange(t *testing.T) {
	t.Parallel()
	r, target, _ := failedPromotionRetryFixture(t)
	target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken}
	require.NoError(t, r.client.Update(t.Context(), target))
	latest := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	latest.Spec.Parameters = map[string]string{"tenant": "substituted"}
	require.NoError(t, r.client.Update(t.Context(), latest))
	require.ErrorContains(t, r.reconcilePromotionRetry(t.Context(), target), "settings changed")
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Equal(t, "Failed", fresh.Status.Promotion.Phase)
	require.Empty(t, fresh.Status.Promotion.VerificationAttempt)
}

func TestPromotionRetryStatusConflictRetriesWithoutRestoringApproval(t *testing.T) {
	t.Parallel()
	r, target, _ := failedPromotionRetryFixture(t)
	target.Annotations = map[string]string{promotionRetryAnnotation: target.Status.Promotion.SourceReleaseUID + ":" + promotionRetryTestToken, promotionApprovalAnnotation: target.Status.Promotion.SourceReleaseUID}
	require.NoError(t, r.client.Update(t.Context(), target))
	conflicted := false
	watchClient, ok := r.client.(client.WithWatch)
	require.True(t, ok)
	r.client = interceptor.NewClient(watchClient, interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, subResource string, object client.Object, opts ...client.SubResourceUpdateOption) error {
		if _, ok := object.(*api.Application); ok && subResource == "status" && !conflicted {
			conflicted = true
			return apierrors.NewConflict(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "applications"}, target.Name, nil)
		}
		return c.SubResource(subResource).Update(ctx, object, opts...)
	}})
	require.NoError(t, r.reconcilePromotionRetry(t.Context(), target))
	require.True(t, conflicted)
	fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	require.Equal(t, promotionRetryTestToken, fresh.Status.Promotion.VerificationAttempt)
	require.Equal(t, "Verifying", fresh.Status.Promotion.Phase)
	require.Empty(t, fresh.Annotations[promotionApprovalAnnotation])
	require.Empty(t, fresh.Annotations[promotionRetryAnnotation])
}

func TestPromotionDurationRestartsAfterInterruptedObservation(t *testing.T) {
	t.Parallel()
	for _, interruption := range []string{"unhealthy", "missing", "stale"} {
		t.Run(interruption, func(t *testing.T) {
			t.Parallel()
			target, upstream, release := promotionFixture()
			target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 60}}
			r := newPromotionTestReconciler(t, target, upstream, release)
			_, err := r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			r.now = func() time.Time { return promotionTestNow.Add(20 * time.Second) }
			switch interruption {
			case "unhealthy":
				upstream.Status.ResourceHealth[0].Health = "Degraded"
			case "missing":
				upstream.Status.DeploymentObservation = nil
			case "stale":
				upstream.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(-time.Hour))
			}
			require.NoError(t, r.client.Status().Update(t.Context(), upstream))
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Nil(t, target.Status.Promotion.VerificationStartedAt)
			upstream.Status.ResourceHealth[0].Health = "Healthy"
			upstream.Status.DeploymentObservation = &api.ApplicationDeploymentObservation{Release: release.Name, ReleaseUID: string(release.UID), Revision: promotionTestRevision, ObservedGeneration: upstream.Generation, ObservedAt: metav1.NewTime(promotionTestNow.Add(40 * time.Second))}
			require.NoError(t, r.client.Status().Update(t.Context(), upstream))
			r.now = func() time.Time { return promotionTestNow.Add(40 * time.Second) }
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			r.now = func() time.Time { return promotionTestNow.Add(60 * time.Second) }
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, "Verifying", target.Status.Promotion.Phase, "pre-interruption time cannot qualify recovery")
			r.now = func() time.Time { return promotionTestNow.Add(100 * time.Second) }
			_, err = r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
		})
	}
}

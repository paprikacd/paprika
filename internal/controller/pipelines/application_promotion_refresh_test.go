package pipelines

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func succeedPromotionRefreshPipeline(t *testing.T, r *ApplicationReconciler, target *api.Application) {
	t.Helper()
	var pipeline api.Pipeline
	require.NoError(t, r.client.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: target.Status.Promotion.VerificationPipelineRef}, &pipeline))
	pipeline.Status.Phase, pipeline.Status.ObservedGeneration = api.PipelineSucceeded, pipeline.Generation
	pipeline.Status.StepStatuses = []api.StepStatus{{Name: "integration", Phase: api.StepSucceeded}}
	require.NoError(t, r.client.Status().Update(t.Context(), &pipeline))
}

func completedPromotionRefreshFixture(t *testing.T, gates []api.GateConfig) (*ApplicationReconciler, *api.Application) {
	t.Helper()
	target, upstream, release := promotionFixture()
	target.Spec.SyncPolicy = api.SyncManual
	target.Spec.Parameters = map[string]string{"tenant": "A"}
	target.Spec.Trigger.Tests = &api.ApplicationBuildSpec{Steps: []api.ApplicationBuildStep{{Name: "integration", Image: "test", Script: "true"}}}
	target.Spec.Trigger.Gates = gates
	r := newPromotionTestReconciler(t, target, upstream, release)
	r.Namespace, r.K8sClient = "jobs", k8sfake.NewSimpleClientset()
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	succeedPromotionRefreshPipeline(t, r, target)
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	// Model delivery admission and completion, preserving the accepted intent
	// independently of the next desired spec and verification attempt.
	target.Status.AcceptedDeployment = target.Spec.DeepCopy()
	target.Status.SourceRevision, target.Status.Revision = target.Status.Promotion.Revision, target.Status.Promotion.Revision
	target.Status.SourceHash, target.Status.ReleaseRef = "accepted-tree", "accepted-release"
	target.Status.Promotion.Phase = "Complete"
	require.NoError(t, r.client.Status().Update(t.Context(), target))
	return r, getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
}

func editPromotionRefreshTarget(t *testing.T, r *ApplicationReconciler, target *api.Application, tenant string) {
	t.Helper()
	target.Spec.Parameters["tenant"] = tenant
	target.Generation++
	target.Annotations = map[string]string{promotionApprovalAnnotation: target.Status.Promotion.SourceReleaseUID}
	require.NoError(t, r.client.Update(t.Context(), target))
}

func TestPromotionTargetEditRunsFreshPipelineGatesAndApproval(t *testing.T) {
	t.Parallel()
	var probes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		probes.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	r, target := completedPromotionRefreshFixture(t, []api.GateConfig{{Type: "smoke-test", Endpoint: server.URL, Timeout: 1}})
	require.EqualValues(t, 1, probes.Load())
	accepted, previous := target.Status.AcceptedDeployment.DeepCopy(), target.Status.Promotion.DeepCopy()
	editPromotionRefreshTarget(t, r, target, "B")
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.NotEqual(t, previous.VerificationPipelineRef, target.Status.Promotion.VerificationPipelineRef)
	require.Contains(t, target.Status.Promotion.VerificationAttempt, "config-")
	require.NotEqual(t, previous.VerificationConfigHash, target.Status.Promotion.VerificationConfigHash)
	require.Nil(t, target.Status.Promotion.VerificationStartedAt)
	require.Empty(t, target.Annotations[promotionApprovalAnnotation])
	require.Equal(t, accepted, target.Status.AcceptedDeployment)
	require.Equal(t, "accepted-release", target.Status.ReleaseRef)
	require.Equal(t, "accepted-tree", target.Status.SourceHash)
	require.EqualValues(t, 1, probes.Load(), "gates cannot run until the new Pipeline succeeds")
	// A controller restart resumes this exact new attempt, not another Pipeline.
	attempt, pipeline := target.Status.Promotion.VerificationAttempt, target.Status.Promotion.VerificationPipelineRef
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, attempt, target.Status.Promotion.VerificationAttempt)
	require.Equal(t, pipeline, target.Status.Promotion.VerificationPipelineRef)
	succeedPromotionRefreshPipeline(t, r, target)
	r.now = func() time.Time { return promotionTestNow.Add(time.Second) }
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.EqualValues(t, 2, probes.Load(), "the previously passed gate must run again")
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	require.Equal(t, accepted, target.Status.AcceptedDeployment)
	require.NotEqual(t, previous.VerificationStartedAt, target.Status.Promotion.VerificationStartedAt)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionApprovalAnnotation: target.Status.Promotion.SourceReleaseUID}
	require.NoError(t, r.client.Update(t.Context(), target))
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Ready", target.Status.Promotion.Phase)
	require.Equal(t, accepted, target.Status.AcceptedDeployment, "only delivery admission may replace accepted settings")
}

func TestPromotionTargetRefreshCannotReuseEarlierPipeline(t *testing.T) {
	t.Parallel()
	r, target := completedPromotionRefreshFixture(t, nil)
	names, attempts := []string{target.Status.Promotion.VerificationPipelineRef}, []string{target.Status.Promotion.VerificationAttempt}
	for _, tenant := range []string{"B", "A"} {
		editPromotionRefreshTarget(t, r, target, tenant)
		_, err := r.reconcilePromotionTrigger(t.Context(), target)
		require.NoError(t, err)
		require.Equal(t, "Verifying", target.Status.Promotion.Phase)
		require.NotContains(t, names, target.Status.Promotion.VerificationPipelineRef)
		require.NotContains(t, attempts, target.Status.Promotion.VerificationAttempt)
		names = append(names, target.Status.Promotion.VerificationPipelineRef)
		attempts = append(attempts, target.Status.Promotion.VerificationAttempt)
		// The next edit arrives while waiting for approval. Both attempts must
		// qualify the target afresh, even when returning to its original spec.
		succeedPromotionRefreshPipeline(t, r, target)
		_, err = r.reconcilePromotionTrigger(t.Context(), target)
		require.NoError(t, err)
		require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
		target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	}
	var pipelines api.PipelineList
	require.NoError(t, r.client.List(t.Context(), &pipelines))
	require.Len(t, pipelines.Items, 3)
	require.Empty(t, target.Status.Promotion.ConsumedVerificationAttempts, "target edits do not spend explicit retries")
}

func TestPromotionTargetRefreshInvalidatesReadyPipeline(t *testing.T) {
	t.Parallel()
	r, target := completedPromotionRefreshFixture(t, nil)
	target.Status.Promotion.Phase = "Ready"
	require.NoError(t, r.client.Status().Update(t.Context(), target))
	previous := target.Status.Promotion.DeepCopy()
	editPromotionRefreshTarget(t, r, target, "B")
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.NotEqual(t, previous.VerificationPipelineRef, target.Status.Promotion.VerificationPipelineRef)
	require.NotEmpty(t, target.Status.Promotion.VerificationAttempt)
	require.Empty(t, target.Annotations[promotionApprovalAnnotation])
	require.False(t, meta.IsStatusConditionTrue(target.Status.Conditions, promotionReadyCondition))
}

func TestPromotionTargetRefreshWaitsForPriorExecution(t *testing.T) {
	t.Parallel()
	for _, state := range []string{"pending pipeline", "running pipeline", "stale terminal pipeline", "active job"} {
		t.Run(state, func(t *testing.T) {
			t.Parallel()
			r, target := completedPromotionRefreshFixture(t, nil)
			previous := target.Status.Promotion.DeepCopy()
			if state == "active job" {
				job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "old-verification", Namespace: "jobs", Labels: map[string]string{"paprika.io/pipeline": previous.VerificationPipelineRef}}}
				job.Status.Active = 1
				r.K8sClient = k8sfake.NewSimpleClientset(job)
			} else {
				var pipeline api.Pipeline
				require.NoError(t, r.client.Get(t.Context(), client.ObjectKey{Namespace: target.Namespace, Name: previous.VerificationPipelineRef}, &pipeline))
				if state == "stale terminal pipeline" {
					pipeline.Generation++
					require.NoError(t, r.client.Update(t.Context(), &pipeline))
				} else if state == "running pipeline" {
					pipeline.Status.Phase = api.PipelineRunning
				} else {
					pipeline.Status.Phase = ""
				}
				require.NoError(t, r.client.Status().Update(t.Context(), &pipeline))
			}
			editPromotionRefreshTarget(t, r, target, "B")
			_, err := r.reconcilePromotionTrigger(t.Context(), target)
			require.NoError(t, err)
			require.Equal(t, previous.VerificationPipelineRef, target.Status.Promotion.VerificationPipelineRef)
			require.Equal(t, previous.VerificationConfigHash, target.Status.Promotion.VerificationConfigHash)
			require.Empty(t, target.Status.Promotion.VerificationAttempt)
			var pipelines api.PipelineList
			require.NoError(t, r.client.List(t.Context(), &pipelines))
			require.Len(t, pipelines.Items, 1, "no new execution may overlap the old one")
		})
	}
}

func TestPromotionTargetRefreshRestartsDurationWindow(t *testing.T) {
	t.Parallel()
	r, target := completedPromotionRefreshFixture(t, nil)
	previous := target.Status.Promotion.VerificationStartedAt.DeepCopy()
	target.Spec.Trigger.Gates = []api.GateConfig{{Type: "duration", Timeout: 60}}
	editPromotionRefreshTarget(t, r, target, "B")
	_, err := r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Nil(t, target.Status.Promotion.VerificationStartedAt)
	succeedPromotionRefreshPipeline(t, r, target)
	r.now = func() time.Time { return promotionTestNow.Add(30 * time.Second) }
	_, err = r.reconcilePromotionTrigger(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, "Verifying", target.Status.Promotion.Phase)
	require.NotEqual(t, previous, target.Status.Promotion.VerificationStartedAt)
	require.Equal(t, promotionTestNow.Add(30*time.Second), target.Status.Promotion.VerificationStartedAt.Time.UTC())
}

func TestPromotionTargetRefreshActivationHandlesConflictAndCrash(t *testing.T) {
	t.Parallel()
	for _, failure := range []string{"conflict", "crash", "concurrent edit"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			r, target := completedPromotionRefreshFixture(t, nil)
			previous, accepted := target.Status.Promotion.DeepCopy(), target.Status.AcceptedDeployment.DeepCopy()
			editPromotionRefreshTarget(t, r, target, "B")
			injected := false
			watch, ok := r.client.(client.WithWatch)
			require.True(t, ok)
			r.client = interceptor.NewClient(watch, interceptor.Funcs{SubResourceUpdate: func(ctx context.Context, c client.Client, subResource string, object client.Object, opts ...client.SubResourceUpdateOption) error {
				if app, ok := object.(*api.Application); ok && subResource == "status" && !injected && app.Status.Promotion.VerificationAttempt != "" {
					injected = true
					stored := &api.Application{}
					require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(target), stored))
					require.Empty(t, stored.Annotations[promotionApprovalAnnotation], "approval must already be removed before activation")
					if failure == "crash" {
						return errors.New("simulated controller interruption")
					}
					if failure == "concurrent edit" {
						stored.Spec.Parameters["tenant"] = "C"
						stored.Generation++
						require.NoError(t, c.Update(ctx, stored))
					}
					return apierrors.NewConflict(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "applications"}, target.Name, nil)
				}
				return c.SubResource(subResource).Update(ctx, object, opts...)
			}})
			_, err := r.reconcilePromotionTrigger(t.Context(), target)
			fresh := getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
			require.True(t, injected)
			require.Empty(t, fresh.Annotations[promotionApprovalAnnotation])
			require.Equal(t, accepted, fresh.Status.AcceptedDeployment)
			if failure == "conflict" {
				require.NoError(t, err)
				require.Equal(t, "Verifying", fresh.Status.Promotion.Phase)
				require.NotEmpty(t, fresh.Status.Promotion.VerificationAttempt)
			} else {
				require.Error(t, err)
				require.Equal(t, previous, fresh.Status.Promotion, "failed activation cannot replace persisted verification")
				_, err = r.reconcilePromotionTrigger(t.Context(), fresh)
				require.NoError(t, err, "the next reconciliation resumes from the current target intent")
				require.Equal(t, "Verifying", fresh.Status.Promotion.Phase)
				require.Empty(t, fresh.Annotations[promotionApprovalAnnotation])
			}
		})
	}
}

func TestPromotionTargetRefreshFailureKeepsAcceptedDeployment(t *testing.T) {
	t.Parallel()
	r, app, _, _, release := acceptedPromotionRetryFixture(t)
	key := client.ObjectKeyFromObject(app)
	setPromotionRetryReleasePhase(t, r, release, api.ReleaseComplete)
	app = reconcilePromotionRetryApp(t, r, key)
	accepted, previous := app.Status.AcceptedDeployment.DeepCopy(), app.Status.Promotion.DeepCopy()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer server.Close()
	app.Spec.Parameters["replicas"] = "9"
	app.Spec.Trigger.Gates = []api.GateConfig{{Type: "smoke-test", Endpoint: server.URL, Timeout: 1}}
	app.Generation++
	require.NoError(t, r.client.Update(t.Context(), app))
	for range 3 {
		app = reconcilePromotionRetryApp(t, r, key)
		require.Equal(t, "Failed", app.Status.Promotion.Phase)
		require.Contains(t, app.Status.Promotion.Message, "HTTP 503")
		require.Equal(t, previous.SourceReleaseUID, app.Status.Promotion.SourceReleaseUID)
		require.Equal(t, accepted, app.Status.AcceptedDeployment)
		require.Equal(t, release.Name, app.Status.ReleaseRef)
		require.False(t, meta.IsStatusConditionTrue(app.Status.Conditions, promotionReadyCondition))
	}
	var releases api.ReleaseList
	require.NoError(t, r.client.List(t.Context(), &releases, client.InNamespace(app.Namespace)))
	require.Len(t, releases.Items, 1, "the old completed release cannot bypass failed fresh verification")
}

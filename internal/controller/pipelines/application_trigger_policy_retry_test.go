package pipelines

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

// Admit through the actual exact-UID approval path before modelling Release
// controller transitions; retries must never manufacture fresh authorization.
func acceptedPromotionRetryFixture(t *testing.T) (*ApplicationReconciler, *api.Application, *api.Application, *api.Release, *api.Release) {
	t.Helper()
	app, upstream, upstreamRelease := promotionFixture()
	app.Spec.SyncPolicy = api.SyncManual
	app.Spec.Stages = []api.ApplicationPromotionStage{{Name: "stg"}}
	app.Spec.Parameters = map[string]string{"replicas": "2"}
	app.Annotations = map[string]string{promotionApprovalAnnotation: string(upstreamRelease.UID)}
	r := newPromotionTestReconciler(t, app, upstream, upstreamRelease)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: promotionTestRevision + ":tree", Revision: promotionTestRevision}}
	app = reconcilePromotionRetryApp(t, r, client.ObjectKeyFromObject(app))
	require.Equal(t, "Promoting", app.Status.Promotion.Phase)
	require.Empty(t, app.Annotations[promotionApprovalAnnotation])
	var release api.Release
	require.NoError(t, r.client.Get(context.Background(), client.ObjectKey{Namespace: app.Namespace, Name: app.Status.ReleaseRef}, &release))
	release.UID, release.Generation = "admitted-release-uid", 1
	require.NoError(t, r.client.Update(context.Background(), &release))
	setPromotionRetryReleasePhase(t, r, &release, api.ReleaseVerifying)
	return r, app, upstream, upstreamRelease, &release
}

func reconcilePromotionRetryApp(t *testing.T, r *ApplicationReconciler, key client.ObjectKey) *api.Application {
	t.Helper()
	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	require.NoError(t, err)
	return getPromotionTestApp(t, r, key)
}

func setPromotionRetryReleasePhase(t *testing.T, r *ApplicationReconciler, release *api.Release, phase api.ReleasePhase) {
	t.Helper()
	require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(release), release))
	release.Status.Phase, release.Status.ObservedGeneration = phase, release.Generation
	require.NoError(t, r.client.Status().Update(context.Background(), release))
}

func TestAcceptedPromotionManualRetryRecoversCandidate(t *testing.T) {
	for _, observeRetry := range []bool{true, false} {
		name := "retry in progress observed"
		if !observeRetry {
			name = "retry completion observed directly"
		}
		t.Run(name, func(t *testing.T) {
			r, app, _, _, release := acceptedPromotionRetryFixture(t)
			key := client.ObjectKeyFromObject(app)
			accepted := app.Status.AcceptedDeployment.DeepCopy()
			candidate := app.Status.Promotion.DeepCopy()
			setPromotionRetryReleasePhase(t, r, release, api.ReleaseFailed)
			app = reconcilePromotionRetryApp(t, r, key)
			require.Equal(t, "Failed", app.Status.Promotion.Phase)
			require.Equal(t, api.ApplicationDegraded, app.Status.Phase)

			// GitOps may edit the next intent while this accepted release repairs.
			app.Spec.Parameters["replicas"] = "9"
			app.Spec.Source.Path = "env/next-staging"
			app.Generation++
			app.Annotations = map[string]string{syncAnnotation: "retry", manualSyncAnnotation: "retry"}
			require.NoError(t, r.client.Update(context.Background(), app))
			app = reconcilePromotionRetryApp(t, r, key)
			require.Equal(t, "Failed", app.Status.Promotion.Phase)
			require.Equal(t, api.ApplicationPending, app.Status.Phase)
			require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(release), release))
			require.NotEmpty(t, release.Annotations[resyncAnnotation], "the Application requested a legitimate retry of the existing release")
			require.Empty(t, app.Annotations[promotionApprovalAnnotation], "the consumed approval must not be requested again")

			if observeRetry {
				setPromotionRetryReleasePhase(t, r, release, api.ReleasePending)
				app = reconcilePromotionRetryApp(t, r, key)
				require.Equal(t, "Promoting", app.Status.Promotion.Phase)
				require.True(t, meta.IsStatusConditionTrue(app.Status.Conditions, promotionReadyCondition))
			}
			setPromotionRetryReleasePhase(t, r, release, api.ReleaseComplete)
			for range 3 {
				app = reconcilePromotionRetryApp(t, r, key)
				require.Equal(t, "Complete", app.Status.Promotion.Phase)
				require.Equal(t, api.ApplicationHealthy, app.Status.Phase)
				require.Equal(t, release.Name, app.Status.ReleaseRef)
				require.Equal(t, promotionTestRevision, app.Status.SourceRevision)
				require.Equal(t, promotionTestRevision, app.Status.Revision)
				require.Equal(t, candidate.SourceReleaseUID, app.Status.Promotion.SourceReleaseUID)
				require.Equal(t, candidate.VerificationConfigHash, app.Status.Promotion.VerificationConfigHash)
				require.Equal(t, accepted, app.Status.AcceptedDeployment, "retry must use the frozen accepted deployment")
				require.Equal(t, "9", app.Spec.Parameters["replicas"], "pending desired edits remain pending")
				require.Empty(t, app.Annotations[promotionApprovalAnnotation])
			}
			var releases api.ReleaseList
			require.NoError(t, r.client.List(context.Background(), &releases, client.InNamespace(app.Namespace)))
			require.Len(t, releases.Items, 1, "retry must not replace or duplicate the admitted release")
			require.Equal(t, release.UID, releases.Items[0].UID)
			require.Equal(t, "2", releases.Items[0].Spec.Parameters["replicas"])
		})
	}
}

func TestFailedNewVerificationCannotRecoverFromOlderCompletedDeployment(t *testing.T) {
	r, app, upstream, upstreamRelease, release := acceptedPromotionRetryFixture(t)
	key := client.ObjectKeyFromObject(app)
	setPromotionRetryReleasePhase(t, r, release, api.ReleaseComplete)
	app = reconcilePromotionRetryApp(t, r, key)
	require.Equal(t, "Complete", app.Status.Promotion.Phase)
	accepted := app.Status.AcceptedDeployment.DeepCopy()
	next := upstreamRelease.DeepCopy()
	next.Name, next.UID, next.ResourceVersion = "dev-release-next", "dev-release-next-uid", ""
	require.NoError(t, r.client.Create(context.Background(), next))
	upstream.Status.ReleaseRef = next.Name
	upstream.Status.DeploymentObservation.Release, upstream.Status.DeploymentObservation.ReleaseUID = next.Name, string(next.UID)
	require.NoError(t, r.client.Status().Update(context.Background(), upstream))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer server.Close()
	app.Spec.Trigger.Gates = []api.GateConfig{{Type: "smoke-test", Endpoint: server.URL, Timeout: 1}}
	app.Generation++
	require.NoError(t, r.client.Update(context.Background(), app))
	for range 3 {
		app = reconcilePromotionRetryApp(t, r, key)
		require.Equal(t, "Failed", app.Status.Promotion.Phase)
		require.Contains(t, app.Status.Promotion.Message, "HTTP 503")
		require.Equal(t, string(next.UID), app.Status.Promotion.SourceReleaseUID)
		require.Equal(t, api.ApplicationHealthy, app.Status.Phase, "the older accepted deployment remains independently healthy")
		require.Equal(t, accepted, app.Status.AcceptedDeployment)
		require.Equal(t, release.Name, app.Status.ReleaseRef)
		require.Empty(t, app.Annotations[promotionApprovalAnnotation])
	}
	var releases api.ReleaseList
	require.NoError(t, r.client.List(context.Background(), &releases, client.InNamespace(app.Namespace)))
	require.Len(t, releases.Items, 1, "failed verification must not create a new delivery release")
	require.Equal(t, release.UID, releases.Items[0].UID)
	require.False(t, meta.IsStatusConditionTrue(app.Status.Conditions, promotionReadyCondition))
}

func TestAcceptedPromotionRetryRejectsUnprovenRelease(t *testing.T) {
	type rejectionCase struct {
		name   string
		mutate func(*api.Application, *api.Release)
	}
	cases := make([]rejectionCase, 0, 19)
	cases = append(cases,
		rejectionCase{"accepted intent absent", func(a *api.Application, _ *api.Release) { a.Status.AcceptedDeployment = nil }},
		rejectionCase{"accepted intent changed", func(a *api.Application, _ *api.Release) { a.Status.AcceptedDeployment.Parameters["replicas"] = "3" }},
		rejectionCase{"accepted revision changed", func(a *api.Application, _ *api.Release) { a.Status.SourceRevision = "different-accepted-revision" }},
		rejectionCase{"candidate verification hash changed", func(a *api.Application, _ *api.Release) { a.Status.Promotion.VerificationConfigHash = "different-hash" }},
		rejectionCase{"active release changed", func(a *api.Application, _ *api.Release) { a.Status.ReleaseRef = "different-release" }},
		rejectionCase{"release identity absent", func(_ *api.Application, r *api.Release) { r.UID = "" }},
		rejectionCase{"release namespace differs", func(_ *api.Application, r *api.Release) { r.Namespace = "elsewhere" }},
		rejectionCase{"release generation unobserved", func(_ *api.Application, r *api.Release) { r.Generation++ }},
		rejectionCase{"Application owner absent", func(_ *api.Application, r *api.Release) { r.OwnerReferences = nil }},
		rejectionCase{"Application owner UID differs", func(_ *api.Application, r *api.Release) { r.OwnerReferences[0].UID = "other-application-uid" }},
		rejectionCase{"Application owner name differs", func(_ *api.Application, r *api.Release) { r.OwnerReferences[0].Name = "other-application" }},
		rejectionCase{"Application owner kind differs", func(_ *api.Application, r *api.Release) { r.OwnerReferences[0].Kind = "Other" }},
	)
	for _, key := range []string{sourceRevisionAnnotation, "paprika.io/promotion-source-application", "paprika.io/promotion-source-namespace", promotionSourceUIDAnnotation, "paprika.io/promotion-source-release", promotionReleaseUIDAnnotation, "paprika.io/promotion-verification-config"} {
		cases = append(cases, rejectionCase{
			name:   "release provenance differs: " + key,
			mutate: func(_ *api.Application, r *api.Release) { r.Annotations[key] = "different" },
		})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, app, _, _, release := acceptedPromotionRetryFixture(t)
			app.Status.Promotion.Phase, app.Status.Promotion.Message = "Failed", "Verification failed; retain this candidate"
			release.Status.Phase = api.ReleaseComplete
			tc.mutate(app, release)
			updatePromotionReleasePhase(app, release)
			require.Equal(t, "Failed", app.Status.Promotion.Phase)
			require.Equal(t, "Verification failed; retain this candidate", app.Status.Promotion.Message)
		})
	}
}

func TestAcceptedPromotionRetryPreservesConcurrentDesiredEditOnStatusConflict(t *testing.T) {
	r, app, _, _, release := acceptedPromotionRetryFixture(t)
	key := client.ObjectKeyFromObject(app)
	setPromotionRetryReleasePhase(t, r, release, api.ReleaseFailed)
	app = reconcilePromotionRetryApp(t, r, key)
	accepted := app.Status.AcceptedDeployment.DeepCopy()
	setPromotionRetryReleasePhase(t, r, release, api.ReleaseComplete)
	watchClient, ok := r.client.(client.WithWatch)
	require.True(t, ok)
	conflicted := false
	r.client = interceptor.NewClient(watchClient, interceptor.Funcs{
		SubResourceUpdate: func(ctx context.Context, c client.Client, subresource string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
			retryApp, isApp := obj.(*api.Application)
			if isApp && retryApp.Status.Promotion != nil && retryApp.Status.Promotion.Phase == "Complete" && !conflicted {
				conflicted = true
				var fresh api.Application
				require.NoError(t, c.Get(ctx, key, &fresh))
				fresh.Spec.Parameters["replicas"] = "9"
				fresh.Generation++
				require.NoError(t, c.Update(ctx, &fresh))
				return apierrors.NewConflict(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "applications"}, app.Name, errors.New("concurrent desired configuration edit"))
			}
			return c.SubResource(subresource).Update(ctx, obj, opts...)
		},
	})
	app = reconcilePromotionRetryApp(t, r, key)
	require.True(t, conflicted, "exercise the optimistic concurrency retry")
	require.Equal(t, "Complete", app.Status.Promotion.Phase)
	require.Equal(t, release.Name, app.Status.ReleaseRef)
	require.Equal(t, accepted, app.Status.AcceptedDeployment)
	require.Equal(t, "9", app.Spec.Parameters["replicas"], "status retries must preserve a concurrent pending spec edit")
	require.Empty(t, app.Annotations[promotionApprovalAnnotation])
}

package pipelines

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	kptr "k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

type applicationFinalizationClient struct {
	client.Client
	appKey      client.ObjectKey
	appUID      types.UID
	creates     int
	deletes     []client.ObjectKey
	deleteError error
}

func (c *applicationFinalizationClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if owner := metav1.GetControllerOf(obj); owner != nil && owner.UID == c.appUID {
		var app api.Application
		if err := c.Client.Get(ctx, c.appKey, &app); err != nil {
			return err
		}
		if !hasApplicationFinalizer(&app) {
			return errors.New("child creation preceded persisted Application finalizer")
		}
		c.creates++
	}
	return c.Client.Create(ctx, obj, opts...)
}

func (c *applicationFinalizationClient) Delete(ctx context.Context, obj client.Object, opts ...client.DeleteOption) error {
	c.deletes = append(c.deletes, client.ObjectKeyFromObject(obj))
	if c.deleteError != nil {
		return c.deleteError
	}
	return c.Client.Delete(ctx, obj, opts...)
}

func finalizationRelease(app *api.Application, name string, ownerUID types.UID) *api.Release {
	return &api.Release{ObjectMeta: metav1.ObjectMeta{
		Name: name, Namespace: app.Namespace, UID: types.UID(name + "-uid"), Finalizers: []string{releaseFinalizer},
		OwnerReferences: []metav1.OwnerReference{{APIVersion: api.GroupVersion.String(), Kind: "Application", Name: app.Name, UID: ownerUID, Controller: kptr.To(true)}},
	}}
}

func finalizationApp() *api.Application {
	app := triggerPolicyApp(api.ApplicationTriggerGitOps)
	app.Finalizers = []string{applicationFinalizer}
	app.DeletionTimestamp = &metav1.Time{Time: promotionTestNow}
	return app
}

func finalizationReconciler(t *testing.T, app *api.Application, objects ...client.Object) (*ApplicationReconciler, *applicationFinalizationClient) {
	t.Helper()
	r := triggerPolicyReconciler(t, app, objects...)
	c := &applicationFinalizationClient{Client: r.client, appKey: client.ObjectKeyFromObject(app), appUID: app.UID}
	r.client = c
	return r, c
}

func TestApplicationFinalizerPersistsBeforeChildCreation(t *testing.T) {
	app := triggerPolicyApp(api.ApplicationTriggerGitOps)
	r, c := finalizationReconciler(t, app)
	sha := strings.Repeat("a", 40)
	r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: sha + ":tree", Revision: sha}}

	_, err := r.reconcileObservedApplication(context.Background(), app)
	require.NoError(t, err)
	require.GreaterOrEqual(t, c.creates, 3, "the protected reconcile should create its Template, Stage and Release without an extra pass")
	var persisted api.Application
	require.NoError(t, c.Get(context.Background(), client.ObjectKeyFromObject(app), &persisted))
	require.True(t, hasApplicationFinalizer(&persisted))
}

func TestApplicationFinalizerRefreshesConcurrentDesiredSpec(t *testing.T) {
	app := triggerPolicyApp(api.ApplicationTriggerGitOps)
	app.Generation = 7
	app.Spec.Parameters = map[string]string{"version": "current"}
	app.Status.ReleaseRef = "current-release"
	r, c := finalizationReconciler(t, app)
	stale := app.DeepCopy()
	stale.Generation = 6
	stale.Spec.Parameters["version"] = "stale"
	stale.Status.ReleaseRef = "stale-release"

	require.NoError(t, r.ensureApplicationFinalizer(context.Background(), stale))
	require.EqualValues(t, 7, stale.Generation)
	require.Equal(t, "current", stale.Spec.Parameters["version"])
	require.Equal(t, "current-release", stale.Status.ReleaseRef)
	var persisted api.Application
	require.NoError(t, c.Get(context.Background(), client.ObjectKeyFromObject(app), &persisted))
	require.Equal(t, persisted.ResourceVersion, stale.ResourceVersion)
	require.Equal(t, persisted.Spec, stale.Spec)
	// A subsequent full-object update using the refreshed resource version
	// must retain the current GitOps intent.
	require.NoError(t, c.Update(context.Background(), stale))
	require.NoError(t, c.Get(context.Background(), client.ObjectKeyFromObject(app), &persisted))
	require.Equal(t, "current", persisted.Spec.Parameters["version"])
}

func TestApplicationFinalizerDrainsOwnedReleasesBeforeRemovingProtection(t *testing.T) {
	ctx := context.Background()
	app := finalizationApp()
	owned := finalizationRelease(app, "owned", app.UID)
	foreign := finalizationRelease(app, "foreign", "previous-application-uid")
	stage := &api.Stage{ObjectMeta: metav1.ObjectMeta{Name: app.Name + "-stg", Namespace: app.Namespace}}
	r, c := finalizationReconciler(t, app, owned, foreign, stage)

	result, err := r.reconcileObservedApplication(ctx, app)
	require.NoError(t, err)
	require.Positive(t, result.RequeueAfter)
	require.Equal(t, []client.ObjectKey{client.ObjectKeyFromObject(owned)}, c.deletes)
	var savedApp api.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &savedApp))
	require.True(t, hasApplicationFinalizer(&savedApp))
	var savedRelease api.Release
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(owned), &savedRelease))
	require.False(t, savedRelease.DeletionTimestamp.IsZero())
	require.Contains(t, savedRelease.Finalizers, releaseFinalizer, "Application cleanup must not bypass Release resource cleanup")
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(stage), &api.Stage{}))
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(foreign), foreign))
	require.True(t, foreign.DeletionTimestamp.IsZero())

	result, err = r.finalizeApplication(ctx, &savedApp)
	require.NoError(t, err)
	require.Positive(t, result.RequeueAfter)
	require.Len(t, c.deletes, 1, "already-terminating Releases must be allowed to finish")
	require.True(t, hasApplicationFinalizer(&savedApp))

	// Simulate successful Release finalization. Only this controller's own
	// finalizer is removed; the Application must observe the Release gone.
	savedRelease.Finalizers = nil
	require.NoError(t, c.Update(ctx, &savedRelease))
	require.True(t, apierrors.IsNotFound(c.Get(ctx, client.ObjectKeyFromObject(owned), &api.Release{})))
	result, err = r.finalizeApplication(ctx, &savedApp)
	require.NoError(t, err)
	require.Zero(t, result.RequeueAfter)
	require.True(t, apierrors.IsNotFound(c.Get(ctx, client.ObjectKeyFromObject(app), &api.Application{})))
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(foreign), &api.Release{}))
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(stage), &api.Stage{}), "Application finalization leaves child GC to Kubernetes")
}

func TestApplicationFinalizerHonorsOrphanDeletion(t *testing.T) {
	ctx := context.Background()
	app := finalizationApp()
	app.Finalizers = append(app.Finalizers, metav1.FinalizerOrphanDependents)
	release := finalizationRelease(app, "owned", app.UID)
	r, c := finalizationReconciler(t, app, release)

	_, err := r.finalizeApplication(ctx, app)
	require.NoError(t, err)
	require.Empty(t, c.deletes)
	var saved api.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &saved))
	require.False(t, hasApplicationFinalizer(&saved))
	require.Contains(t, saved.Finalizers, metav1.FinalizerOrphanDependents)
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(release), release))
	require.True(t, release.DeletionTimestamp.IsZero())
	require.Contains(t, release.Finalizers, releaseFinalizer)
}

func TestApplicationFinalizerKeepsProtectionWhenReleaseDeleteFails(t *testing.T) {
	ctx := context.Background()
	app := finalizationApp()
	release := finalizationRelease(app, "owned", app.UID)
	r, c := finalizationReconciler(t, app, release)
	c.deleteError = errors.New("delete transport failed")

	_, err := r.finalizeApplication(ctx, app)
	require.ErrorContains(t, err, "delete owned Release owned")
	var saved api.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &saved))
	require.True(t, hasApplicationFinalizer(&saved))
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(release), release))
	require.Contains(t, release.Finalizers, releaseFinalizer)
}

package pipelines

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// staleCacheClient models the informer cache right after another writer
// updated an object: every Get returns the copy the cache held before that
// write, so its resourceVersion is stale and every Update from it conflicts.
// apiReader reads the real store, like mgr.GetAPIReader().
func staleCacheClient(t *testing.T, objects ...client.Object) (cached client.Client, apiReader client.Reader, bump func(client.Object)) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	store := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&api.Application{}, &api.Release{}).WithObjects(objects...).Build()
	snapshots := map[client.ObjectKey]client.Object{}
	for _, obj := range objects {
		live, ok := obj.DeepCopyObject().(client.Object)
		require.True(t, ok)
		require.NoError(t, store.Get(context.Background(), client.ObjectKeyFromObject(obj), live))
		snapshots[client.ObjectKeyFromObject(obj)] = live
	}
	cached = interceptor.NewClient(store, interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if snap, ok := snapshots[key]; ok {
				return c.Scheme().Convert(snap.DeepCopyObject(), obj, nil)
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})
	// bump writes through the real store, as a concurrent controller would,
	// so the cached snapshot falls one resourceVersion behind.
	bump = func(obj client.Object) {
		live, ok := obj.DeepCopyObject().(client.Object)
		require.True(t, ok)
		require.NoError(t, store.Get(context.Background(), client.ObjectKeyFromObject(obj), live))
		live.SetAnnotations(map[string]string{"concurrent": "write"})
		require.NoError(t, store.Update(context.Background(), live))
	}
	return cached, store, bump
}

func TestApplicationStatusRetryReadsTheAPIServerAfterAConflict(t *testing.T) {
	t.Parallel()
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "prod"}}
	cached, apiReader, bump := staleCacheClient(t, app)
	bump(app)
	r := &ApplicationReconciler{client: cached, sourceMetadataReader: apiReader}

	app.Status.Phase = api.ApplicationHealthy
	require.NoError(t, r.patchAppStatus(context.Background(), app),
		"a stale cache must not exhaust the conflict retries; the retry reads the API server")

	var stored api.Application
	require.NoError(t, apiReader.Get(context.Background(), client.ObjectKeyFromObject(app), &stored))
	require.Equal(t, api.ApplicationHealthy, stored.Status.Phase)
}

func TestReleaseStatusRetryReadsTheAPIServerAfterAConflict(t *testing.T) {
	t.Parallel()
	release := &api.Release{ObjectMeta: metav1.ObjectMeta{Name: "api-release", Namespace: "prod"}}
	cached, apiReader, bump := staleCacheClient(t, release)
	bump(release)
	r := &ReleaseReconciler{client: cached, apiReader: apiReader}

	release.Status.Phase = api.ReleasePromoting
	require.NoError(t, r.patchReleaseStatus(context.Background(), release, ""),
		"a stale cache must not exhaust the conflict retries; the retry reads the API server")

	var stored api.Release
	require.NoError(t, apiReader.Get(context.Background(), client.ObjectKeyFromObject(release), &stored))
	require.Equal(t, api.ReleasePromoting, stored.Status.Phase)
}

func TestReleaseStatusRetryWithoutAPIReaderKeepsTheCachedPath(t *testing.T) {
	t.Parallel()
	release := &api.Release{ObjectMeta: metav1.ObjectMeta{Name: "api-release", Namespace: "prod"}}
	cached, _, _ := staleCacheClient(t, release)
	r := &ReleaseReconciler{client: cached}
	release.Status.Phase = api.ReleasePromoting
	require.NoError(t, r.patchReleaseStatus(context.Background(), release, ""), "with a fresh cache and no API reader the write succeeds as before")
}

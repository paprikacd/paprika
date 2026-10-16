package apiserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	proto "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func protectedBundleSpec(artifact bool) *api.ApplicationSpec {
	spec := &api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/app.git"}}
	if artifact {
		spec.Source = api.ApplicationSource{Type: api.SourceTypeInline, Inline: &api.InlineSourceSpec{
			ConfigMapRef: "owned-bundle", ManifestHash: strings.Repeat("a", 64),
			Artifact: &api.InlineArtifact{Repository: "https://example.test/app.git", Revision: strings.Repeat("b", 40),
				Images: map[string]api.ArtifactImageReference{"backend": api.ArtifactImageReference("ghcr.io/example/app@sha256:" + strings.Repeat("c", 64))}},
		}}
	} else {
		spec.Trigger = &api.ApplicationTrigger{Type: api.ApplicationTriggerPromotion, From: &api.ApplicationReference{Name: "upstream"}}
	}
	return spec
}

func TestApplyBundleRejectsExistingPromotionContractWithoutWrites(t *testing.T) {
	for _, test := range []struct {
		name     string
		artifact bool
		accepted bool
	}{
		{name: "promotion"},
		{name: "artifact", artifact: true},
		{name: "accepted promotion", accepted: true},
		{name: "accepted artifact", artifact: true, accepted: true},
	} {
		for _, dryRun := range []bool{false, true} {
			t.Run(test.name+map[bool]string{false: " apply", true: " dry-run"}[dryRun], func(t *testing.T) {
				c := newApplyBundleClient(t)
				spec := protectedBundleSpec(test.artifact)
				app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "protected", Namespace: "tenant", UID: "app-uid"},
					Spec: *spec, Status: api.ApplicationStatus{ReleaseRef: "existing-release", SourceHash: "frozen"}}
				if test.accepted {
					app.Status.AcceptedDeployment = spec
					app.Spec = api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/next.git"}}
				}
				require.NoError(t, c.Create(t.Context(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: app.Namespace}}))
				require.NoError(t, c.Create(t.Context(), app))
				before := app.DeepCopy()
				srv := NewPaprikaServer(c, nil)
				_, err := srv.ApplyBundle(t.Context(), connect.NewRequest(&proto.ApplyBundleRequest{
					Name: app.Name, Namespace: app.Namespace, Manifests: sampleManifests(), DryRun: dryRun,
				}))
				require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
				var after api.Application
				require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(app), &after))
				require.Equal(t, before.Spec, after.Spec)
				require.Equal(t, before.Status, after.Status)
				require.Equal(t, before.Labels, after.Labels)
				requireNoBundleChildren(t, c)
			})
		}
	}
}

func requireNoBundleChildren(t *testing.T, c client.Client) {
	t.Helper()
	var stages api.StageList
	var releases api.ReleaseList
	var snapshots corev1.ConfigMapList
	require.NoError(t, c.List(t.Context(), &stages))
	require.NoError(t, c.List(t.Context(), &releases))
	require.NoError(t, c.List(t.Context(), &snapshots))
	require.Empty(t, stages.Items)
	require.Empty(t, releases.Items)
	require.Empty(t, snapshots.Items)
}

type bundlePromotionConflictClient struct {
	client.Client
	changed bool
}

func (c *bundlePromotionConflictClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if _, app := obj.(*api.Application); app && !c.changed {
		var actor api.Application
		if err := c.Client.Get(ctx, client.ObjectKeyFromObject(obj), &actor); err != nil {
			return err
		}
		actor.Spec = *protectedBundleSpec(false)
		if err := c.Client.Update(ctx, &actor); err != nil {
			return err
		}
		c.changed = true
		return apierrors.NewConflict(schema.GroupResource{Group: api.GroupVersion.Group, Resource: "applications"}, obj.GetName(), errors.New("publisher installed promotion intent"))
	}
	return c.Client.Update(ctx, obj, opts...)
}

func TestApplyBundleRechecksPromotionContractOnSpecConflict(t *testing.T) {
	c := &bundlePromotionConflictClient{Client: newApplyBundleClient(t)}
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "raced", Namespace: "tenant"},
		Spec: api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/app.git"}}}
	require.NoError(t, c.Create(t.Context(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: app.Namespace}}))
	require.NoError(t, c.Create(t.Context(), app))
	srv := NewPaprikaServer(c, nil)
	_, err := srv.ApplyBundle(t.Context(), connect.NewRequest(&proto.ApplyBundleRequest{Name: app.Name, Namespace: app.Namespace, Manifests: sampleManifests()}))
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	require.True(t, c.changed)
	var after api.Application
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(app), &after))
	require.Equal(t, *protectedBundleSpec(false), after.Spec)
	require.Empty(t, after.Status.ReleaseRef)
	requireNoBundleChildren(t, c)
}

type bundlePromotionAfterReadClient struct {
	client.Client
	changed bool
}

func (c *bundlePromotionAfterReadClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if err := c.Client.Get(ctx, key, obj, opts...); err != nil {
		return err
	}
	if app, ok := obj.(*api.Application); ok && !c.changed {
		actor := app.DeepCopy()
		actor.Spec = *protectedBundleSpec(false)
		if err := c.Client.Update(ctx, actor); err != nil {
			return err
		}
		c.changed = true
	}
	return nil
}

func TestApplyBundleDoesNotRepairCompleteBundleAfterConcurrentPromotion(t *testing.T) {
	c := &bundlePromotionAfterReadClient{Client: newApplyBundleClient(t)}
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "raced", Namespace: "tenant"},
		Spec:   api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/app.git"}},
		Status: api.ApplicationStatus{ReleaseRef: "complete-release"}}
	require.NoError(t, c.Create(t.Context(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: app.Namespace}}))
	require.NoError(t, c.Create(t.Context(), app))
	srv := NewPaprikaServer(c, nil)
	bundle, err := srv.prepareBundle(sampleManifests(), app.Namespace)
	require.NoError(t, err)
	release := &api.Release{ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: app.Namespace,
		Annotations: map[string]string{bundleSHAAnnotation: fullBundleSHA(bundle)}}, Status: api.ReleaseStatus{Phase: api.ReleaseComplete}}
	require.NoError(t, c.Create(t.Context(), release))
	_, err = srv.ApplyBundle(t.Context(), connect.NewRequest(&proto.ApplyBundleRequest{Name: app.Name, Namespace: app.Namespace, Manifests: sampleManifests()}))
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	require.True(t, c.changed)
	var stages api.StageList
	var snapshots corev1.ConfigMapList
	require.NoError(t, c.List(t.Context(), &stages))
	require.NoError(t, c.List(t.Context(), &snapshots))
	require.Empty(t, stages.Items, "idempotent bundle repair must not create or modify a stage")
	require.Empty(t, snapshots.Items)
	var retained api.Release
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(release), &retained))
	require.Equal(t, api.ReleaseComplete, retained.Status.Phase)
}

type bundlePromotionBeforeStatusClient struct{ client.Client }

func (c *bundlePromotionBeforeStatusClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if err := c.Client.Create(ctx, obj, opts...); err != nil {
		return err
	}
	if _, snapshot := obj.(*corev1.ConfigMap); snapshot {
		var actor api.Application
		if err := c.Client.Get(ctx, client.ObjectKey{Namespace: obj.GetNamespace(), Name: "raced"}, &actor); err != nil {
			return err
		}
		actor.Spec = *protectedBundleSpec(false)
		if err := c.Client.Update(ctx, &actor); err != nil {
			return err
		}
		actor.Status.ReleaseRef = "promoted-release"
		if err := c.Client.Status().Update(ctx, &actor); err != nil {
			return err
		}
	}
	return nil
}

func TestApplyBundleDoesNotReplacePromotionReleaseSelectedBeforeStatusWrite(t *testing.T) {
	c := &bundlePromotionBeforeStatusClient{Client: newApplyBundleClient(t)}
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "raced", Namespace: "tenant"},
		Spec:   api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.test/app.git"}},
		Status: api.ApplicationStatus{ReleaseRef: "old-release"}}
	require.NoError(t, c.Create(t.Context(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: app.Namespace}}))
	require.NoError(t, c.Create(t.Context(), app))
	for _, name := range []string{"old-release", "promoted-release"} {
		require.NoError(t, c.Create(t.Context(), &api.Release{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: app.Namespace}}))
	}
	srv := NewPaprikaServer(c, nil)
	_, err := srv.ApplyBundle(t.Context(), connect.NewRequest(&proto.ApplyBundleRequest{Name: app.Name, Namespace: app.Namespace, Manifests: sampleManifests()}))
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	var after api.Application
	require.NoError(t, c.Get(t.Context(), client.ObjectKeyFromObject(app), &after))
	require.Equal(t, *protectedBundleSpec(false), after.Spec)
	require.Equal(t, "promoted-release", after.Status.ReleaseRef)
	var releases api.ReleaseList
	require.NoError(t, c.List(t.Context(), &releases))
	// Existing Releases survive; the failed API call removes only its own new
	// Release. Kubernetes garbage collection handles that Release's snapshot.
	require.Len(t, releases.Items, 2)
	require.ElementsMatch(t, []string{"old-release", "promoted-release"}, []string{releases.Items[0].Name, releases.Items[1].Name})
}

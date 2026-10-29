package pipelines

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/source"
)

// slowThenReadySourceRenderer times out its first resolves, like the Application
// controller's repo-server renderer while the repo server clones a cold mirror,
// then answers. It records the templates it was asked to resolve.
type slowThenReadySourceRenderer struct {
	timeouts int
	result   *source.ResolveResult
	resolved []*paprikav1.Template
}

func (r *slowThenReadySourceRenderer) ResolveSource(_ context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error) {
	r.resolved = append(r.resolved, tmpl.DeepCopy())
	if r.timeouts > 0 {
		r.timeouts--
		return nil, fmt.Errorf("%w: resolve source %s/%s", engine.ErrRepoServerTimeout, tmpl.Namespace, tmpl.Name)
	}
	return r.result, nil
}

func (r *slowThenReadySourceRenderer) Render(context.Context, *paprikav1.Template, map[string]string) ([]byte, error) {
	return []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered\n"), nil
}

func syncTriggerFixture(t *testing.T, renderer *slowThenReadySourceRenderer) (*ApplicationReconciler, client.Client, *paprikav1.Application) {
	t.Helper()
	app := &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name: "brandbrain-api", Namespace: "brandbrain",
			Annotations: map[string]string{syncAnnotation: "29a3f4074d64-1"},
		},
		Spec: paprikav1.ApplicationSpec{
			Source: paprikav1.ApplicationSource{
				Type: paprikav1.SourceTypeGit, RepoURL: "https://github.com/skunkworq/brandbrain.git",
				Revision: "main", Path: "deploy/kubernetes/chart", FetchTTL: "45s",
			},
			Stages:     []paprikav1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			SyncPolicy: paprikav1.SyncAuto,
		},
		Status: paprikav1.ApplicationStatus{
			Phase: paprikav1.ApplicationHealthy, SourceHash: "e5e9b6d48aaaaaaa:chartcontentold0",
			SourceRevision: "e5e9b6d48", ReleaseRef: "brandbrain-api-release-old",
		},
	}
	template := &paprikav1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "brandbrain-api-template", Namespace: "brandbrain"},
		Spec:       buildTemplateSpec(app),
	}
	release := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "brandbrain-api-release-old", Namespace: "brandbrain"},
		Status:     paprikav1.ReleaseStatus{Phase: paprikav1.ReleaseComplete},
	}
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, template, release).
		WithStatusSubresource(&paprikav1.Application{}, &paprikav1.Release{}).Build()
	return &ApplicationReconciler{client: c, TemplateRenderer: renderer}, c, app
}

// The BrandBrain deploy of 2026-10-29 annotated brandbrain-api while the repo
// server was still cloning a cold mirror. A refresh that times out must leave
// the trigger in place for the next reconcile, which deploys the new commit
// once the repo server answers, instead of dropping it.
func TestHandleSyncTrigger_TimedOutRefreshKeepsTriggerUntilTheRepoServerAnswers(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	renderer := &slowThenReadySourceRenderer{
		timeouts: 2,
		result:   &source.ResolveResult{Hash: "de0485d97bbbbbbb:chartcontentnew0", Revision: "de0485d9767c"},
	}
	r, c, app := syncTriggerFixture(t, renderer)

	for range 2 {
		var current paprikav1.Application
		require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &current))
		res, err := r.handleSyncTrigger(ctx, &current)
		require.NoError(t, err)
		require.Equal(t, r.transientRequeue(), res.RequeueAfter, "a timed-out refresh retries soon")

		var stored paprikav1.Application
		require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &stored))
		require.Equal(t, "29a3f4074d64-1", stored.Annotations[syncAnnotation], "the trigger must survive a timed-out refresh")
		require.Equal(t, "e5e9b6d48aaaaaaa:chartcontentold0", stored.Status.SourceHash, "nothing is recorded from a refresh that did not finish")
		require.Equal(t, paprikav1.ApplicationHealthy, stored.Status.Phase)
	}

	var current paprikav1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &current))
	_, err := r.handleSyncTrigger(ctx, &current)
	require.NoError(t, err)

	var stored paprikav1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &stored))
	_, stillTriggered := stored.Annotations[syncAnnotation]
	require.False(t, stillTriggered, "the trigger is consumed once the refresh completes")
	require.Equal(t, "de0485d97bbbbbbb:chartcontentnew0", stored.Status.SourceHash)
	require.Equal(t, "de0485d9767c", stored.Status.SourceRevision)
	require.Equal(t, paprikav1.ApplicationPending, stored.Status.Phase, "the changed chart starts a new release")
	require.Len(t, renderer.resolved, 3)
}

// A sync trigger asks for a commit pushed seconds earlier. The repo server
// answers a branch from its mirror for spec.git.fetchTtl after any fetch, so a
// forced resolve must not carry the TTL; the steady-state poll still does.
func TestResolveTemplateSource_ForcedRefreshFetchesTheRemote(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	renderer := &slowThenReadySourceRenderer{result: &source.ResolveResult{Hash: "e5e9b6d48aaaaaaa:chartcontentold0", Revision: "e5e9b6d48"}}
	r, c, app := syncTriggerFixture(t, renderer)

	_, _, err := r.resolveTemplateSource(ctx, app, false)
	require.NoError(t, err)
	_, _, err = r.resolveTemplateSource(ctx, app, true)
	require.NoError(t, err)

	require.Len(t, renderer.resolved, 2)
	require.Equal(t, "45s", renderer.resolved[0].Spec.Git.FetchTTL, "the poll keeps the fetch TTL")
	require.Empty(t, renderer.resolved[1].Spec.Git.FetchTTL, "a sync trigger fetches the remote now")
	require.Equal(t, "main", renderer.resolved[1].Spec.Git.Revision)

	var stored paprikav1.Template
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: "brandbrain-api-template"}, &stored))
	require.Equal(t, "45s", stored.Spec.Git.FetchTTL, "the stored Template is not modified")
}

// redeployDuringResolveRenderer plays a second deploy that annotates the
// Application with a new sync value while the first trigger's refresh is
// still resolving.
type redeployDuringResolveRenderer struct {
	c      client.Client
	key    client.ObjectKey
	value  string
	result *source.ResolveResult
	calls  int
}

func (r *redeployDuringResolveRenderer) ResolveSource(ctx context.Context, _ *paprikav1.Template) (*source.ResolveResult, error) {
	r.calls++
	if r.calls == 1 {
		var app paprikav1.Application
		if err := r.c.Get(ctx, r.key, &app); err != nil {
			return nil, err
		}
		app.Annotations[syncAnnotation] = r.value
		if err := r.c.Update(ctx, &app); err != nil {
			return nil, err
		}
	}
	return r.result, nil
}

func (r *redeployDuringResolveRenderer) Render(context.Context, *paprikav1.Template, map[string]string) ([]byte, error) {
	return []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rendered\n"), nil
}

// A sync trigger set while the previous trigger's refresh resolves is a new
// request, possibly for a commit that resolve did not see. Consuming the
// handled trigger must leave it for the next reconcile.
func TestHandleSyncTrigger_SecondTriggerDuringRefreshSurvives(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	r, c, app := syncTriggerFixture(t, &slowThenReadySourceRenderer{})
	renderer := &redeployDuringResolveRenderer{
		c: c, key: client.ObjectKeyFromObject(app), value: "second-deploy",
		result: &source.ResolveResult{Hash: "de0485d97bbbbbbb:chartcontentnew0", Revision: "de0485d9767c"},
	}
	r.TemplateRenderer = renderer

	var current paprikav1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &current))
	require.Equal(t, "29a3f4074d64-1", current.Annotations[syncAnnotation])
	_, err := r.handleSyncTrigger(ctx, &current)
	require.NoError(t, err)

	var stored paprikav1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &stored))
	require.Equal(t, "second-deploy", stored.Annotations[syncAnnotation], "the second deploy's trigger must survive the first's consumption")
	require.Equal(t, "de0485d97bbbbbbb:chartcontentnew0", stored.Status.SourceHash, "the first trigger's refresh still completes")
	require.Equal(t, paprikav1.ApplicationPending, stored.Status.Phase)
	require.Equal(t, 1, renderer.calls)
	require.True(t, r.hasSyncTrigger(&stored), "the next reconcile handles the second trigger")
}

// The trigger the reconcile handled is cleared together with the legacy
// trigger annotations, and the in-memory Application is left as stored.
func TestHandleSyncTrigger_ClearsOnlyTheHandledValues(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	renderer := &slowThenReadySourceRenderer{result: &source.ResolveResult{Hash: "e5e9b6d48aaaaaaa:chartcontentold0", Revision: "e5e9b6d48"}}
	r, c, app := syncTriggerFixture(t, renderer)

	var current paprikav1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &current))
	current.Annotations[legacyWebhookTriggerAnnotation] = "push"
	current.Annotations["unrelated"] = "kept"
	require.NoError(t, c.Update(ctx, &current))

	_, err := r.handleSyncTrigger(ctx, &current)
	require.NoError(t, err)

	var stored paprikav1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(app), &stored))
	require.False(t, r.hasSyncTrigger(&stored), "every handled trigger is consumed: %v", stored.Annotations)
	require.Equal(t, "kept", stored.Annotations["unrelated"])
	require.Equal(t, stored.ResourceVersion, current.ResourceVersion, "the in-memory Application is the stored one")
	require.Equal(t, stored.Annotations, current.Annotations)
}

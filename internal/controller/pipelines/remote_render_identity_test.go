package pipelines

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

func remoteIdentityApp() *paprikav1.Application {
	return &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "remote", Namespace: "management", UID: "remote-uid"},
		Spec: paprikav1.ApplicationSpec{Source: paprikav1.ApplicationSource{
			Type: paprikav1.SourceTypeGit, RepoURL: "https://example.invalid/repo.git", Revision: "main", Path: "chart",
			TargetNamespace: "workloads", ValuesFile: "placement: old\n",
		}},
		Status: paprikav1.ApplicationStatus{Phase: paprikav1.ApplicationHealthy, SourceHash: "commit-one:chart-content", SourceRevision: "commit-one"},
	}
}

func TestRemoteRenderChangesCreateReleaseWithoutUpgradeChurn(t *testing.T) {
	for name, change := range map[string]func(*paprikav1.Application){
		"values only":    func(app *paprikav1.Application) { app.Spec.Source.ValuesFile = "placement: replacement\n" },
		"namespace only": func(app *paprikav1.Application) { app.Spec.Source.TargetNamespace = "replacement" },
	} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			app := remoteIdentityApp()
			tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "remote-template", Namespace: app.Namespace}, Spec: buildTemplateSpec(app)}
			r := helmIdentityReconciler(t, app, tmpl)
			r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{Hash: "commit-two:chart-content", Revision: "commit-two"}}
			r.SourceResolveTTL = time.Hour
			originalRelease := applicationReleaseName(app, nil)
			require.NoError(t, r.reconcileTemplate(ctx, app))
			changed, err := r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.False(t, changed, "unchanged chart/config on upgrade must not redeploy")
			require.Equal(t, "commit-one", app.Status.SourceRevision, "unrelated commits keep the deployed pin")
			require.Equal(t, originalRelease, applicationReleaseName(app, nil))

			change(app)
			require.NoError(t, r.reconcileTemplate(ctx, app))
			changed, err = r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.True(t, changed, "same chart contents with changed render inputs must start a release")
			require.Contains(t, app.Status.SourceHash, remoteRenderHashPrefix)
			require.Equal(t, "commit-two", app.Status.SourceRevision)
			require.NotEqual(t, originalRelease, applicationReleaseName(app, nil))
			changed, err = r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.False(t, changed, "cached source polling must remain stable")

			// Returning to the legacy configuration must not alternate between
			// the legacy identity and the new content/config identity on polls.
			app.Spec = remoteIdentityApp().Spec
			require.NoError(t, r.reconcileTemplate(ctx, app))
			changed, err = r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.True(t, changed)
			changed, err = r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.False(t, changed)
		})
	}
}

func TestRemoteMigrationReadsPersistedBaselineWithStaleInformer(t *testing.T) {
	ctx := context.Background()
	app := remoteIdentityApp()
	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "remote-template", Namespace: app.Namespace}, Spec: buildTemplateSpec(app)}
	r := helmIdentityReconciler(t, app, tmpl)
	r.sourceMetadataReader = r.client
	r.client = &staleHelmTemplateClient{Client: r.client, template: tmpl.DeepCopy()}
	require.NoError(t, r.preserveLegacyRemoteRenderConfig(ctx, app, tmpl))
	var cached paprikav1.Template
	require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(tmpl), &cached))
	require.Empty(t, cached.Annotations[legacyRemoteRenderAnnotation])
	changed := tmpl.DeepCopy()
	changed.Spec.ValuesFile = "placement: replacement\n"
	hash, err := r.remoteRenderSourceHash(ctx, app, changed, "commit-one:chart-content")
	require.NoError(t, err)
	require.Contains(t, hash, remoteRenderHashPrefix, "live metadata baseline must detect the change even when the informer has not observed it")
	// A second migration attempt cannot overwrite the original baseline.
	require.NoError(t, r.preserveLegacyRemoteRenderConfig(ctx, app, changed))
	var stored paprikav1.Template
	require.NoError(t, r.sourceMetadataReader.Get(ctx, client.ObjectKeyFromObject(tmpl), &stored))
	original, err := remoteRenderConfigHash(&tmpl.Spec)
	require.NoError(t, err)
	require.Equal(t, original, stored.Annotations[legacyRemoteRenderAnnotation])
}

func TestRemoteRenderIdentitySeparatesSourceContentAndConfiguration(t *testing.T) {
	ctx := context.Background()
	app := remoteIdentityApp()
	app.Status.SourceHash = remoteRenderHashPrefix + "existing"
	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "remote-template", Namespace: app.Namespace}, Spec: buildTemplateSpec(app)}
	r := helmIdentityReconciler(t, app, tmpl)
	first, err := r.remoteRenderSourceHash(ctx, app, tmpl, "commit-one:chart-content")
	require.NoError(t, err)
	tmpl.Spec.Git.Revision = "commit-two"
	second, err := r.remoteRenderSourceHash(ctx, app, tmpl, "commit-two:chart-content")
	require.NoError(t, err)
	require.Equal(t, sourceContentHash(first), sourceContentHash(second), "commit-only changes must not churn releases")
	contentChange, err := r.remoteRenderSourceHash(ctx, app, tmpl, "commit-three:new-chart-content")
	require.NoError(t, err)
	require.NotEqual(t, sourceContentHash(first), sourceContentHash(contentChange))
	tmpl.Spec.ValuesFile = "placement: replacement\n"
	configChange, err := r.remoteRenderSourceHash(ctx, app, tmpl, "commit-two:chart-content")
	require.NoError(t, err)
	require.NotEqual(t, sourceContentHash(first), sourceContentHash(configChange))
}

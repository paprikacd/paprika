package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func requireHelmConfigHash(t *testing.T, spec *paprikav1.TemplateSpec) string {
	t.Helper()
	hash, err := helmConfigHash(spec)
	require.NoError(t, err)
	return hash
}

func legacyHelmTestApp() *paprikav1.Application {
	app := &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "example", Namespace: "management", UID: "example-uid"},
		Spec: paprikav1.ApplicationSpec{Source: paprikav1.ApplicationSource{
			Type:            paprikav1.SourceTypeHelm,
			Chart:           paprikav1.ChartRef{Repo: "oci://registry.example/charts", Name: "example", Version: "1.0.0"},
			TargetNamespace: "workloads", ValuesFile: "replicas: 1\n",
		}},
	}
	sum := sha256.Sum256([]byte(app.Spec.Source.Chart.Path + app.Spec.Source.Chart.Repo + app.Spec.Source.Chart.Name))
	app.Status.SourceHash = hex.EncodeToString(sum[:])
	return app
}

func helmIdentityReconciler(t *testing.T, app *paprikav1.Application, objs ...client.Object) *ApplicationReconciler {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	objs = append(objs, app)
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).WithStatusSubresource(&paprikav1.Application{}).Build()
	return &ApplicationReconciler{client: c, Scheme: scheme}
}

func TestHelmConfigChangesCreateNewReleaseIdentityWithoutUpgradeChurn(t *testing.T) {
	t.Parallel()
	cases := map[string]func(*paprikav1.Application){
		"inline values":    func(a *paprikav1.Application) { a.Spec.Source.ValuesFile = "replicas: 2\n" },
		"target namespace": func(a *paprikav1.Application) { a.Spec.Source.TargetNamespace = "another" },
		"chart version":    func(a *paprikav1.Application) { a.Spec.Source.Chart.Version = "1.1.0" },
		"chart repository": func(a *paprikav1.Application) { a.Spec.Source.Chart.Repo = "oci://other.example/charts" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			app := legacyHelmTestApp()
			tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "example-template", Namespace: app.Namespace}, Spec: buildTemplateSpec(app)}
			r := helmIdentityReconciler(t, app, tmpl)
			originalHash, originalRelease := app.Status.SourceHash, applicationReleaseName(app, nil)
			require.NoError(t, r.reconcileTemplate(ctx, app))
			changed, err := r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.False(t, changed, "controller upgrade must not redeploy unchanged Helm applications")
			require.Equal(t, originalHash, app.Status.SourceHash)
			require.Equal(t, originalRelease, applicationReleaseName(app, nil))

			change(app)
			require.NoError(t, r.client.Update(ctx, app))
			require.NoError(t, r.reconcileTemplate(ctx, app))
			// A fresh reconciler simulates a controller restart after Template
			// convergence but before checking the Application source identity.
			r = &ApplicationReconciler{client: r.client, Scheme: r.Scheme}
			changed, err = r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.True(t, changed)
			require.NotEqual(t, originalRelease, applicationReleaseName(app, nil))
			require.Contains(t, app.Status.SourceHash, helmConfigHashPrefix)
			replacement := applicationReleaseName(app, nil)
			require.NoError(t, r.reconcileTemplate(ctx, app))
			changed, err = r.checkSourceChanged(ctx, app, false)
			require.NoError(t, err)
			require.False(t, changed, "polls must not create duplicate releases")
			require.Equal(t, replacement, applicationReleaseName(app, nil))

			var converged paprikav1.Template
			require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(tmpl), &converged))
			require.Equal(t, buildTemplateSpec(app), converged.Spec)
			require.Equal(t, requireHelmConfigHash(t, &tmpl.Spec), converged.Annotations[legacyHelmConfigAnnotation])
		})
	}
}

func TestHelmConfigRevertRemainsStableAfterLegacyMigration(t *testing.T) {
	ctx := context.Background()
	app := legacyHelmTestApp()
	originalSpec := app.Spec.DeepCopy()
	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "example-template", Namespace: app.Namespace}, Spec: buildTemplateSpec(app)}
	r := helmIdentityReconciler(t, app, tmpl)
	require.NoError(t, r.reconcileTemplate(ctx, app))
	app.Spec.Source.ValuesFile = "replicas: 2\n"
	require.NoError(t, r.client.Update(ctx, app))
	require.NoError(t, r.reconcileTemplate(ctx, app))
	changed, err := r.checkSourceChanged(ctx, app, false)
	require.NoError(t, err)
	require.True(t, changed)
	require.NoError(t, r.client.Get(ctx, client.ObjectKeyFromObject(app), app))
	app.Spec = *originalSpec
	require.NoError(t, r.client.Update(ctx, app))
	require.NoError(t, r.reconcileTemplate(ctx, app))
	changed, err = r.checkSourceChanged(ctx, app, false)
	require.NoError(t, err)
	require.True(t, changed)
	require.Equal(t, helmConfigHashPrefix+requireHelmConfigHash(t, &tmpl.Spec), app.Status.SourceHash)
	changed, err = r.checkSourceChanged(ctx, app, false)
	require.NoError(t, err)
	require.False(t, changed)
}

func TestHelmConfigMissingLegacyTemplateDoesNotRedeploy(t *testing.T) {
	ctx := context.Background()
	app := legacyHelmTestApp()
	r := helmIdentityReconciler(t, app)
	require.NoError(t, r.reconcileTemplate(ctx, app))
	changed, err := r.checkSourceChanged(ctx, app, false)
	require.NoError(t, err)
	require.False(t, changed)
}

func TestNewHelmApplicationHashesValuesImmediately(t *testing.T) {
	ctx := context.Background()
	app := legacyHelmTestApp()
	app.Status.SourceHash = ""
	r := helmIdentityReconciler(t, app)
	require.NoError(t, r.reconcileTemplate(ctx, app))
	changed, err := r.checkSourceChanged(ctx, app, false)
	require.NoError(t, err)
	require.False(t, changed, "initial source resolution is not a replacement")
	spec := buildTemplateSpec(app)
	require.Equal(t, helmConfigHashPrefix+requireHelmConfigHash(t, &spec), app.Status.SourceHash)
}

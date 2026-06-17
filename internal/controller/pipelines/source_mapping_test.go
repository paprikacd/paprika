package controller

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func newTestClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	s := runtime.NewScheme()
	require.NoError(t, scheme.AddToScheme(s))
	require.NoError(t, corev1.AddToScheme(s))
	require.NoError(t, paprikav1.AddToScheme(s))
	require.NoError(t, corev1alpha1.AddToScheme(s))
	return fake.NewClientBuilder().WithScheme(s).WithObjects(objs...).Build()
}

func newApplicationReconciler(t *testing.T, objs ...client.Object) *ApplicationReconciler {
	t.Helper()
	return &ApplicationReconciler{
		Client: newTestClient(t, objs...),
	}
}

func TestBuildTemplateSpec(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("OCI source maps all fields", func(t *testing.T) {
		t.Parallel()
		app := &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "oci-app", Namespace: "default"},
			Spec: paprikav1.ApplicationSpec{
				Source: paprikav1.ApplicationSource{
					Type: paprikav1.SourceTypeOCI,
					OCI: &paprikav1.OCISourceSpec{
						URL:       "oci://registry.example.com/charts/mychart",
						Tag:       "1.2.3",
						Insecure:  true,
						SecretRef: "oci-secret",
					},
					PollInterval: "30s",
				},
			},
		}
		r := newApplicationReconciler(t)
		spec := r.buildTemplateSpec(ctx, app)

		assert.Equal(t, paprikav1.SourceTypeOCI, spec.Type)
		require.NotNil(t, spec.OCI)
		assert.Equal(t, "oci://registry.example.com/charts/mychart", spec.OCI.URL)
		assert.Equal(t, "1.2.3", spec.OCI.Tag)
		assert.True(t, spec.OCI.Insecure)
		assert.Equal(t, "oci-secret", spec.OCI.SecretRef)
		assert.Equal(t, "default", spec.Namespace)
	})

	t.Run("legacy Image field maps to OCI.URL", func(t *testing.T) {
		t.Parallel()
		app := &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "legacy-oci-app", Namespace: "default"},
			Spec: paprikav1.ApplicationSpec{
				Source: paprikav1.ApplicationSource{
					Type:  paprikav1.SourceTypeOCI,
					Image: "oci://registry.example.com/charts/legacy",
				},
			},
		}
		r := newApplicationReconciler(t)
		spec := r.buildTemplateSpec(ctx, app)

		assert.Equal(t, paprikav1.SourceTypeOCI, spec.Type)
		require.NotNil(t, spec.OCI)
		assert.Equal(t, "oci://registry.example.com/charts/legacy", spec.OCI.URL)
	})

	t.Run("Source.SecretRef is used when OCI.SecretRef is empty", func(t *testing.T) {
		t.Parallel()
		app := &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "oci-shared-secret", Namespace: "default"},
			Spec: paprikav1.ApplicationSpec{
				Source: paprikav1.ApplicationSource{
					Type:      paprikav1.SourceTypeOCI,
					SecretRef: "shared-secret",
					OCI: &paprikav1.OCISourceSpec{
						URL: "oci://registry.example.com/charts/mychart",
						Tag: "1.0.0",
					},
				},
			},
		}
		r := newApplicationReconciler(t)
		spec := r.buildTemplateSpec(ctx, app)

		require.NotNil(t, spec.OCI)
		assert.Equal(t, "shared-secret", spec.OCI.SecretRef)
	})

	t.Run("Source.Insecure propagates to OCI.Insecure", func(t *testing.T) {
		t.Parallel()
		app := &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "oci-insecure", Namespace: "default"},
			Spec: paprikav1.ApplicationSpec{
				Source: paprikav1.ApplicationSource{
					Type:     paprikav1.SourceTypeOCI,
					Insecure: true,
					OCI: &paprikav1.OCISourceSpec{
						URL: "oci://registry.example.com/charts/mychart",
					},
				},
			},
		}
		r := newApplicationReconciler(t)
		spec := r.buildTemplateSpec(ctx, app)

		require.NotNil(t, spec.OCI)
		assert.True(t, spec.OCI.Insecure)
	})

	t.Run("Git source is unchanged", func(t *testing.T) {
		t.Parallel()
		app := &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "git-app", Namespace: "default"},
			Spec: paprikav1.ApplicationSpec{
				Source: paprikav1.ApplicationSource{
					Type:      paprikav1.SourceTypeGit,
					RepoURL:   "https://github.com/org/repo",
					Revision:  "main",
					Path:      "charts/app",
					SecretRef: "git-secret",
				},
			},
		}
		r := newApplicationReconciler(t)
		spec := r.buildTemplateSpec(ctx, app)

		assert.Equal(t, paprikav1.SourceTypeGit, spec.Type)
		require.NotNil(t, spec.Git)
		assert.Equal(t, "https://github.com/org/repo", spec.Git.RepoURL)
		assert.Nil(t, spec.OCI)
	})

	t.Run("RepoRef resolves repository URL for OCI", func(t *testing.T) {
		t.Parallel()
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "oci-repo", Namespace: "default"},
			Spec: corev1alpha1.RepositorySpec{
				Type: corev1alpha1.RepositoryTypeOCI,
				URL:  "oci://registry.example.com/charts",
			},
		}
		app := &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "oci-reporef-app", Namespace: "default"},
			Spec: paprikav1.ApplicationSpec{
				Source: paprikav1.ApplicationSource{
					Type:    paprikav1.SourceTypeOCI,
					RepoRef: "oci-repo",
					OCI: &paprikav1.OCISourceSpec{
						Tag: "1.0.0",
					},
				},
			},
		}
		r := newApplicationReconciler(t, repo)
		spec := r.buildTemplateSpec(ctx, app)

		require.NotNil(t, spec.OCI)
		assert.Equal(t, "oci://registry.example.com/charts", spec.OCI.URL)
		assert.Equal(t, "1.0.0", spec.OCI.Tag)
	})
}

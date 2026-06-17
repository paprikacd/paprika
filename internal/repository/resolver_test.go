package repository

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func newFakeClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, paprikav1.AddToScheme(scheme))
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

func TestResolveTemplate_NoRepoRef(t *testing.T) {
	c := newFakeClient(t)
	r := NewResolver(c)

	spec := paprikav1.TemplateSpec{Type: paprikav1.SourceTypeHelm, Chart: paprikav1.ChartRef{Name: "app"}}
	resolved, err := r.ResolveTemplate(context.Background(), "default", &spec)
	require.NoError(t, err)
	assert.Nil(t, resolved)
}

func TestResolveTemplate_Git(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "git-creds", Namespace: "default"},
		Data:       map[string][]byte{"username": []byte("user"), "password": []byte("pass")},
	}
	repo := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: "my-repo", Namespace: "default"},
		Spec: corev1alpha1.RepositorySpec{
			Type:      corev1alpha1.RepositoryTypeGit,
			URL:       "https://github.com/org/repo",
			SecretRef: &corev1alpha1.SecretRef{Name: "git-creds"},
		},
	}
	c := newFakeClient(t, secret, repo)
	r := NewResolver(c)

	spec := paprikav1.TemplateSpec{
		Type:    paprikav1.SourceTypeGit,
		RepoRef: "my-repo",
		Git:     &paprikav1.GitSourceSpec{Revision: "main", Path: "chart"},
	}
	resolved, err := r.ResolveTemplate(context.Background(), "default", &spec)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, "https://github.com/org/repo", resolved.Spec.Git.RepoURL)
	assert.Equal(t, "git-creds", resolved.Spec.Git.SecretRef)
	assert.Equal(t, "user", resolved.Username)
	assert.Equal(t, "pass", resolved.Password)
}

func TestResolveTemplate_Helm(t *testing.T) {
	repo := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: "helm-repo", Namespace: "default"},
		Spec: corev1alpha1.RepositorySpec{
			Type: corev1alpha1.RepositoryTypeHelm,
			URL:  "https://charts.example.com",
		},
	}
	c := newFakeClient(t, repo)
	r := NewResolver(c)

	spec := paprikav1.TemplateSpec{
		Type:    paprikav1.SourceTypeHelm,
		RepoRef: "helm-repo",
		Chart:   paprikav1.ChartRef{Name: "app", Version: "1.0.0"},
	}
	resolved, err := r.ResolveTemplate(context.Background(), "default", &spec)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, "https://charts.example.com", resolved.Spec.Chart.Repo)
	assert.Equal(t, "app", resolved.Spec.Chart.Name)
}

func TestResolveTemplate_OCI(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "oci-creds", Namespace: "default"},
		Data:       map[string][]byte{"username": []byte("u"), "password": []byte("p")},
	}
	repo := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: "oci-repo", Namespace: "default"},
		Spec: corev1alpha1.RepositorySpec{
			Type:      corev1alpha1.RepositoryTypeOCI,
			URL:       "oci://registry.example.com/charts",
			Insecure:  true,
			SecretRef: &corev1alpha1.SecretRef{Name: "oci-creds"},
		},
	}
	c := newFakeClient(t, secret, repo)
	r := NewResolver(c)

	spec := paprikav1.TemplateSpec{
		Type:    paprikav1.SourceTypeOCI,
		RepoRef: "oci-repo",
		OCI:     &paprikav1.OCISourceSpec{Tag: "1.0.0"},
	}
	resolved, err := r.ResolveTemplate(context.Background(), "default", &spec)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.True(t, resolved.Spec.OCI.Insecure)
	assert.Equal(t, "u", resolved.Username)
	assert.Equal(t, "p", resolved.Password)
}

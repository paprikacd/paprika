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
	t.Parallel()
	c := newFakeClient(t)
	r := NewResolver(c)

	spec := paprikav1.TemplateSpec{Type: paprikav1.SourceTypeHelm, Chart: paprikav1.ChartRef{Name: "app"}}
	resolved, err := r.ResolveTemplate(context.Background(), "default", &spec)
	require.NoError(t, err)
	assert.Nil(t, resolved)
}

func TestResolveTemplate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		objs    []client.Object
		repoRef string
		spec    paprikav1.TemplateSpec
		want    func(t *testing.T, got *Resolved)
	}{
		{
			name: "Git",
			objs: []client.Object{
				&corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{Name: "git-creds", Namespace: "default"},
					Data:       map[string][]byte{"username": []byte("user"), "password": []byte("pass")},
				},
				&corev1alpha1.Repository{
					ObjectMeta: metav1.ObjectMeta{Name: "my-repo", Namespace: "default"},
					Spec: corev1alpha1.RepositorySpec{
						Type:      corev1alpha1.RepositoryTypeGit,
						URL:       "https://github.com/org/repo",
						SecretRef: &corev1alpha1.SecretRef{Name: "git-creds"},
					},
				},
			},
			repoRef: "my-repo",
			spec: paprikav1.TemplateSpec{
				Type:    paprikav1.SourceTypeGit,
				RepoRef: "my-repo",
				Git:     &paprikav1.GitSourceSpec{Revision: "main", Path: "chart"},
			},
			want: func(t *testing.T, got *Resolved) {
				assert.Equal(t, "https://github.com/org/repo", got.Spec.Git.RepoURL)
				assert.Equal(t, "git-creds", got.Spec.Git.SecretRef)
				assert.Equal(t, "user", got.Username)
				assert.Equal(t, "pass", got.Password)
			},
		},
		{
			name: "GitHubApp",
			objs: []client.Object{
				&corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{Name: "gh-app", Namespace: "default"},
					Data:       map[string][]byte{"privateKey": []byte("-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ")},
				},
				&corev1alpha1.Repository{
					ObjectMeta: metav1.ObjectMeta{Name: "gh-app-repo", Namespace: "default"},
					Spec: corev1alpha1.RepositorySpec{
						Type:      corev1alpha1.RepositoryTypeGit,
						URL:       "https://github.com/org/repo",
						SecretRef: &corev1alpha1.SecretRef{Name: "gh-app"},
						GitHubApp: &corev1alpha1.GitHubAppCreds{
							AppID:          "12345",
							InstallationID: "67890",
							EnterpriseURL:  "https://github.example.com",
						},
					},
				},
			},
			repoRef: "gh-app-repo",
			spec: paprikav1.TemplateSpec{
				Type:    paprikav1.SourceTypeGit,
				RepoRef: "gh-app-repo",
				Git:     &paprikav1.GitSourceSpec{Revision: "main"},
			},
			want: func(t *testing.T, got *Resolved) {
				assert.Equal(t, "https://github.com/org/repo", got.Spec.Git.RepoURL)
				require.NotNil(t, got.GitHubApp)
				assert.Equal(t, int64(12345), got.GitHubApp.AppID)
				assert.Equal(t, int64(67890), got.GitHubApp.InstallationID)
				assert.Equal(t, "https://github.example.com", got.GitHubApp.EnterpriseURL)
				assert.Equal(t, "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ", string(got.GitHubApp.PrivateKey))
			},
		},
		{
			name: "Helm",
			objs: []client.Object{
				&corev1alpha1.Repository{
					ObjectMeta: metav1.ObjectMeta{Name: "helm-repo", Namespace: "default"},
					Spec: corev1alpha1.RepositorySpec{
						Type: corev1alpha1.RepositoryTypeHelm,
						URL:  "https://charts.example.com",
					},
				},
			},
			repoRef: "helm-repo",
			spec: paprikav1.TemplateSpec{
				Type:    paprikav1.SourceTypeHelm,
				RepoRef: "helm-repo",
				Chart:   paprikav1.ChartRef{Name: "app", Version: "1.0.0"},
			},
			want: func(t *testing.T, got *Resolved) {
				assert.Equal(t, "https://charts.example.com", got.Spec.Chart.Repo)
				assert.Equal(t, "app", got.Spec.Chart.Name)
			},
		},
		{
			name: "OCI",
			objs: []client.Object{
				&corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{Name: "oci-creds", Namespace: "default"},
					Data:       map[string][]byte{"username": []byte("u"), "password": []byte("p")},
				},
				&corev1alpha1.Repository{
					ObjectMeta: metav1.ObjectMeta{Name: "oci-repo", Namespace: "default"},
					Spec: corev1alpha1.RepositorySpec{
						Type:      corev1alpha1.RepositoryTypeOCI,
						URL:       "oci://registry.example.com/charts",
						Insecure:  true,
						SecretRef: &corev1alpha1.SecretRef{Name: "oci-creds"},
					},
				},
			},
			repoRef: "oci-repo",
			spec: paprikav1.TemplateSpec{
				Type:    paprikav1.SourceTypeOCI,
				RepoRef: "oci-repo",
				OCI:     &paprikav1.OCISourceSpec{Tag: "1.0.0"},
			},
			want: func(t *testing.T, got *Resolved) {
				assert.True(t, got.Spec.OCI.Insecure)
				assert.Equal(t, "u", got.Username)
				assert.Equal(t, "p", got.Password)
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c := newFakeClient(t, tc.objs...)
			r := NewResolver(c)

			resolved, err := r.ResolveTemplate(context.Background(), "default", &tc.spec)
			require.NoError(t, err)
			require.NotNil(t, resolved)
			tc.want(t, resolved)
		})
	}
}

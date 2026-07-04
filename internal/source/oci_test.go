package source

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestIsOCIURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		url  string
		want bool
	}{
		{"oci://registry.example.com/charts/mychart", true},
		{"oci://ghcr.io/org/chart:1.2.3", true},
		{"https://charts.example.com", false},
		{"http://charts.example.com", false},
		{"git@github.com:org/repo.git", false},
		{"", false},
	}
	for _, tc := range tests {
		t.Run(tc.url, func(t *testing.T) {
			assert.Equal(t, tc.want, IsOCIURL(tc.url))
		})
	}
}

func newFakeClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	s := runtime.NewScheme()
	require.NoError(t, scheme.AddToScheme(s))
	require.NoError(t, corev1.AddToScheme(s))
	return fake.NewClientBuilder().WithScheme(s).WithObjects(objs...).Build()
}

func TestOCISource_clientOptions(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("anonymous pull returns cache option only", func(t *testing.T) {
		t.Parallel()
		o := &OCISource{
			URL:       "oci://registry.example.com/charts/mychart",
			WorkDir:   t.TempDir(),
			Namespace: "default",
			Client:    newFakeClient(t),
		}
		opts, err := o.clientOptions(ctx)
		require.NoError(t, err)
		assert.Len(t, opts, 1)
	})

	t.Run("insecure enables plain HTTP", func(t *testing.T) {
		t.Parallel()
		o := &OCISource{
			URL:       "oci://registry.example.com/charts/mychart",
			Insecure:  true,
			WorkDir:   t.TempDir(),
			Namespace: "default",
			Client:    newFakeClient(t),
		}
		opts, err := o.clientOptions(ctx)
		require.NoError(t, err)
		assert.Len(t, opts, 2)
	})

	t.Run("dockerconfigjson secret writes config file", func(t *testing.T) {
		t.Parallel()
		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "registry-creds", Namespace: "default"},
			Type:       corev1.SecretTypeDockerConfigJson,
			Data:       map[string][]byte{".dockerconfigjson": []byte(`{"auths":{}}`)},
		}
		workDir := t.TempDir()
		o := &OCISource{
			URL:       "oci://registry.example.com/charts/mychart",
			SecretRef: "registry-creds",
			WorkDir:   workDir,
			Namespace: "default",
			Client:    newFakeClient(t, secret),
		}
		opts, err := o.clientOptions(ctx)
		require.NoError(t, err)
		assert.Len(t, opts, 2)

		cfgPath := filepath.Join(workDir, "oci-docker-config", SanitizeName(o.URL), "config.json")
		//nolint:gosec // test reads a file it just wrote
		data, err := os.ReadFile(cfgPath)
		require.NoError(t, err)
		assert.JSONEq(t, `{"auths":{}}`, string(data))
	})

	t.Run("username/password secret uses basic auth", func(t *testing.T) {
		t.Parallel()
		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "registry-creds", Namespace: "default"},
			Type:       corev1.SecretTypeOpaque,
			Data:       map[string][]byte{"username": []byte("user"), "password": []byte("pass")},
		}
		o := &OCISource{
			URL:       "oci://registry.example.com/charts/mychart",
			SecretRef: "registry-creds",
			WorkDir:   t.TempDir(),
			Namespace: "default",
			Client:    newFakeClient(t, secret),
		}
		opts, err := o.clientOptions(ctx)
		require.NoError(t, err)
		assert.Len(t, opts, 2)
	})

	t.Run("missing secret returns error", func(t *testing.T) {
		t.Parallel()
		o := &OCISource{
			URL:       "oci://registry.example.com/charts/mychart",
			SecretRef: "missing",
			WorkDir:   t.TempDir(),
			Namespace: "default",
			Client:    newFakeClient(t),
		}
		_, err := o.clientOptions(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "get OCI secret")
	})

	t.Run("nil client skips authentication", func(t *testing.T) {
		t.Parallel()
		o := &OCISource{
			URL:       "oci://registry.example.com/charts/mychart",
			SecretRef: "registry-creds",
			WorkDir:   t.TempDir(),
			Namespace: "default",
			Client:    nil,
		}
		opts, err := o.clientOptions(ctx)
		require.NoError(t, err)
		assert.Len(t, opts, 1)
	})
}

package reposerverclient

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/reposerver"
)

func TestNewFromEnv(t *testing.T) {
	t.Setenv("PAPRIKA_REPO_SERVER_ADDR", "http://repo-server:8082")
	c := NewFromEnv(context.Background())
	require.NotNil(t, c)
	assert.True(t, c.Enabled())
}

func TestNewFromEnv_Missing(t *testing.T) {
	t.Setenv("PAPRIKA_REPO_SERVER_ADDR", "")
	c := NewFromEnv(context.Background())
	assert.Nil(t, c)
	assert.False(t, c.Enabled())
}

func TestClient_ResolveSource(t *testing.T) {
	srv := reposerver.NewServer(t.TempDir(), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	c := New(ts.URL)
	_, err := c.ResolveSource(context.Background(), &paprika.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: paprika.TemplateSpec{
			Type: "helm",
			Chart: paprika.ChartRef{
				Repo:    "https://charts.example.com",
				Name:    "missing",
				Version: "1.0.0",
			},
		},
	})
	// Helm pull will fail because the repo does not exist; we just verify the RPC round-trip.
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repo server ResolveSource")
}

package reposerverclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestNewFromEnv(t *testing.T) {
	t.Setenv("PAPRIKA_REPO_SERVER_ADDR", "http://repo-server:8082")
	c := NewFromEnv(context.Background())
	require.NotNil(t, c)
	assert.True(t, c.Enabled())
	assert.Equal(t, DefaultTimeout, c.timeout)
	assert.Equal(t, DefaultTimeout, c.httpClient.Timeout)
}

func TestNewFromEnv_Missing(t *testing.T) {
	t.Setenv("PAPRIKA_REPO_SERVER_ADDR", "")
	c := NewFromEnv(context.Background())
	assert.Nil(t, c)
	assert.False(t, c.Enabled())
}

func TestNewFromEnv_Timeout(t *testing.T) {
	t.Setenv("PAPRIKA_REPO_SERVER_ADDR", "http://repo-server:8082")
	t.Setenv(timeoutEnv, "3m")

	c := NewFromEnv(context.Background())
	require.NotNil(t, c)
	assert.Equal(t, 3*time.Minute, c.timeout)
	assert.Equal(t, 3*time.Minute, c.httpClient.Timeout)
}

func TestNewWithTimeout_DefaultsInvalidTimeout(t *testing.T) {
	c := NewWithTimeout("http://repo-server:8082", 0)

	require.NotNil(t, c)
	assert.Equal(t, DefaultTimeout, c.timeout)
	assert.Equal(t, DefaultTimeout, c.httpClient.Timeout)
}

func TestClient_ResolveSource(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/paprika.v1.PaprikaService/ResolveSource", r.URL.Path)
		http.Error(w, "forced failure", http.StatusInternalServerError)
	}))
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
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repo server ResolveSource")
}

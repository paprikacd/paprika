package reposerver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/source"
)

type noopCache struct{}

func (noopCache) Get(_ context.Context, _ string) ([]byte, error)                  { return nil, nil }
func (noopCache) Set(_ context.Context, _ string, _ []byte, _ time.Duration) error { return nil }
func (noopCache) Delete(_ context.Context, _ string) error                         { return nil }
func (noopCache) Ping(_ context.Context) error                                     { return nil }
func (noopCache) Close() error                                                     { return nil }
func (noopCache) DeleteByPrefix(_ context.Context, _ string) error                 { return nil }

var (
	_ cache.Getter        = noopCache{}
	_ cache.Setter        = noopCache{}
	_ cache.Deleter       = noopCache{}
	_ cache.Pinger        = noopCache{}
	_ cache.Closer        = noopCache{}
	_ cache.PrefixDeleter = noopCache{}
)

func TestServerHealth(t *testing.T) {
	srv := NewServer(t.TempDir(), noopCache{})
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/healthz", http.NoBody)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	assert.Equal(t, http.StatusOK, rr.Code)
	assert.Equal(t, "ok", rr.Body.String())
}

func TestNewServer(t *testing.T) {
	dir := t.TempDir()
	srv := NewServer(dir, noopCache{})
	require.NotNil(t, srv)
	require.NotNil(t, srv.renderer)
	assert.Equal(t, dir, srv.workDir)
}

type captureRenderer struct {
	template *pipelinesv1alpha1.Template
}

func (r *captureRenderer) Render(_ context.Context, tmpl *pipelinesv1alpha1.Template, _ map[string]string) ([]byte, error) {
	r.template = tmpl.DeepCopy()
	return []byte("ok"), nil
}

func (r *captureRenderer) ResolveSource(_ context.Context, tmpl *pipelinesv1alpha1.Template) (*source.ResolveResult, error) {
	r.template = tmpl.DeepCopy()
	return &source.ResolveResult{LocalPath: "/tmp/chart", Hash: "hash", Revision: "revision"}, nil
}

func TestResolveSourcePreservesRequestIdentity(t *testing.T) {
	renderer := &captureRenderer{}
	srv := NewServer(t.TempDir(), noopCache{})
	srv.renderer = renderer

	_, err := srv.ResolveSource(context.Background(), connect.NewRequest(&paprikav1.ResolveSourceRequest{
		Namespace: "paprika-e2e",
		Name:      "brandbrain-api-template",
		Type:      "git",
		SpecJson:  []byte(`{"type":"git","git":{"repoUrl":"https://github.com/skunkworq/brandbrain.git","revision":"main","path":"deploy/kubernetes/chart","secretRef":"skunkworq-git-read-token"}}`),
	}))
	require.NoError(t, err)
	require.NotNil(t, renderer.template)
	assert.Equal(t, "paprika-e2e", renderer.template.Namespace)
	assert.Equal(t, "brandbrain-api-template", renderer.template.Name)
}

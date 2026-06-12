package reposerver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/cache"
)

type noopCache struct{}

func (noopCache) Get(_ context.Context, _ string) ([]byte, error)                  { return nil, nil }
func (noopCache) Set(_ context.Context, _ string, _ []byte, _ time.Duration) error { return nil }
func (noopCache) Delete(_ context.Context, _ string) error                         { return nil }
func (noopCache) Ping(_ context.Context) error                                     { return nil }
func (noopCache) Close() error                                                     { return nil }

var _ cache.Cache = noopCache{}

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

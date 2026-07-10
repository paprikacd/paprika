package engine

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

type stubRenderer struct {
	renderCalled        bool
	renderAllCalled     bool
	resolveSourceCalled bool
	renderResult        []byte
	resolveResult       *source.ResolveResult
	err                 error
}

func (s *stubRenderer) Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error) {
	s.renderCalled = true
	return s.renderResult, s.err
}

func (s *stubRenderer) RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error) {
	s.renderAllCalled = true
	return s.renderResult, s.err
}

func (s *stubRenderer) ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error) {
	s.resolveSourceCalled = true
	return s.resolveResult, s.err
}

func (s *stubRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	return s.renderResult, s.err
}

type stubRepoServerClient struct {
	enabled       bool
	renderCalls   []string
	resolveResult *source.ResolveResult
	err           error
}

func (s *stubRepoServerClient) Enabled() bool {
	return s.enabled
}

func (s *stubRepoServerClient) ResolveSource(context.Context, *paprikav1.Template) (*source.ResolveResult, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.resolveResult, nil
}

func (s *stubRepoServerClient) Render(_ context.Context, tmpl *paprikav1.Template, _ map[string]string) ([]byte, error) {
	s.renderCalls = append(s.renderCalls, tmpl.Name)
	if s.err != nil {
		return nil, s.err
	}
	return []byte(tmpl.Name + "\n"), nil
}

func TestRepoServerRenderer(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		renderResult  []byte
		resolveResult *source.ResolveResult
		method        string
		want          interface{}
	}{
		{
			name:         "falls back to local render",
			renderResult: []byte("manifests"),
			method:       "Render",
			want:         []byte("manifests"),
		},
		{
			name:          "falls back to local resolve source",
			resolveResult: &source.ResolveResult{Hash: "abc"},
			method:        "ResolveSource",
			want:          "abc",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			local := &stubRenderer{
				renderResult:  tc.renderResult,
				resolveResult: tc.resolveResult,
			}
			r := NewRepoServerRenderer(nil, local)
			tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "test"}}

			switch tc.method {
			case "Render":
				out, err := r.Render(context.Background(), tmpl, nil)
				require.NoError(t, err)
				assert.Equal(t, tc.want, out)
				assert.True(t, local.renderCalled)
			case "ResolveSource":
				res, err := r.ResolveSource(context.Background(), tmpl)
				require.NoError(t, err)
				assert.Equal(t, tc.want, res.Hash)
				assert.True(t, local.resolveSourceCalled)
			}
		})
	}
}

func TestRepoServerRenderer_RenderAllUsesRepoServer(t *testing.T) {
	t.Parallel()

	repoServer := &stubRepoServerClient{enabled: true}
	local := &stubRenderer{renderResult: []byte("local")}
	r := NewRepoServerRenderer(repoServer, local)

	templates := []paprikav1.Template{
		{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "default"}},
		{ObjectMeta: metav1.ObjectMeta{Name: "worker", Namespace: "default"}},
	}
	out, err := r.RenderAll(context.Background(), templates, nil)
	require.NoError(t, err)

	assert.Equal(t, []byte("api\nworker\n"), out)
	assert.Equal(t, []string{"api", "worker"}, repoServer.renderCalls)
	assert.False(t, local.renderCalled)
	assert.False(t, local.renderAllCalled)
}

func TestRepoServerRenderer_RenderAllFallsBackPerTemplate(t *testing.T) {
	t.Parallel()

	repoServer := &stubRepoServerClient{enabled: true, err: errors.New("repo server unavailable")}
	local := &stubRenderer{renderResult: []byte("local\n")}
	r := NewRepoServerRenderer(repoServer, local)

	templates := []paprikav1.Template{{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "default"}}}
	out, err := r.RenderAll(context.Background(), templates, nil)
	require.NoError(t, err)

	assert.Equal(t, []byte("local\n"), out)
	assert.Equal(t, []string{"api"}, repoServer.renderCalls)
	assert.True(t, local.renderCalled)
	assert.False(t, local.renderAllCalled)
}

package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/source"
)

type stubRenderer struct {
	renderCalled        bool
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
	return s.renderResult, s.err
}

func (s *stubRenderer) ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error) {
	s.resolveSourceCalled = true
	return s.resolveResult, s.err
}

func (s *stubRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	return s.renderResult, s.err
}

func TestRepoServerRenderer_FallsBackToLocal(t *testing.T) {
	local := &stubRenderer{renderResult: []byte("manifests")}
	r := NewRepoServerRenderer(nil, local)

	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "test"}}
	out, err := r.Render(context.Background(), tmpl, nil)
	require.NoError(t, err)
	assert.Equal(t, []byte("manifests"), out)
	assert.True(t, local.renderCalled)
}

func TestRepoServerRenderer_ResolveSourceFallback(t *testing.T) {
	local := &stubRenderer{resolveResult: &source.ResolveResult{Hash: "abc"}}
	r := NewRepoServerRenderer(nil, local)

	tmpl := &paprikav1.Template{ObjectMeta: metav1.ObjectMeta{Name: "test"}}
	res, err := r.ResolveSource(context.Background(), tmpl)
	require.NoError(t, err)
	assert.Equal(t, "abc", res.Hash)
	assert.True(t, local.resolveSourceCalled)
}

package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
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

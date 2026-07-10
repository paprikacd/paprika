package engine_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/source"
)

type fakeRenderer struct {
	calls   int
	renders map[string][]byte
}

func (f *fakeRenderer) Render(_ context.Context, _ *paprika.Template, params map[string]string) ([]byte, error) {
	f.calls++
	key := params["replicaCount"]
	out, ok := f.renders[key]
	if !ok {
		return nil, fmt.Errorf("unexpected render params: %v", params)
	}
	return out, nil
}

func (f *fakeRenderer) RenderAll(_ context.Context, _ []paprika.Template, _ map[string]string) ([]byte, error) {
	return nil, nil
}

func (f *fakeRenderer) ResolveSource(_ context.Context, _ *paprika.Template) (*source.ResolveResult, error) {
	return nil, nil
}

func (f *fakeRenderer) RenderHelmChart(_ context.Context, _, _, _ string, _ map[string]string) ([]byte, error) {
	return nil, nil
}

type revisionRenderer struct {
	calls int
}

func (r *revisionRenderer) Render(_ context.Context, tmpl *paprika.Template, _ map[string]string) ([]byte, error) {
	r.calls++
	return []byte(tmpl.Spec.Git.Revision), nil
}

func (r *revisionRenderer) RenderAll(_ context.Context, _ []paprika.Template, _ map[string]string) ([]byte, error) {
	return nil, nil
}

func (r *revisionRenderer) ResolveSource(_ context.Context, _ *paprika.Template) (*source.ResolveResult, error) {
	return nil, nil
}

func (r *revisionRenderer) RenderHelmChart(_ context.Context, _, _, _ string, _ map[string]string) ([]byte, error) {
	return nil, nil
}

func TestCachedTemplateRenderer(t *testing.T) {
	t.Parallel()

	type call struct {
		params map[string]string
		want   []byte
	}

	tests := []struct {
		name      string
		renders   map[string][]byte
		calls     []call
		wantCalls int
	}{
		{
			name:    "cache hit on repeated call",
			renders: map[string][]byte{"1": []byte("rendered manifests")},
			calls: []call{
				{params: map[string]string{"replicaCount": "1"}, want: []byte("rendered manifests")},
				{params: map[string]string{"replicaCount": "1"}, want: []byte("rendered manifests")},
			},
			wantCalls: 1,
		},
		{
			name: "cache miss on different params",
			renders: map[string][]byte{
				"1": []byte("manifests-1"),
				"2": []byte("manifests-2"),
			},
			calls: []call{
				{params: map[string]string{"replicaCount": "1"}, want: []byte("manifests-1")},
				{params: map[string]string{"replicaCount": "2"}, want: []byte("manifests-2")},
			},
			wantCalls: 2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			ctx := context.Background()
			inner := &fakeRenderer{renders: tc.renders}
			memCache := cache.NewMemoryCache()
			renderer := engine.NewCachedTemplateRenderer(inner, memCache, t.TempDir(), 0)

			tmpl := &paprika.Template{
				ObjectMeta: metav1.ObjectMeta{Name: "test"},
				Spec: paprika.TemplateSpec{
					Type: "helm",
					Chart: paprika.ChartRef{
						Repo:    "https://charts.example.com",
						Name:    "app",
						Version: "1.0.0",
					},
				},
				Status: paprika.TemplateStatus{SourceRevision: "rev1"},
			}

			for _, c := range tc.calls {
				got, err := renderer.Render(ctx, tmpl, c.params)
				require.NoError(t, err)
				require.Equal(t, c.want, got)
			}
			require.Equal(t, tc.wantCalls, inner.calls)
		})
	}
}

func TestCachedTemplateRendererUsesGitSpecRevisionWhenStatusIsAbsent(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	inner := &revisionRenderer{}
	memCache := cache.NewMemoryCache()
	renderer := engine.NewCachedTemplateRenderer(inner, memCache, t.TempDir(), 0)

	tmpl := &paprika.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "git-template"},
		Spec: paprika.TemplateSpec{
			Type: "git",
			Git: &paprika.GitSourceSpec{
				RepoURL:  "https://github.com/org/repo.git",
				Revision: "rev1",
				Path:     "charts/app",
			},
		},
	}

	got, err := renderer.Render(ctx, tmpl, map[string]string{"release-name": "app"})
	require.NoError(t, err)
	require.Equal(t, []byte("rev1"), got)

	tmpl.Spec.Git.Revision = "rev2"
	got, err = renderer.Render(ctx, tmpl, map[string]string{"release-name": "app"})
	require.NoError(t, err)
	require.Equal(t, []byte("rev2"), got)
	require.Equal(t, 2, inner.calls)
}

package engine_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	enginemocks "github.com/benebsworth/paprika/engine/mocks"
	"github.com/benebsworth/paprika/internal/cache"
)

func TestCachedTemplateRenderer_CacheHit(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	inner := enginemocks.NewMockTemplateRenderer(ctrl)
	memCache := cache.NewMemoryCache()
	renderer := engine.NewCachedTemplateRenderer(inner, memCache, "/tmp/test", 0)

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
	params := map[string]string{"replicaCount": "1"}

	expected := []byte("rendered manifests")
	inner.EXPECT().Render(gomock.Any(), tmpl, params).Return(expected, nil).Times(1)

	// First call should hit the inner renderer.
	result1, err := renderer.Render(ctx, tmpl, params)
	require.NoError(t, err)
	require.Equal(t, expected, result1)

	// Second call should hit the cache, no inner call.
	result2, err := renderer.Render(ctx, tmpl, params)
	require.NoError(t, err)
	require.Equal(t, expected, result2)
}

func TestCachedTemplateRenderer_CacheMissDifferentParams(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	inner := enginemocks.NewMockTemplateRenderer(ctrl)
	memCache := cache.NewMemoryCache()
	renderer := engine.NewCachedTemplateRenderer(inner, memCache, "/tmp/test", 0)

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

	inner.EXPECT().Render(gomock.Any(), tmpl, map[string]string{"replicaCount": "1"}).Return([]byte("manifests-1"), nil).Times(1)
	inner.EXPECT().Render(gomock.Any(), tmpl, map[string]string{"replicaCount": "2"}).Return([]byte("manifests-2"), nil).Times(1)

	r1, err := renderer.Render(ctx, tmpl, map[string]string{"replicaCount": "1"})
	require.NoError(t, err)
	require.Equal(t, []byte("manifests-1"), r1)

	r2, err := renderer.Render(ctx, tmpl, map[string]string{"replicaCount": "2"})
	require.NoError(t, err)
	require.Equal(t, []byte("manifests-2"), r2)
}

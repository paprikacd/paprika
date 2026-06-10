// Package engine provides template rendering and diff computation.
package engine

import (
	"context"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/source"
)

//go:generate mockgen -destination=mocks/template_renderer.go -package=mocks . TemplateRenderer
//go:generate mockgen -destination=mocks/diff_engine.go -package=mocks . DiffEngine
//go:generate mockgen -destination=mocks/source_resolver.go -package=mocks . SourceResolver

// TemplateRenderer renders templates to Kubernetes manifests.
type TemplateRenderer interface {
	Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error)
	RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error)
	ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error)
	RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error)
}

// DiffEngine computes differences between desired and actual cluster state.
type DiffEngine interface {
	ComputeDiff(ctx context.Context, desired []unstructured.Unstructured, namespace string) (*DiffResult, error)
}

// SourceResolver resolves source locations.
type SourceResolver interface {
	Resolve(ctx context.Context) (*source.ResolveResult, error)
}

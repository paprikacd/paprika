// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

//go:generate mockgen -destination=mocks/template_renderer.go -package=mocks -typed . TemplateRenderer

// Renderer renders a single template into Kubernetes manifests.
type Renderer interface {
	Render(ctx context.Context, tmpl *pipelinesv1alpha1.Template, params map[string]string) ([]byte, error)
}

// AllTemplatesRenderer renders a collection of templates into a single manifest bundle.
type AllTemplatesRenderer interface {
	RenderAll(ctx context.Context, templates []pipelinesv1alpha1.Template, params map[string]string) ([]byte, error)
}

// HelmChartRenderer renders a Helm chart by name, repository, and version.
type HelmChartRenderer interface {
	RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error)
}

// TemplateSourceResolver resolves the source location for a template.
type TemplateSourceResolver interface {
	ResolveSource(ctx context.Context, tmpl *pipelinesv1alpha1.Template) (*source.ResolveResult, error)
}

// SourceResolvingRenderer can render a single template and resolve its source.
type SourceResolvingRenderer interface {
	Renderer
	TemplateSourceResolver
}

// TemplateRenderer renders templates to Kubernetes manifests, resolves their
// sources, and can render Helm charts.
type TemplateRenderer interface {
	Renderer
	AllTemplatesRenderer
	HelmChartRenderer
	TemplateSourceResolver
}

package engine

import (
	"context"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

// templateRenderer is the internal renderer interface used by engine concrete types.
type templateRenderer interface {
	Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error)
	RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error)
	ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error)
	RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error)
}

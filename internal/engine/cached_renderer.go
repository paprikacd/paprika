package engine

import (
	"context"
	"fmt"
	"time"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/source"
)

// DefaultManifestTTL is the default cache TTL for rendered manifests.
const DefaultManifestTTL = 5 * time.Minute

// manifestCache is the smallest cache interface needed by the cached renderer.
type manifestCache interface {
	cache.Getter
	cache.Setter
}

// CachedTemplateRenderer wraps a renderer with manifest caching.
type CachedTemplateRenderer struct {
	inner   templateRenderer
	cache   manifestCache
	workDir string
	ttl     time.Duration
}

// NewCachedTemplateRenderer wraps the given renderer with a cache.
func NewCachedTemplateRenderer(inner templateRenderer, c manifestCache, workDir string, ttl time.Duration) *CachedTemplateRenderer {
	if ttl <= 0 {
		ttl = DefaultManifestTTL
	}
	return &CachedTemplateRenderer{
		inner:   inner,
		cache:   c,
		workDir: workDir,
		ttl:     ttl,
	}
}

// Render checks the cache before delegating to the inner renderer.
func (r *CachedTemplateRenderer) Render(ctx context.Context, tmpl *paprika.Template, params map[string]string) ([]byte, error) {
	key := cache.ManifestKey(tmpl.Spec.Type, manifestSourceURL(&tmpl.Spec), tmpl.Status.SourceRevision, params)

	cached, err := r.cache.Get(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("manifest cache get: %w", err)
	}
	if len(cached) > 0 {
		return cached, nil
	}

	rendered, err := r.inner.Render(ctx, tmpl, params)
	if err != nil {
		return nil, fmt.Errorf("render template: %w", err)
	}

	if err := r.cache.Set(ctx, key, rendered, r.ttl); err != nil {
		return nil, fmt.Errorf("manifest cache set: %w", err)
	}

	return rendered, nil
}

// RenderAll renders each template and concatenates the results, using the cache
// for individual template renders when possible.
func (r *CachedTemplateRenderer) RenderAll(ctx context.Context, templates []paprika.Template, params map[string]string) ([]byte, error) {
	var result []byte
	for i := range templates {
		rendered, err := r.Render(ctx, &templates[i], params)
		if err != nil {
			return nil, fmt.Errorf("render all templates: %w", err)
		}
		result = append(result, rendered...)
	}
	return result, nil
}

// ResolveSource delegates to the inner renderer.
func (r *CachedTemplateRenderer) ResolveSource(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	result, err := r.inner.ResolveSource(ctx, tmpl)
	if err != nil {
		return nil, fmt.Errorf("resolve source: %w", err)
	}
	return result, nil
}

// RenderHelmChart delegates to the inner renderer.
func (r *CachedTemplateRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	result, err := r.inner.RenderHelmChart(ctx, chartName, chartRepo, chartVersion, values)
	if err != nil {
		return nil, fmt.Errorf("render helm chart: %w", err)
	}
	return result, nil
}

// Ensure CachedTemplateRenderer satisfies the internal renderer interface.
var _ templateRenderer = (*CachedTemplateRenderer)(nil)

func manifestSourceURL(spec *paprika.TemplateSpec) string {
	switch spec.Type {
	case "helm":
		if spec.Chart.Path != "" {
			return spec.Chart.Path
		}
		return spec.Chart.Repo + "/" + spec.Chart.Name + "@" + spec.Chart.Version
	case "git":
		if spec.Git != nil {
			return spec.Git.RepoURL + "//" + spec.Git.Path
		}
	case "s3":
		if spec.S3 != nil {
			return "s3://" + spec.S3.Bucket + "/" + spec.S3.Key
		}
	case "kustomize":
		if spec.Kustomize != nil {
			if spec.Kustomize.InputFromPrevious {
				return "kustomize:input-from-previous"
			}
			return spec.Kustomize.Path
		}
	}
	return ""
}

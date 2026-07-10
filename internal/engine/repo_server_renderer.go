package engine

import (
	"context"
	"errors"
	"fmt"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// repoServerClient defines the subset of repo-server client methods used by RepoServerRenderer.
type repoServerClient interface {
	Enabled() bool
	ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error)
	Render(ctx context.Context, tmpl *paprikav1.Template, values map[string]string) ([]byte, error)
}

// RepoServerRenderer delegates source resolution and rendering to a repo server.
// It falls back to a local renderer when the repo server is unavailable.
type RepoServerRenderer struct {
	client repoServerClient
	local  templateRenderer
}

// NewRepoServerRenderer creates a renderer that prefers the repo server when configured.
func NewRepoServerRenderer(client repoServerClient, local templateRenderer) *RepoServerRenderer {
	return &RepoServerRenderer{client: client, local: local}
}

// Render delegates to the repo server if enabled, otherwise to the local renderer.
func (r *RepoServerRenderer) Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error) {
	if r.client != nil && r.client.Enabled() {
		manifests, err := r.client.Render(ctx, tmpl, params)
		if err == nil {
			return manifests, nil
		}
		log.FromContext(ctx).Error(err, "Repo server render failed; falling back to local renderer",
			"namespace", tmpl.Namespace, "name", tmpl.Name, "type", tmpl.Spec.Type)
	}
	if r.local != nil {
		manifests, err := r.local.Render(ctx, tmpl, params)
		if err != nil {
			return nil, fmt.Errorf("local render: %w", err)
		}
		return manifests, nil
	}
	return nil, errors.New("no renderer available")
}

// RenderAll delegates to the local renderer (repo server batch not yet supported).
func (r *RepoServerRenderer) RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error) {
	if r.local != nil {
		manifests, err := r.local.RenderAll(ctx, templates, params)
		if err != nil {
			return nil, fmt.Errorf("local render all: %w", err)
		}
		return manifests, nil
	}
	return nil, errors.New("no renderer available")
}

// ResolveSource delegates to the repo server if enabled, otherwise to the local renderer.
func (r *RepoServerRenderer) ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error) {
	if r.client != nil && r.client.Enabled() {
		result, err := r.client.ResolveSource(ctx, tmpl)
		if err == nil {
			return result, nil
		}
		log.FromContext(ctx).Error(err, "Repo server source resolve failed; falling back to local renderer",
			"namespace", tmpl.Namespace, "name", tmpl.Name, "type", tmpl.Spec.Type)
	}
	if r.local != nil {
		result, err := r.local.ResolveSource(ctx, tmpl)
		if err != nil {
			return nil, fmt.Errorf("local resolve source: %w", err)
		}
		return result, nil
	}
	return nil, errors.New("no renderer available")
}

// RenderHelmChart delegates to the local renderer.
func (r *RepoServerRenderer) RenderHelmChart(ctx context.Context, chartName, chartRepo, chartVersion string, values map[string]string) ([]byte, error) {
	if r.local != nil {
		manifests, err := r.local.RenderHelmChart(ctx, chartName, chartRepo, chartVersion, values)
		if err != nil {
			return nil, fmt.Errorf("local render helm chart: %w", err)
		}
		return manifests, nil
	}
	return nil, errors.New("no renderer available")
}

var _ templateRenderer = (*RepoServerRenderer)(nil)

package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/source"
)

// ErrRepoServerTimeout marks a repo-server call that ran out of time. The repo
// server keeps fetching after its client gives up (mirror fetches run detached,
// see source.mirrorFetchContext), so a caller seeing this should retry later
// rather than repeat the fetch somewhere else.
var ErrRepoServerTimeout = errors.New("repo server call timed out")

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
	// callTimeout bounds each repo-server call; 0 leaves only the client's own
	// timeout.
	callTimeout time.Duration
	// noFallbackOnTimeout returns a timed-out repo-server call as
	// ErrRepoServerTimeout instead of repeating it with the local renderer.
	noFallbackOnTimeout bool
}

// RepoServerRendererOption configures a RepoServerRenderer.
type RepoServerRendererOption func(*RepoServerRenderer)

// WithRepoServerCallTimeout bounds each repo-server call to d, under the
// client's own timeout. A caller that must not hold a worker for minutes (the
// Application controller's poll) sets it; the local fallback is not bounded by
// it.
func WithRepoServerCallTimeout(d time.Duration) RepoServerRendererOption {
	return func(r *RepoServerRenderer) { r.callTimeout = d }
}

// WithoutLocalFallbackOnTimeout stops a repo-server call that timed out from
// being repeated with the local renderer.
//
// A timeout means the repo server took the request and is still working on it:
// its mirror fetch runs detached and completes after the client gives up, and
// the next request waits for it on the repository lock. Repeating the work
// locally starts a second, independent clone in the caller's process. On
// omega-ha (2026-10-29) that turned one brandbrain-api reconcile into 42
// minutes: two 5-minute repo-server timeouts, then a 17-minute local resolve
// and a 15.5-minute local render, each downloading the repository's 10 GB tip
// tree again while the repo server downloaded it too. Controller-runtime never
// runs two reconciles of one Application at once, so the paprika.io/sync
// annotation set four minutes into that reconcile waited 35 minutes for it.
//
// The fallback still runs when the repo server could not be reached at all.
func WithoutLocalFallbackOnTimeout() RepoServerRendererOption {
	return func(r *RepoServerRenderer) { r.noFallbackOnTimeout = true }
}

// NewRepoServerRenderer creates a renderer that prefers the repo server when configured.
func NewRepoServerRenderer(client repoServerClient, local templateRenderer, opts ...RepoServerRendererOption) *RepoServerRenderer {
	r := &RepoServerRenderer{client: client, local: local}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

func (r *RepoServerRenderer) repoServerEnabled() bool {
	return r.client != nil && r.client.Enabled()
}

// callContext bounds one repo-server call by callTimeout, when set.
func (r *RepoServerRenderer) callContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if r.callTimeout <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, r.callTimeout)
}

// isRepoServerTimeout reports whether a repo-server call ended because its
// client or its context ran out of time, rather than with the server's answer.
func isRepoServerTimeout(err error) bool {
	return connect.CodeOf(err) == connect.CodeDeadlineExceeded || errors.Is(err, context.DeadlineExceeded)
}

// timeoutError returns a repo-server timeout wrapped as ErrRepoServerTimeout
// when this renderer does not fall back on timeouts, and nil otherwise.
func (r *RepoServerRenderer) timeoutError(op string, tmpl *paprikav1.Template, err error) error {
	if !r.noFallbackOnTimeout || !isRepoServerTimeout(err) {
		return nil
	}
	return fmt.Errorf("%w: %s %s/%s; the repo server is still working on it, retry later: %w",
		ErrRepoServerTimeout, op, tmpl.Namespace, tmpl.Name, err)
}

// Render delegates to the repo server if enabled, otherwise to the local renderer.
func (r *RepoServerRenderer) Render(ctx context.Context, tmpl *paprikav1.Template, params map[string]string) ([]byte, error) {
	if r.repoServerEnabled() {
		callCtx, cancel := r.callContext(ctx)
		manifests, err := r.client.Render(callCtx, tmpl, params)
		cancel()
		if err == nil {
			return manifests, nil
		}
		if timeoutErr := r.timeoutError("render", tmpl, err); timeoutErr != nil {
			return nil, timeoutErr
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

// RenderAll renders each template through Render so repo-server backed
// promotion paths get the same timeout/fallback behavior as single renders.
func (r *RepoServerRenderer) RenderAll(ctx context.Context, templates []paprikav1.Template, params map[string]string) ([]byte, error) {
	var out bytes.Buffer
	for i := range templates {
		manifests, err := r.Render(ctx, &templates[i], params)
		if err != nil {
			return nil, fmt.Errorf("render template %s/%s: %w", templates[i].Namespace, templates[i].Name, err)
		}
		out.Write(manifests)
	}
	return out.Bytes(), nil
}

// ResolveSource delegates to the repo server if enabled, otherwise to the local renderer.
func (r *RepoServerRenderer) ResolveSource(ctx context.Context, tmpl *paprikav1.Template) (*source.ResolveResult, error) {
	if r.repoServerEnabled() {
		callCtx, cancel := r.callContext(ctx)
		result, err := r.client.ResolveSource(callCtx, tmpl)
		cancel()
		if err == nil {
			return result, nil
		}
		if timeoutErr := r.timeoutError("resolve source", tmpl, err); timeoutErr != nil {
			return nil, timeoutErr
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

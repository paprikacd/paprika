// Package receiver handles Git push webhooks to trigger application reconciliation.
package receiver

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const (
	githubEventHeader = "X-GitHub-Event"
	githubSignature   = "X-Hub-Signature-256"
	gitlabEventHeader = "X-GitLab-Event"
	gitlabTokenHeader = "X-GitLab-Token" //nolint:gosec // This is an HTTP header name, not a credential.
	githubPushEvent   = "push"
	gitlabPushEvent   = "Push Hook"
	githubPingEvent   = "ping"
	gitlabPingEvent   = "System Hook"
)

// Handler processes incoming Git webhooks and triggers application reconciliation.
type Handler struct {
	client    client.Client
	secret    string
	cache     cacheInvalidator
	repoCache repoInvalidator
	clock     Clock
}

// Clock returns the current time. It is injected so tests can use a fixed clock.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// HandlerOption configures a Handler.
type HandlerOption func(*Handler)

// WithClock sets the clock used by the handler. The default is time.Now.
func WithClock(c Clock) HandlerOption {
	return func(h *Handler) {
		h.clock = c
	}
}

// cacheInvalidator invalidates cached manifests and source resolutions.
type cacheInvalidator interface {
	Invalidate(ctx context.Context, sourceType, sourceURL, revision string) error
}

// repoInvalidator forwards invalidation to a remote repo server.
type repoInvalidator interface {
	Invalidate(ctx context.Context, sourceType, sourceURL, revision string) error
}

// NewHandler creates a new webhook handler.
func NewHandler(c client.Client, secret string, opts ...HandlerOption) *Handler {
	return NewHandlerWithCache(c, secret, nil, opts...)
}

// NewHandlerWithCache creates a new webhook handler that can invalidate caches.
func NewHandlerWithCache(c client.Client, secret string, inv cacheInvalidator, opts ...HandlerOption) *Handler {
	return NewHandlerWithCacheAndRepo(c, secret, inv, nil, opts...)
}

// NewHandlerWithCacheAndRepo creates a handler that invalidates both local and repo-server caches.
func NewHandlerWithCacheAndRepo(c client.Client, secret string, inv cacheInvalidator, repo repoInvalidator, opts ...HandlerOption) *Handler {
	h := &Handler{client: c, secret: secret, cache: inv, repoCache: repo, clock: realClock{}}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

// ServeHTTP implements http.Handler for Git webhooks.
//
//nolint:cyclop // webhook event dispatch has several event types.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := log.FromContext(ctx)

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}

	eventType := r.Header.Get(githubEventHeader)
	if eventType == "" {
		eventType = r.Header.Get(gitlabEventHeader)
	}

	switch eventType {
	case githubPushEvent:
		if err := h.handleGitHubPush(ctx, r, body); err != nil {
			log.Error(err, "Handle GitHub push")
			http.Error(w, "failed to process webhook", http.StatusInternalServerError)
			return
		}
	case gitlabPushEvent:
		if err := h.handleGitLabPush(ctx, r, body); err != nil {
			log.Error(err, "Handle GitLab push")
			http.Error(w, "failed to process webhook", http.StatusInternalServerError)
			return
		}
	case githubPingEvent, gitlabPingEvent:
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("pong")); err != nil {
			log.Error(err, "Failed to write webhook pong")
		}
		return
	default:
		http.Error(w, "unsupported event", http.StatusBadRequest)
		return
	}

	w.WriteHeader(http.StatusAccepted)
	if _, err := w.Write([]byte(`{"status":"accepted"}`)); err != nil {
		log.Error(err, "Failed to write webhook accepted response")
	}
}

func (h *Handler) handleGitHubPush(ctx context.Context, r *http.Request, body []byte) error {
	if h.secret != "" {
		if err := verifyGitHubSignature(r.Header.Get(githubSignature), h.secret, body); err != nil {
			return fmt.Errorf("invalid signature: %w", err)
		}
	}

	var payload githubPushPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.Repository.CloneURL == "" {
		return errors.New("missing repository clone_url")
	}

	branch := path.Base(payload.Ref)
	return h.triggerReconciliation(ctx, payload.Repository.CloneURL, branch)
}

func (h *Handler) handleGitLabPush(ctx context.Context, r *http.Request, body []byte) error {
	if h.secret != "" {
		if r.Header.Get(gitlabTokenHeader) != h.secret {
			return errors.New("invalid token")
		}
	}

	var payload gitlabPushPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.Project.GitHTTPURL == "" {
		return errors.New("missing project git_http_url")
	}

	branch := path.Base(payload.Ref)
	return h.triggerReconciliation(ctx, payload.Project.GitHTTPURL, branch)
}

func (h *Handler) triggerReconciliation(ctx context.Context, repoURL, branch string) error {
	log := log.FromContext(ctx)

	if h.cache != nil {
		if err := h.cache.Invalidate(ctx, "git", repoURL, branch); err != nil {
			log.Error(err, "Failed to invalidate cache", "repo", repoURL, "branch", branch)
		}
	}
	if h.repoCache != nil {
		if err := h.repoCache.Invalidate(ctx, "git", repoURL, branch); err != nil {
			log.Error(err, "Failed to invalidate repo server cache", "repo", repoURL, "branch", branch)
		}
	}

	updated, err := h.annotateMatchingApplications(ctx, repoURL, branch)
	if err != nil {
		return fmt.Errorf("annotate matching applications: %w", err)
	}

	tmplUpdated, err := h.annotateMatchingTemplates(ctx, repoURL, branch)
	if err != nil {
		return fmt.Errorf("annotate matching templates: %w", err)
	}
	updated += tmplUpdated

	log.Info("Webhook triggered reconciliation", "repo", repoURL, "branch", branch, "updated", updated)
	return nil
}

func (h *Handler) annotateMatchingApplications(ctx context.Context, repoURL, branch string) (int, error) {
	log := log.FromContext(ctx)

	var apps paprika.ApplicationList
	if err := h.client.List(ctx, &apps); err != nil {
		return 0, fmt.Errorf("list applications: %w", err)
	}

	var updated int
	for i := range apps.Items {
		app := &apps.Items[i]
		if !matchesRepo(app, repoURL, branch) {
			continue
		}

		if app.Annotations == nil {
			app.Annotations = make(map[string]string)
		}
		app.Annotations["paprika.io/sync"] = h.nowString()

		if err := h.client.Update(ctx, app); err != nil {
			log.Error(err, "Failed to annotate application", "name", app.Name)
			continue
		}
		updated++
	}
	return updated, nil
}

func (h *Handler) annotateMatchingTemplates(ctx context.Context, repoURL, branch string) (int, error) {
	log := log.FromContext(ctx)

	var templates paprika.TemplateList
	if err := h.client.List(ctx, &templates); err != nil {
		return 0, fmt.Errorf("list templates: %w", err)
	}

	var updated int
	for i := range templates.Items {
		tmpl := &templates.Items[i]
		if !matchesTemplateRepo(tmpl, repoURL, branch) {
			continue
		}

		if tmpl.Annotations == nil {
			tmpl.Annotations = make(map[string]string)
		}
		tmpl.Annotations["paprika.io/sync"] = h.nowString()

		if err := h.client.Update(ctx, tmpl); err != nil {
			log.Error(err, "Failed to annotate template", "name", tmpl.Name)
			continue
		}
		updated++
	}
	return updated, nil
}

func matchesRepo(app *paprika.Application, repoURL, branch string) bool {
	if app.Spec.Source.Type != "git" {
		return false
	}
	if app.Spec.Source.RepoURL == "" {
		return false
	}
	if !urlsEqual(app.Spec.Source.RepoURL, repoURL) {
		return false
	}
	if app.Spec.Source.Revision != "" && app.Spec.Source.Revision != branch {
		return false
	}
	return true
}

func matchesTemplateRepo(tmpl *paprika.Template, repoURL, branch string) bool {
	if tmpl.Spec.Type != "git" || tmpl.Spec.Git == nil {
		return false
	}
	if !urlsEqual(tmpl.Spec.Git.RepoURL, repoURL) {
		return false
	}
	if tmpl.Spec.Git.Revision != "" && tmpl.Spec.Git.Revision != branch {
		return false
	}
	return true
}

func urlsEqual(a, b string) bool {
	ua, err := normalizeURL(a)
	if err != nil {
		return strings.TrimSuffix(a, ".git") == strings.TrimSuffix(b, ".git")
	}
	ub, err := normalizeURL(b)
	if err != nil {
		return strings.TrimSuffix(a, ".git") == strings.TrimSuffix(b, ".git")
	}
	return ua == ub
}

func normalizeURL(raw string) (string, error) {
	raw = strings.TrimSuffix(raw, ".git")
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse URL: %w", err)
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return strings.ToLower(u.String()), nil
}

func verifyGitHubSignature(sig, secret string, body []byte) error {
	if sig == "" {
		return errors.New("missing signature")
	}
	parts := strings.SplitN(sig, "=", 2)
	if len(parts) != 2 || parts[0] != "sha256" {
		return errors.New("invalid signature format")
	}
	expected := parts[1]

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	computed := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(expected), []byte(computed)) {
		return errors.New("signature mismatch")
	}
	return nil
}

func (h *Handler) nowString() string {
	return strconv.FormatInt(h.clock.Now().Unix(), 10)
}

// Payload structures.

//nolint:tagliatelle // Webhook payloads use snake_case.
type githubPushPayload struct {
	Ref        string `json:"ref"`
	Repository struct {
		CloneURL string `json:"clone_url"`
	} `json:"repository"`
}

//nolint:tagliatelle // Webhook payloads use snake_case.
type gitlabPushPayload struct {
	Ref     string `json:"ref"`
	Project struct {
		GitHTTPURL string `json:"git_http_url"`
	} `json:"project"`
}

// Ensure Handler implements http.Handler at compile time.
var _ http.Handler = (*Handler)(nil)

// Package client provides a connect-go client for the Paprika repo server.
package reposerverclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"connectrpc.com/connect"

	paprika "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/source"
)

// DefaultTimeout is long enough for cold private Git fetches while still
// bounding a stuck repo server request.
const DefaultTimeout = 2 * time.Minute

const timeoutEnv = "PAPRIKA_REPO_SERVER_TIMEOUT"

// Client calls a repo server.
type Client struct {
	baseURL       string
	httpClient    *http.Client
	timeout       time.Duration
	resolveSource v1connect.PaprikaServiceClient
	render        v1connect.PaprikaServiceClient
}

// New creates a client for the given repo server base URL.
func New(baseURL string) *Client {
	return NewWithTimeout(baseURL, timeoutFromEnv())
}

// NewWithTimeout creates a client for the given repo server base URL and timeout.
func NewWithTimeout(baseURL string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	httpClient := &http.Client{Timeout: timeout}
	return &Client{
		baseURL:       baseURL,
		httpClient:    httpClient,
		timeout:       timeout,
		resolveSource: v1connect.NewPaprikaServiceClient(httpClient, baseURL),
		render:        v1connect.NewPaprikaServiceClient(httpClient, baseURL),
	}
}

func timeoutFromEnv() time.Duration {
	raw := os.Getenv(timeoutEnv)
	if raw == "" {
		return DefaultTimeout
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return DefaultTimeout
	}
	return parsed
}

// NewFromEnv creates a client from PAPRIKA_REPO_SERVER_ADDR. Returns nil if unset.
//
// Deprecated: read PAPRIKA_REPO_SERVER_ADDR in cmd/main and pass the address to New.
func NewFromEnv(ctx context.Context) *Client {
	_ = ctx // reserved for future cancellation/observability
	addr := os.Getenv("PAPRIKA_REPO_SERVER_ADDR")
	if addr == "" {
		return nil
	}
	return New(addr)
}

// NewFromEnvLegacy creates a client from environment variables using a
// background context.
//
// Deprecated: use NewFromEnv(ctx).
func NewFromEnvLegacy() *Client {
	return NewFromEnv(context.Background())
}

// Enabled returns true if a repo server is configured.
func (c *Client) Enabled() bool { return c != nil }

type invalidateRequest struct {
	SourceType string `json:"sourceType"`
	SourceURL  string `json:"sourceUrl"`
	Revision   string `json:"revision"`
}

// Invalidate requests the repo server to invalidate cached entries for a source.
func (c *Client) Invalidate(ctx context.Context, sourceType, sourceURL, revision string) (err error) {
	if c == nil {
		return nil
	}
	payload, err := json.Marshal(invalidateRequest{SourceType: sourceType, SourceURL: sourceURL, Revision: revision})
	if err != nil {
		return fmt.Errorf("marshal invalidate request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/invalidate", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create invalidate request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("repo server invalidate: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close invalidate response body: %w", closeErr)
		}
	}()
	if resp.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("repo server invalidate returned status %d", resp.StatusCode)
	}
	return nil
}

// ResolveSource resolves a template source via the repo server.
func (c *Client) ResolveSource(ctx context.Context, tmpl *paprika.Template) (*source.ResolveResult, error) {
	if c == nil {
		return nil, errors.New("repo server client is disabled")
	}

	specJSON, err := json.Marshal(tmpl.Spec)
	if err != nil {
		return nil, fmt.Errorf("marshal template spec: %w", err)
	}

	req := connect.NewRequest(&paprikav1.ResolveSourceRequest{
		Namespace: tmpl.Namespace,
		Name:      tmpl.Name,
		Type:      tmpl.Spec.Type,
		SpecJson:  specJSON,
	})
	resp, err := c.resolveSource.ResolveSource(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("repo server ResolveSource: %w", err)
	}

	return &source.ResolveResult{
		LocalPath: resp.Msg.LocalPath,
		Hash:      resp.Msg.Hash,
		Revision:  resp.Msg.Revision,
	}, nil
}

// Render renders a template via the repo server.
func (c *Client) Render(ctx context.Context, tmpl *paprika.Template, values map[string]string) ([]byte, error) {
	if c == nil {
		return nil, errors.New("repo server client is disabled")
	}

	specJSON, err := json.Marshal(tmpl.Spec)
	if err != nil {
		return nil, fmt.Errorf("marshal template spec: %w", err)
	}

	valuesJSON, err := json.Marshal(values)
	if err != nil {
		return nil, fmt.Errorf("marshal values: %w", err)
	}

	req := connect.NewRequest(&paprikav1.RenderRequest{
		Namespace:  tmpl.Namespace,
		Name:       tmpl.Name,
		Type:       tmpl.Spec.Type,
		SpecJson:   specJSON,
		ValuesJson: valuesJSON,
	})
	resp, err := c.render.Render(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("repo server Render: %w", err)
	}

	return resp.Msg.Manifests, nil
}

// Package client provides a connect-go client for the Paprika repo server.
package client

import (
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
	"github.com/benebsworth/paprika/source"
)

// Client calls a repo server.
type Client struct {
	resolveSource v1connect.PaprikaServiceClient
	render        v1connect.PaprikaServiceClient
}

// New creates a client for the given repo server base URL.
func New(baseURL string) *Client {
	httpClient := &http.Client{Timeout: 30 * time.Second}
	return &Client{
		resolveSource: v1connect.NewPaprikaServiceClient(httpClient, baseURL),
		render:        v1connect.NewPaprikaServiceClient(httpClient, baseURL),
	}
}

// NewFromEnv creates a client from PAPRIKA_REPO_SERVER_ADDR. Returns nil if unset.
func NewFromEnv() *Client {
	addr := os.Getenv("PAPRIKA_REPO_SERVER_ADDR")
	if addr == "" {
		return nil
	}
	return New(addr)
}

// Enabled returns true if a repo server is configured.
func (c *Client) Enabled() bool { return c != nil }

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

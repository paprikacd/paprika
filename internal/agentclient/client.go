package agentclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"connectrpc.com/connect"

	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// ControllerClient calls a remote agent from the controller manager.
type ControllerClient struct {
	baseURL string
	client  *http.Client
}

// NewControllerClient creates a client for the agent at baseURL.
// If client is nil, http.DefaultClient is used.
func NewControllerClient(baseURL string, client *http.Client) *ControllerClient {
	if client == nil {
		client = http.DefaultClient
	}
	return &ControllerClient{
		baseURL: baseURL,
		client:  client,
	}
}

// Health checks the agent health endpoint.
func (c *ControllerClient) Health(ctx context.Context) error {
	cli := v1connect.NewPaprikaServiceClient(c.client, c.baseURL)
	_, err := cli.ListPipelines(ctx, connect.NewRequest(&paprikav1.ListPipelinesRequest{}))
	if err != nil && connect.CodeOf(err) != connect.CodeUnimplemented {
		return fmt.Errorf("agent health check failed: %w", err)
	}
	return nil
}

// Apply sends manifests to the agent for server-side application.
func (c *ControllerClient) Apply(ctx context.Context, req *agentserver.ApplyRequest) (*agentserver.ApplyResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal apply request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/apply", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build apply request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("apply request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	if resp.StatusCode != http.StatusOK {
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("apply returned status %d: %w", resp.StatusCode, err)
		}
		return nil, fmt.Errorf("apply returned status %d: %s", resp.StatusCode, string(data))
	}

	var applyResp agentserver.ApplyResponse
	if err := json.NewDecoder(resp.Body).Decode(&applyResp); err != nil {
		return nil, fmt.Errorf("decode apply response: %w", err)
	}
	return &applyResp, nil
}

// Enabled returns true if the client has a non-empty base URL.
func (c *ControllerClient) Enabled() bool { return c != nil && c.baseURL != "" }

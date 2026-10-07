// Package gates provides verification gate implementations for pipeline promotion stages.
package gates

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// GateResult contains the result of a gate execution.
type GateResult struct {
	Passed  bool
	Message string
	Error   error
}

// GateConfig holds the configuration for executing a gate.
type GateConfig struct {
	Type     string `json:"type"`
	Endpoint string `json:"endpoint,omitempty"`
	Timeout  int    `json:"timeout,omitempty"`
}

// SmokeGate performs HTTP smoke tests against an endpoint without following redirects.
type SmokeGate struct {
	Client *http.Client
}

// NewSmokeGate creates a new SmokeGate with the given HTTP client.
// If client is nil, http.DefaultClient is used.
func NewSmokeGate(client *http.Client) *SmokeGate {
	if client == nil {
		client = http.DefaultClient
	}
	return &SmokeGate{Client: client}
}

// Execute runs the smoke test against the configured endpoint.
func (g *SmokeGate) Execute(ctx context.Context, config GateConfig) GateResult {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 300
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, config.Endpoint, http.NoBody)
	if err != nil {
		return GateResult{Passed: false, Message: fmt.Sprintf("failed to create request: %v", err), Error: err}
	}

	// A redirect could make an unhealthy environment pass by serving the
	// response from another environment. Keep the caller's transport and TLS
	// settings without mutating its shared client or redirect policy.
	client := *g.Client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return GateResult{Passed: false, Message: fmt.Sprintf("HTTP request failed: %v", err), Error: err}
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return GateResult{Passed: true, Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}

	return GateResult{Passed: false, Message: fmt.Sprintf("HTTP %d (expected 2xx)", resp.StatusCode)}
}

// DurationGate waits for a specified duration as a verification gate.
type DurationGate struct{}

// Execute runs the duration gate, waiting for the configured timeout.
func (g *DurationGate) Execute(ctx context.Context, config GateConfig) GateResult {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 60
	}

	select {
	case <-time.After(time.Duration(timeout) * time.Second):
		return GateResult{Passed: true, Message: fmt.Sprintf("waited %d seconds", timeout)}
	case <-ctx.Done():
		return GateResult{Passed: false, Message: "context cancelled during duration gate", Error: ctx.Err()}
	}
}

// Executor dispatches verification gates according to their configured type.
type Executor struct {
	smoke *SmokeGate
}

// NewExecutor creates a gate executor using client for HTTP smoke tests.
// If client is nil, http.DefaultClient is used.
func NewExecutor(client *http.Client) *Executor {
	return &Executor{smoke: NewSmokeGate(client)}
}

// Execute runs the configured gate, rejecting unsupported gate types.
func (e *Executor) Execute(ctx context.Context, config GateConfig) GateResult {
	switch config.Type {
	case "smoke-test":
		return e.smoke.Execute(ctx, config)
	case "duration":
		return (&DurationGate{}).Execute(ctx, config)
	default:
		return GateResult{Passed: false, Message: "unknown gate type: " + config.Type}
	}
}

// ExecuteGate dispatches to the appropriate gate implementation based on config type.
func ExecuteGate(ctx context.Context, config GateConfig) GateResult {
	return NewExecutor(nil).Execute(ctx, config)
}

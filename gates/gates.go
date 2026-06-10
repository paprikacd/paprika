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

// Gate defines the interface for verification gates.
type Gate interface {
	Execute(ctx context.Context, config GateConfig) GateResult
}

// GateConfig holds the configuration for executing a gate.
type GateConfig struct {
	Type     string `json:"type"`
	Endpoint string `json:"endpoint,omitempty"`
	Timeout  int    `json:"timeout,omitempty"`
}

// SmokeGate performs HTTP smoke tests against an endpoint.
type SmokeGate struct {
	Client *http.Client
}

// NewSmokeGate creates a new SmokeGate with a default HTTP client.
func NewSmokeGate() *SmokeGate {
	return &SmokeGate{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
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

	resp, err := g.Client.Do(req)
	if err != nil {
		return GateResult{Passed: false, Message: fmt.Sprintf("HTTP request failed: %v", err), Error: err}
	}
	defer func() { _ = resp.Body.Close() }()

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

// ExecuteGate dispatches to the appropriate gate implementation based on config type.
func ExecuteGate(ctx context.Context, config GateConfig) GateResult {
	switch config.Type {
	case "smoke-test":
		return NewSmokeGate().Execute(ctx, config)
	case "duration":
		return (&DurationGate{}).Execute(ctx, config)
	default:
		return GateResult{Passed: false, Message: "unknown gate type: " + config.Type}
	}
}

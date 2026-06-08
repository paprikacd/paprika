package gates

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

type GateResult struct {
	Passed  bool
	Message string
	Error   error
}

type Gate interface {
	Execute(ctx context.Context, config GateConfig) GateResult
}

type GateConfig struct {
	Type     string `json:"type"`
	Endpoint string `json:"endpoint,omitempty"`
	Timeout  int    `json:"timeout,omitempty"`
}

type SmokeGate struct {
	Client *http.Client
}

func NewSmokeGate() *SmokeGate {
	return &SmokeGate{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (g *SmokeGate) Execute(ctx context.Context, config GateConfig) GateResult {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 300
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, config.Endpoint, nil)
	if err != nil {
		return GateResult{Passed: false, Message: fmt.Sprintf("failed to create request: %v", err), Error: err}
	}

	resp, err := g.Client.Do(req)
	if err != nil {
		return GateResult{Passed: false, Message: fmt.Sprintf("HTTP request failed: %v", err), Error: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return GateResult{Passed: true, Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}

	return GateResult{Passed: false, Message: fmt.Sprintf("HTTP %d (expected 2xx)", resp.StatusCode)}
}

type DurationGate struct{}

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

func ExecuteGate(ctx context.Context, config GateConfig) GateResult {
	switch config.Type {
	case "smoke-test":
		return NewSmokeGate().Execute(ctx, config)
	case "duration":
		return (&DurationGate{}).Execute(ctx, config)
	default:
		return GateResult{Passed: false, Message: fmt.Sprintf("unknown gate type: %s", config.Type)}
	}
}

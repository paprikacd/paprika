// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	agentserver "github.com/benebsworth/paprika/internal/agent/server"
)

//go:generate mockgen -destination=mocks/agent_client.go -package=mocks -typed . AgentClient

// AgentApplier applies manifests via a remote in-cluster agent.
type AgentApplier interface {
	Apply(ctx context.Context, req *agentserver.ApplyRequest) (*agentserver.ApplyResponse, error)
}

// AgentHealthChecker checks the health of a remote in-cluster agent.
type AgentHealthChecker interface {
	Health(ctx context.Context) error
}

// AgentEnabler reports whether the agent client is enabled.
type AgentEnabler interface {
	Enabled() bool
}

// AgentClient applies manifests via a remote in-cluster agent.
type AgentClient interface {
	AgentApplier
	AgentHealthChecker
	AgentEnabler
}

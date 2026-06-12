// Package controller contains controller interfaces.
package controller

import (
	"context"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	agentserver "github.com/benebsworth/paprika/internal/agent/server"
)

//go:generate mockgen -destination=mocks/cluster_client_manager.go -package=mocks . ClusterClientManager

// ClusterClientManager manages Kubernetes clients for multiple clusters.
type ClusterClientManager interface {
	GetClient(ctx context.Context, kubeconfigSecret, namespace string) (dynamic.Interface, error)
	GetRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error)
}

//go:generate mockgen -destination=mocks/agent_client.go -package=mocks . AgentClient

// AgentClient applies manifests via a remote in-cluster agent.
type AgentClient interface {
	Apply(ctx context.Context, req *agentserver.ApplyRequest) (*agentserver.ApplyResponse, error)
	Health(ctx context.Context) error
	Enabled() bool
}

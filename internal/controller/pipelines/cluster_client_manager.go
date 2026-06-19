// Package pipelines contains pipeline controller interfaces.
package pipelines

import (
	"context"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

//go:generate mockgen -destination=mocks/cluster_client_manager.go -package=mocks -typed . ClusterClientManager

// ClusterClientGetter returns a dynamic Kubernetes client for a cluster.
type ClusterClientGetter interface {
	GetClient(ctx context.Context, kubeconfigSecret, namespace string) (dynamic.Interface, error)
}

// ClusterRestConfigGetter returns a REST config for a cluster.
type ClusterRestConfigGetter interface {
	GetRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error)
}

// ClusterClientManager manages Kubernetes clients for multiple clusters.
type ClusterClientManager interface {
	ClusterClientGetter
	ClusterRestConfigGetter
}

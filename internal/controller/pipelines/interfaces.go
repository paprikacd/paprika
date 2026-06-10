// Package controller contains controller interfaces.
package controller

import (
	"context"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

//go:generate mockgen -destination=mocks/cluster_client_manager.go -package=mocks . ClusterClientManager

// ClusterClientManager manages Kubernetes clients for multiple clusters.
type ClusterClientManager interface {
	GetClient(ctx context.Context, kubeconfigSecret, namespace string) (dynamic.Interface, error)
	GetRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error)
}

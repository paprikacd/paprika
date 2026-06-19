package pipelines

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// clusterClientManager manages dynamic Kubernetes clients for target clusters.
type clusterClientManager struct {
	client        client.Client
	defaultConfig *rest.Config
}

// NewClusterClientManager creates a new ClusterClientManager implementation.
func NewClusterClientManager(c client.Client, defaultConfig *rest.Config) ClusterClientManager {
	return &clusterClientManager{
		client:        c,
		defaultConfig: defaultConfig,
	}
}

// GetClient returns a dynamic client for the cluster described by the given kubeconfig secret.
func (m *clusterClientManager) GetClient(ctx context.Context, kubeconfigSecret, namespace string) (dynamic.Interface, error) {
	if kubeconfigSecret == "" {
		dynClient, err := dynamic.NewForConfig(m.defaultConfig)
		if err != nil {
			return nil, fmt.Errorf("create dynamic client from default config: %w", err)
		}
		return dynClient, nil
	}

	var secret corev1.Secret
	if err := m.client.Get(ctx, types.NamespacedName{Name: kubeconfigSecret, Namespace: namespace}, &secret); err != nil {
		return nil, fmt.Errorf("get kubeconfig secret: %w", err)
	}

	kubeconfig, ok := secret.Data["kubeconfig"]
	if !ok {
		return nil, errors.New("kubeconfig secret missing 'kubeconfig' key")
	}

	config, err := clientcmd.NewClientConfigFromBytes(kubeconfig)
	if err != nil {
		return nil, fmt.Errorf("parse kubeconfig: %w", err)
	}

	restConfig, err := config.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("build rest config: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("create dynamic client from rest config: %w", err)
	}
	return dynClient, nil
}

// GetRestConfig returns a REST config for the cluster described by the given kubeconfig secret.
func (m *clusterClientManager) GetRestConfig(ctx context.Context, kubeconfigSecret, namespace string) (*rest.Config, error) {
	if kubeconfigSecret == "" {
		return m.defaultConfig, nil
	}

	var secret corev1.Secret
	if err := m.client.Get(ctx, types.NamespacedName{Name: kubeconfigSecret, Namespace: namespace}, &secret); err != nil {
		return nil, fmt.Errorf("get kubeconfig secret: %w", err)
	}

	kubeconfig, ok := secret.Data["kubeconfig"]
	if !ok {
		return nil, errors.New("kubeconfig secret missing 'kubeconfig' key")
	}

	config, err := clientcmd.NewClientConfigFromBytes(kubeconfig)
	if err != nil {
		return nil, fmt.Errorf("parse kubeconfig: %w", err)
	}

	restConfig, err := config.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("build rest config: %w", err)
	}
	return restConfig, nil
}

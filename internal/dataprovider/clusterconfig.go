package dataprovider

import (
	"context"
	"fmt"

	"k8s.io/client-go/rest"
)

// ClusterConfigResolver hands a capacity provider the connection details for
// one fleet cluster.
//
// A ReadRequest carries a cluster key and nothing else, because a provider
// must not have to know how this control plane stores credentials. This is the
// seam that turns that key into a usable connection: the API server injects a
// resolver backed by the Cluster API and its kubeconfig Secrets (see
// internal/clusterconfig), so a read scoped to a remote fleet cluster actually
// reaches that cluster instead of quietly reporting the control plane's own.
//
// The empty cluster key means the cluster this control plane runs in.
type ClusterConfigResolver interface {
	ConfigFor(ctx context.Context, clusterKey string) (*rest.Config, error)
}

// InClusterConfigResolver resolves only the cluster this control plane runs
// in, and refuses any other cluster by name.
//
// It is the fallback when no fleet-wide resolver is injected. Refusing is the
// point: the alternative — returning the in-cluster config for every key —
// answers a question about a remote cluster with numbers from the local one,
// which is indistinguishable from a correct answer at every layer above.
type InClusterConfigResolver struct{}

// ConfigFor implements ClusterConfigResolver.
func (InClusterConfigResolver) ConfigFor(_ context.Context, clusterKey string) (*rest.Config, error) {
	if clusterKey != "" {
		return nil, fmt.Errorf("no cluster config resolver is configured to reach cluster %q", clusterKey)
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("resolving in-cluster config: %w", err)
	}

	return cfg, nil
}

// configResolverOrDefault returns configs, or the local-only fallback when no
// resolver was injected.
func configResolverOrDefault(configs ClusterConfigResolver) ClusterConfigResolver {
	if configs == nil {
		return InClusterConfigResolver{}
	}

	return configs
}

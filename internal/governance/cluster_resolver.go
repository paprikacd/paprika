package governance

import (
	"context"
	"fmt"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type ClusterResolver interface {
	ResolveServer(ctx context.Context, defaultNs string, ref pipelinesv1alpha1.ClusterRef) (string, error)
}

func NewClusterResolver(c client.Reader) ClusterResolver {
	return &clusterResolver{client: c}
}

type clusterResolver struct {
	client client.Reader
}

func (r *clusterResolver) ResolveServer(ctx context.Context, defaultNs string, ref pipelinesv1alpha1.ClusterRef) (string, error) {
	if ref.Server != "" {
		return ref.Server, nil
	}
	if ref.Name == "" {
		return "https://kubernetes.default.svc", nil
	}
	ns := ref.Namespace
	if ns == "" {
		ns = defaultNs
	}
	var cluster clustersv1alpha1.Cluster
	if err := r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: ns}, &cluster); err != nil {
		return "", fmt.Errorf("get cluster %s/%s: %w", ns, ref.Name, err)
	}
	if cluster.Spec.Server != "" {
		return cluster.Spec.Server, nil
	}
	return "https://kubernetes.default.svc", nil
}

/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package clusterconfig turns a fleet Cluster into the *rest.Config needed to
// reach it.
//
// It exists because two callers need the same answer and must not drift apart:
// the cluster controller, which health-checks every registered cluster, and
// the console's capacity providers, which read nodes, pods and metrics from
// the cluster a request is scoped to. Two copies of "how do we authenticate to
// a managed cluster" would eventually disagree about which secret key holds
// the kubeconfig, or about what an unset mode means, and a fleet would then be
// reachable by one subsystem and not the other for no visible reason.
package clusterconfig

import (
	"context"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// defaultKubeconfigKey is the Secret data key a kubeconfigSecretRef reads
// when it names no key of its own.
const defaultKubeconfigKey = "kubeconfig"

// ForCluster returns the rest.Config to reach cluster, reading its kubeconfig
// Secret through reader when the spec points at one.
//
// Agent-mode clusters return a nil config and a nil error: the control plane
// does not dial them at all, the agent dials in. Callers that need a live
// connection must treat a nil config as "not reachable from here" rather than
// as a config they can use.
func ForCluster(
	ctx context.Context,
	reader client.Reader,
	cluster *clustersv1alpha1.Cluster,
) (*rest.Config, error) {
	switch cluster.Spec.Mode {
	case clustersv1alpha1.ClusterModeInCluster:
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
		return cfg, nil
	case clustersv1alpha1.ClusterModeAgent:
		return nil, nil
	case clustersv1alpha1.ClusterModeDirect:
		if cluster.Spec.KubeconfigSecretRef != nil {
			return configFromSecret(ctx, reader, cluster)
		}
		if cluster.Spec.Server != "" {
			return &rest.Config{Host: cluster.Spec.Server}, nil
		}
		return nil, errors.New("direct mode requires server or kubeconfigSecretRef")
	default:
		return nil, fmt.Errorf("unsupported cluster mode %q", cluster.Spec.Mode)
	}
}

// configFromSecret builds a config from the kubeconfig the cluster's
// kubeconfigSecretRef points at. The ref may name a namespace of its own; when
// it does not, the Secret is read from the Cluster's own namespace, so a
// tenant's ref cannot reach into another tenant's Secrets by omission.
func configFromSecret(
	ctx context.Context,
	reader client.Reader,
	cluster *clustersv1alpha1.Cluster,
) (*rest.Config, error) {
	ref := cluster.Spec.KubeconfigSecretRef
	ns := ref.Namespace
	if ns == "" {
		ns = cluster.Namespace
	}

	var secret corev1.Secret
	if err := reader.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: ns}, &secret); err != nil {
		return nil, fmt.Errorf("getting kubeconfig secret: %w", err)
	}

	key := ref.Key
	if key == "" {
		key = defaultKubeconfigKey
	}
	data, ok := secret.Data[key]
	if !ok {
		return nil, fmt.Errorf("kubeconfig secret missing key %q", key)
	}

	cfg, err := clientcmd.RESTConfigFromKubeConfig(data)
	if err != nil {
		return nil, fmt.Errorf("parsing kubeconfig: %w", err)
	}

	return cfg, nil
}

// Resolver resolves a cluster key to the rest.Config that reaches it.
//
// A cluster key is "<namespace>/<name>", the same identity the client cache in
// internal/kube is keyed by, and the empty key means the cluster this control
// plane itself runs in. Callers that hold only a key — a capacity provider
// serving a scoped read request, for instance — can get a config without
// depending on the Cluster API or on how credentials are stored.
type Resolver struct {
	reader client.Reader
}

// NewResolver returns a Resolver that reads Clusters and their kubeconfig
// Secrets through reader.
func NewResolver(reader client.Reader) *Resolver {
	return &Resolver{reader: reader}
}

// ConfigFor implements the resolver seam capacity providers depend on.
//
// Errors name the cluster key the caller supplied and nothing else: a
// kubeconfig's host, its CA or its token must never reach an error string,
// because these errors travel into responses and logs.
func (r *Resolver) ConfigFor(ctx context.Context, clusterKey string) (*rest.Config, error) {
	if clusterKey == "" {
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("resolving in-cluster config: %w", err)
		}
		return cfg, nil
	}
	if r.reader == nil {
		return nil, fmt.Errorf("no cluster reader is configured to resolve cluster %q", clusterKey)
	}

	cluster, err := r.clusterFor(ctx, clusterKey)
	if err != nil {
		return nil, err
	}

	cfg, err := ForCluster(ctx, r.reader, cluster)
	if err != nil {
		return nil, fmt.Errorf("building config for cluster %q: %w", clusterKey, err)
	}
	if cfg == nil {
		// Agent mode: the connection is inbound, so there is nothing here to
		// dial out with. Saying so is better than handing back a nil config
		// that fails later with a nil-pointer shape.
		return nil, fmt.Errorf("cluster %q is reached through an agent, not dialed directly", clusterKey)
	}

	return cfg, nil
}

// clusterFor loads the Cluster a key names, refusing a key that is not in
// namespace/name form and a cluster an operator has disabled — a disabled
// cluster is one nothing should be dialing, capacity reads included.
func (r *Resolver) clusterFor(ctx context.Context, clusterKey string) (*clustersv1alpha1.Cluster, error) {
	namespace, name, ok := strings.Cut(clusterKey, "/")
	if !ok || namespace == "" || name == "" {
		return nil, fmt.Errorf("cluster key %q is not in namespace/name form", clusterKey)
	}

	var cluster clustersv1alpha1.Cluster
	if err := r.reader.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &cluster); err != nil {
		return nil, fmt.Errorf("getting cluster %q: %w", clusterKey, err)
	}
	if cluster.Spec.Disabled {
		return nil, fmt.Errorf("cluster %q is disabled", clusterKey)
	}

	return &cluster, nil
}

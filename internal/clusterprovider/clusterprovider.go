// Package clusterprovider resolves the cloud provider behind a fleet Cluster
// and enriches its status with what only the provider's own API knows:
// managed-cluster identity, node-pool autoscaler bounds and plan sizes.
//
// Enrichment is layered. Detection from node providerIDs always runs and
// needs no credential — it is what a zero-configuration in-cluster Cluster
// reports. The provider API call only happens when spec.provider selects an
// integration and a credential (secret or ambient workload identity) can be
// resolved. Every failure maps onto a small set of states so the controller
// can report why the board is empty without leaking credential material.
package clusterprovider

import (
	"context"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// State values written to ClusterStatus.Provider.State. They deliberately
// parallel dataprovider.DataState so a reader already fluent in the data
// contract reads the provider board the same way.
const (
	StateOK            = "OK"
	StateNotConfigured = "NotConfigured"
	StateNotAvailable  = "NotAvailable"
	StateError         = "Error"
	StateForbidden     = "Forbidden"
)

// Provider names, shared by spec.provider.type, detection results and status.
const (
	ProviderVultr = "vultr"
	ProviderGKE   = "gke"
	ProviderEKS   = "eks"
	ProviderAKS   = "aks"
)

// ErrForbidden marks provider API denials so the controller can report
// Forbidden rather than Error — the distinction an operator acts on.
var ErrForbidden = errors.New("provider credential refused")

// ErrNotConfigured marks a missing or unusable credential: the integration is
// selected but cannot authenticate.
var ErrNotConfigured = errors.New("provider credential not configured")

// ErrNotMatched marks the case where the provider answered but no managed
// cluster could be correlated with this Cluster — an empty ClusterID and an
// endpoint that matches nothing the provider knows.
var ErrNotMatched = errors.New("no provider cluster matched")

// Request is one Describe call: the identity hints the spec carried, the
// resolved credential document (nil for ambient identity), and the apiserver
// endpoint Paprika connected to for providers that can match on it.
type Request struct {
	ClusterID      string
	Region         string
	Project        string
	SubscriptionID string
	Endpoint       string
	Credentials    []byte
}

// Details is what a provider reports about one managed cluster.
type Details struct {
	ClusterID string
	Region    string
	Version   string
	NodePools []clustersv1alpha1.ClusterNodePool
}

// Provider is one cloud integration. Implementations must be safe to hold
// for the lifetime of the process; per-call state belongs in Request.
type Provider interface {
	// Describe returns provider-side details, or an error wrapping one of the
	// sentinels above so callers can classify it.
	Describe(ctx context.Context, req *Request) (*Details, error)
}

// ResolveType decides which integration applies to a cluster: the spec's
// explicit type wins; "auto" or an absent spec falls back to what the node
// providerIDs report. Empty means nothing could be resolved.
func ResolveType(spec *clustersv1alpha1.ClusterProviderSpec, nodes []corev1.Node) string {
	if spec != nil && spec.Type != "" && spec.Type != "auto" {
		return spec.Type
	}
	return Detect(nodes)
}

// Detect infers the managed provider from node providerID prefixes. The first
// node with a recognized prefix decides: a fleet mixes providers only inside
// one cluster in exotic setups, and prefix order is stable for the prefixes
// that matter.
func Detect(nodes []corev1.Node) string {
	for i := range nodes {
		switch id := nodes[i].Spec.ProviderID; {
		case strings.HasPrefix(id, "vultr://"):
			return ProviderVultr
		case strings.HasPrefix(id, "gce://"), strings.HasPrefix(id, "gke://"):
			return ProviderGKE
		case strings.HasPrefix(id, "aws://"):
			return ProviderEKS
		case strings.HasPrefix(id, "azure://"):
			return ProviderAKS
		}
	}
	return ""
}

// NodePoolsFromNodes derives pool membership from node labels, so a cluster
// with no provider credential still shows a pool shape. The provider's own
// label is preferred per integration; absent any of them, pools group by
// node.kubernetes.io/instance-type, which is the least flattering view that
// is still honest.
func NodePoolsFromNodes(providerType string, nodes []corev1.Node) []clustersv1alpha1.ClusterNodePool {
	labelKey := nodePoolLabel(providerType)
	type poolKey struct{ name, machineType string }

	pools := make(map[poolKey]*clustersv1alpha1.ClusterNodePool)
	for i := range nodes {
		name := nodes[i].Labels[labelKey]
		machine := nodes[i].Labels["node.kubernetes.io/instance-type"]
		if name == "" {
			// Unknown pool: group under the machine type rather than a literal
			// "default", so a partial label rollout still reads sensibly.
			name = machine
			if name == "" {
				name = "default"
			}
		}
		key := poolKey{name: name, machineType: machine}
		pool, ok := pools[key]
		if !ok {
			pool = &clustersv1alpha1.ClusterNodePool{Name: name, MachineType: machine}
			pools[key] = pool
		}
		pool.NodeCount++
	}

	out := make([]clustersv1alpha1.ClusterNodePool, 0, len(pools))
	for _, pool := range pools {
		out = append(out, *pool)
	}
	sortNodePools(out)
	return out
}

// nodePoolLabel is the node-pool membership label each managed provider
// stamps. An empty key means the provider has no conventional label and
// pools fall back to instance-type grouping.
func nodePoolLabel(providerType string) string {
	switch providerType {
	case ProviderVultr:
		return "vke.vultr.com/node-pool"
	case ProviderGKE:
		return "cloud.google.com/gke-nodepool"
	case ProviderEKS:
		return "eks.amazonaws.com/nodegroup"
	case ProviderAKS:
		return "kubernetes.azure.com/agentpool"
	default:
		return ""
	}
}

func sortNodePools(pools []clustersv1alpha1.ClusterNodePool) {
	for i := 1; i < len(pools); i++ {
		for j := i; j > 0 && pools[j].Name < pools[j-1].Name; j-- {
			pools[j], pools[j-1] = pools[j-1], pools[j]
		}
	}
}

// New builds the Provider for a resolved type. An unknown type is a caller
// bug and reported as such; credential problems belong to Describe so they
// surface as cluster status rather than construction failures.
func New(providerType string) (Provider, error) {
	switch providerType {
	case ProviderVultr:
		return &Vultr{}, nil
	case ProviderEKS:
		return &EKS{}, nil
	case ProviderGKE:
		return &GKE{}, nil
	case ProviderAKS:
		return &AKS{}, nil
	default:
		return nil, fmt.Errorf("unknown cluster provider %q", providerType)
	}
}

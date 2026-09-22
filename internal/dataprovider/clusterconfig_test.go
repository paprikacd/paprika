package dataprovider

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/benebsworth/paprika/internal/kube"
)

// errNoConfigResolver is returned by a resolver that refuses every cluster.
var errNoConfigResolver = errors.New("no config for that cluster")

// recordingConfigResolver hands back a fixed config and remembers which
// cluster it was asked about.
type recordingConfigResolver struct {
	cfg  *rest.Config
	keys []string
}

func (r *recordingConfigResolver) ConfigFor(_ context.Context, clusterKey string) (*rest.Config, error) {
	r.keys = append(r.keys, clusterKey)
	if r.cfg == nil {
		return nil, errNoConfigResolver
	}

	return rest.CopyConfig(r.cfg), nil
}

func TestKubernetesCapacityReadsThroughTheResolvedClusterConfig(t *testing.T) {
	t.Parallel()

	// The gap this closes: a ReadRequest carries a cluster key, and without a
	// resolver behind it the only config a provider can find is the control
	// plane's own — which answers a question about a remote fleet cluster with
	// local numbers, indistinguishably from a correct answer.
	resolver := &recordingConfigResolver{cfg: &rest.Config{Host: "https://prod.example:6443"}}
	var dialed []string
	clients := kube.NewClientsWithBuilder(func(cfg *rest.Config) (kubernetes.Interface, *http.Client, error) {
		dialed = append(dialed, cfg.Host)
		return fake.NewSimpleClientset(&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "node-a"},
			Status: corev1.NodeStatus{Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("4"),
				corev1.ResourceMemory: resource.MustParse("8Gi"),
			}},
		}), &http.Client{}, nil
	})

	got, err := NewKubernetesCapacity(clients, resolver).Read(t.Context(),
		ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Equal(t, []string{"fleet/prod"}, resolver.keys)
	require.Equal(t, []string{"https://prod.example:6443"}, dialed,
		"the read must reach the cluster the request named, not this control plane")
	require.Equal(t, StateOK, got.CPUMillicores.Allocatable.State)
	require.InDelta(t, 4000, got.CPUMillicores.Allocatable.Value, 0.001)
}

func TestKubernetesCapacityFailsWhenTheClusterCannotBeResolved(t *testing.T) {
	t.Parallel()

	clients := kube.NewClientsWithBuilder(func(_ *rest.Config) (kubernetes.Interface, *http.Client, error) {
		return nil, nil, errNoConfigResolver
	})

	_, err := NewKubernetesCapacity(clients, &recordingConfigResolver{}).Read(t.Context(),
		ReadRequest{ClusterKey: "fleet/prod"})
	require.ErrorContains(t, err, `cluster "fleet/prod"`,
		"an unreachable cluster is an error, never a silent read of some other cluster")
}

func TestInClusterConfigResolverRefusesEveryOtherCluster(t *testing.T) {
	t.Parallel()

	_, err := InClusterConfigResolver{}.ConfigFor(context.Background(), "fleet/prod")
	require.ErrorContains(t, err, `cluster "fleet/prod"`)
}

package clusterprovider

import (
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

func node(providerID string, labels map[string]string) corev1.Node {
	return corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Labels: labels},
		Spec:       corev1.NodeSpec{ProviderID: providerID},
	}
}

func TestDetect(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		nodes []corev1.Node
		want  string
	}{
		{"empty", nil, ""},
		{"vultr", []corev1.Node{node("vultr://uuid", nil)}, ProviderVultr},
		{"gce", []corev1.Node{node("gce://p/z/i", nil)}, ProviderGKE},
		{"gke", []corev1.Node{node("gke://p/z/i", nil)}, ProviderGKE},
		{"aws", []corev1.Node{node("aws:///us-east-1a/i-123", nil)}, ProviderEKS},
		{"azure", []corev1.Node{node("azure:///subscriptions/s/i", nil)}, ProviderAKS},
		{"unrecognized", []corev1.Node{node("metal://1", nil)}, ""},
		{"no providerID", []corev1.Node{node("", nil)}, ""},
		{"first recognized wins", []corev1.Node{
			node("", nil), node("vultr://uuid", nil), node("aws:///z/i", nil),
		}, ProviderVultr},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			require.Equal(t, tc.want, Detect(tc.nodes))
		})
	}
}

func TestResolveTypePrefersSpecThenDetection(t *testing.T) {
	t.Parallel()

	nodes := []corev1.Node{node("vultr://uuid", nil)}

	require.Equal(t, ProviderVultr, ResolveType(nil, nodes))
	require.Equal(t, ProviderVultr, ResolveType(&clustersv1alpha1.ClusterProviderSpec{Type: "auto"}, nodes))
	require.Equal(t, ProviderEKS, ResolveType(&clustersv1alpha1.ClusterProviderSpec{Type: "eks"}, nodes))
	require.Empty(t, ResolveType(nil, nil))
}

func TestNodePoolsFromNodes(t *testing.T) {
	t.Parallel()

	nodes := []corev1.Node{
		node("vultr://a", map[string]string{
			"vke.vultr.com/node-pool":          "core",
			"node.kubernetes.io/instance-type": "vc2-2c-4gb",
			"topology.kubernetes.io/region":    "syd",
		}),
		node("vultr://b", map[string]string{
			"vke.vultr.com/node-pool":          "core",
			"node.kubernetes.io/instance-type": "vc2-2c-4gb",
		}),
		node("vultr://c", map[string]string{
			"vke.vultr.com/node-pool":          "workers",
			"node.kubernetes.io/instance-type": "vc2-4c-8gb",
		}),
	}

	pools := NodePoolsFromNodes(ProviderVultr, nodes)
	require.Len(t, pools, 2)
	require.Equal(t, "core", pools[0].Name)
	require.Equal(t, int32(2), pools[0].NodeCount)
	require.Equal(t, "vc2-2c-4gb", pools[0].MachineType)
	require.Equal(t, "workers", pools[1].Name)
	require.Equal(t, int32(1), pools[1].NodeCount)
}

func TestNodePoolsFromNodesFallsBackToInstanceType(t *testing.T) {
	t.Parallel()

	// A cluster whose provider label is absent still gets a pool shape —
	// grouped by machine type — rather than nothing.
	nodes := []corev1.Node{
		node("vultr://a", map[string]string{"node.kubernetes.io/instance-type": "vc2-2c-4gb"}),
		node("vultr://b", map[string]string{"node.kubernetes.io/instance-type": "vc2-2c-4gb"}),
		node("vultr://c", nil),
	}

	pools := NodePoolsFromNodes(ProviderVultr, nodes)
	require.Len(t, pools, 2)
	require.Equal(t, "default", pools[0].Name)
	require.Equal(t, int32(1), pools[0].NodeCount)
	require.Equal(t, "vc2-2c-4gb", pools[1].Name)
	require.Equal(t, int32(2), pools[1].NodeCount)
}

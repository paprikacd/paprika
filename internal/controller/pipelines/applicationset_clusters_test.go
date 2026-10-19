package pipelines

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func clustersGeneratorFixture(t *testing.T) *ApplicationSetReconciler {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	prod := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-eu", Namespace: "paprika-system"},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:   clustersv1alpha1.ClusterModeDirect,
			Server: "https://edge-eu.example",
			Labels: map[string]string{"region": "eu-west", "tier": "production", "team.name": "platform"},
		},
		Status: clustersv1alpha1.ClusterStatus{Provider: &clustersv1alpha1.ClusterProviderStatus{Type: "vultr"}},
	}
	staging := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-us", Namespace: "paprika-system"},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:   clustersv1alpha1.ClusterModeAgent,
			Labels: map[string]string{"tier": "staging"},
		},
	}
	disabled := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-retired", Namespace: "paprika-system"},
		Spec: clustersv1alpha1.ClusterSpec{
			Mode:     clustersv1alpha1.ClusterModeDirect,
			Disabled: true,
			Labels:   map[string]string{"tier": "production"},
		},
	}
	otherNamespace := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Name: "edge-eu", Namespace: "another-project"},
		Spec:       clustersv1alpha1.ClusterSpec{Labels: map[string]string{"tier": "production"}},
	}

	return &ApplicationSetReconciler{client: fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(prod, staging, disabled, otherNamespace).Build()}
}

// TestClustersGeneratorEmitsPlacementParameters covers what a placement
// template needs: a ClusterRef takes a name and a namespace, and the rest of
// the registration is useful for branching.
func TestClustersGeneratorEmitsPlacementParameters(t *testing.T) {
	t.Parallel()

	r := clustersGeneratorFixture(t)
	params, err := r.generateClusters(context.Background(), "paprika-system",
		&pipelinesv1alpha1.ClustersGenerator{Selector: &metav1.LabelSelector{
			MatchLabels: map[string]string{"tier": "production"},
		}})
	require.NoError(t, err)
	require.Len(t, params, 1, "only the enabled production cluster may be generated")

	got := params[0]
	require.Equal(t, "edge-eu", got["name"])
	require.Equal(t, "paprika-system", got["namespace"], "a cluster of the same name can exist in another project")
	require.Equal(t, "direct", got["mode"])
	require.Equal(t, "https://edge-eu.example", got["server"])
	require.Equal(t, "vultr", got["provider"])
	require.Equal(t, "eu-west", got["region"])
	require.Equal(t, "production", got["tier"])
	require.Equal(t, "platform", got["label_team_name"], "a dotted label key must be usable as a template field")
}

// TestClustersGeneratorSkipsDisabledClusters keeps the set to placements that
// can converge.
func TestClustersGeneratorSkipsDisabledClusters(t *testing.T) {
	t.Parallel()

	r := clustersGeneratorFixture(t)
	params, err := r.generateClusters(context.Background(), "paprika-system",
		&pipelinesv1alpha1.ClustersGenerator{Names: []string{"edge-retired", "edge-us"}})
	require.NoError(t, err)
	require.Len(t, params, 1)
	require.Equal(t, "edge-us", params[0]["name"])
	require.Equal(t, "agent", params[0]["mode"])
}

// TestClustersGeneratorReadsRegistrationsFromAnotherNamespace covers the usual
// layout: applications in their own namespaces, registrations in the control
// plane's.
func TestClustersGeneratorReadsRegistrationsFromAnotherNamespace(t *testing.T) {
	t.Parallel()

	r := clustersGeneratorFixture(t)
	params, err := r.generateClusters(context.Background(), "checkout",
		&pipelinesv1alpha1.ClustersGenerator{
			Namespace: "paprika-system",
			Selector:  &metav1.LabelSelector{MatchLabels: map[string]string{"tier": "staging"}},
		})
	require.NoError(t, err)
	require.Len(t, params, 1)
	require.Equal(t, "edge-us", params[0]["name"])
	require.Equal(t, "paprika-system", params[0]["namespace"])
}

// TestClustersGeneratorKeepsUnknownNames makes a typo visible: the Application
// is generated and fails at apply, rather than vanishing from the set.
func TestClustersGeneratorKeepsUnknownNames(t *testing.T) {
	t.Parallel()

	r := clustersGeneratorFixture(t)
	params, err := r.generateClusters(context.Background(), "paprika-system",
		&pipelinesv1alpha1.ClustersGenerator{Names: []string{"typo"}})
	require.NoError(t, err)
	require.Len(t, params, 1)
	require.Equal(t, "typo", params[0]["name"])
	require.Equal(t, "paprika-system", params[0]["namespace"])
}

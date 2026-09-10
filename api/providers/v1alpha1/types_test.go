package v1alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestScopeKindsAreOrderedMostSpecificFirst(t *testing.T) {
	t.Parallel()
	// The resolver depends on this order. Declaring it beside the types keeps
	// the precedence chain and the enum from drifting apart.
	require.Equal(t,
		[]ScopeKind{ScopeNamespace, ScopeCluster, ScopeProject, ScopeGlobal},
		ScopeKindsBySpecificity())
}

func TestGroupVersionIsRegistered(t *testing.T) {
	t.Parallel()
	require.Equal(t, "providers.paprika.io", GroupVersion.Group)
	require.Equal(t, "v1alpha1", GroupVersion.Version)
}

func TestScopeIsPermittedGuardsGlobalScopeByNamespace(t *testing.T) {
	t.Parallel()

	// Global scope applies to every tenant, so only the control plane's own
	// namespace may declare it. This predicate is consulted by both the
	// admission webhook and the capacity resolver, so the two cannot drift:
	// what admission rejects is exactly what resolution ignores.
	tests := map[string]struct {
		namespace     string
		kind          ScopeKind
		controlPlane  string
		wantPermitted bool
	}{
		"global in the control plane namespace": {
			namespace: "paprika-system", kind: ScopeGlobal, controlPlane: "paprika-system", wantPermitted: true,
		},
		"global in a tenant namespace": {
			namespace: "tenant", kind: ScopeGlobal, controlPlane: "paprika-system", wantPermitted: false,
		},
		"global with no control plane namespace configured": {
			namespace: "tenant", kind: ScopeGlobal, controlPlane: "", wantPermitted: false,
		},
		"namespace scope from a tenant namespace": {
			namespace: "tenant", kind: ScopeNamespace, controlPlane: "paprika-system", wantPermitted: true,
		},
		"cluster scope from a tenant namespace": {
			namespace: "tenant", kind: ScopeCluster, controlPlane: "paprika-system", wantPermitted: true,
		},
		"project scope from a tenant namespace": {
			namespace: "tenant", kind: ScopeProject, controlPlane: "paprika-system", wantPermitted: true,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			binding := &DataProviderBinding{
				ObjectMeta: metav1.ObjectMeta{Namespace: test.namespace, Name: "b"},
				Spec:       DataProviderBindingSpec{Scope: BindingScope{Kind: test.kind, Name: "x"}},
			}
			require.Equal(t, test.wantPermitted, binding.ScopeIsPermitted(test.controlPlane))
		})
	}
}

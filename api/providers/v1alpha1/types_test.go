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
	// namespace may declare it. Namespace scope is the most specific level in
	// the chain, so a binding may name only the namespace it lives in — one
	// naming somebody else's namespace would win the chain there. This
	// predicate is consulted by both the admission webhook and the capacity
	// resolver, so the two cannot drift: what admission rejects is exactly what
	// resolution ignores.
	tests := map[string]struct {
		namespace     string
		kind          ScopeKind
		scopeName     string
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
		"namespace scope naming its own namespace": {
			namespace: "tenant", kind: ScopeNamespace, scopeName: "tenant",
			controlPlane: "paprika-system", wantPermitted: true,
		},
		"namespace scope naming another tenant's namespace": {
			namespace: "tenant", kind: ScopeNamespace, scopeName: "victim",
			controlPlane: "paprika-system", wantPermitted: false,
		},
		"namespace scope from the control plane naming a tenant": {
			// Not even the control plane's namespace may claim the most
			// specific level of somebody else's namespace: an operator who
			// wants to reach every tenant has Global, which is audited as such.
			namespace: "paprika-system", kind: ScopeNamespace, scopeName: "tenant",
			controlPlane: "paprika-system", wantPermitted: false,
		},
		"namespace scope with no name": {
			namespace: "tenant", kind: ScopeNamespace, scopeName: "",
			controlPlane: "paprika-system", wantPermitted: false,
		},
		"cluster scope from a tenant namespace": {
			namespace: "tenant", kind: ScopeCluster, scopeName: "prod-eu-1",
			controlPlane: "paprika-system", wantPermitted: true,
		},
		"project scope from a tenant namespace": {
			namespace: "tenant", kind: ScopeProject, scopeName: "payments",
			controlPlane: "paprika-system", wantPermitted: true,
		},
		"an unknown scope kind fails closed": {
			namespace: "tenant", kind: ScopeKind("Universe"), scopeName: "everything",
			controlPlane: "paprika-system", wantPermitted: false,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			binding := &DataProviderBinding{
				ObjectMeta: metav1.ObjectMeta{Namespace: test.namespace, Name: "b"},
				Spec:       DataProviderBindingSpec{Scope: BindingScope{Kind: test.kind, Name: test.scopeName}},
			}
			require.Equal(t, test.wantPermitted, binding.ScopeIsPermitted(test.controlPlane))
		})
	}
}

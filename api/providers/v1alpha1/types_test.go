package v1alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"
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

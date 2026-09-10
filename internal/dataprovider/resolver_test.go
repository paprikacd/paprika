package dataprovider

import (
	"testing"

	"github.com/stretchr/testify/require"

	v1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
)

func TestResolvePrefersTheMostSpecificBinding(t *testing.T) {
	t.Parallel()
	scope := Scope{Namespace: "team-a", Cluster: "prod-eu-1", Project: "payments"}
	bindings := []Binding{
		{ProviderName: "global", ScopeKind: v1alpha1.ScopeGlobal},
		{ProviderName: "project", ScopeKind: v1alpha1.ScopeProject, ScopeName: "payments"},
		{ProviderName: "cluster", ScopeKind: v1alpha1.ScopeCluster, ScopeName: "prod-eu-1"},
	}
	got, ok := Resolve(scope, bindings)
	require.True(t, ok)
	require.Equal(t, "cluster", got.ProviderName)
}

func TestResolveIgnoresBindingsForOtherScopes(t *testing.T) {
	t.Parallel()
	scope := Scope{Cluster: "prod-eu-1"}
	_, ok := Resolve(scope, []Binding{
		{ProviderName: "other", ScopeKind: v1alpha1.ScopeCluster, ScopeName: "staging-1"},
	})
	require.False(t, ok, "a binding for another cluster must not win by default")
}

func TestResolveReturnsFalseWhenNothingIsBound(t *testing.T) {
	t.Parallel()
	_, ok := Resolve(Scope{Cluster: "prod-eu-1"}, nil)
	require.False(t, ok)
}

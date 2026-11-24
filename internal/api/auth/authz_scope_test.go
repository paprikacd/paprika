package auth

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestScopeDigestIgnoresSubjectsNoRuleNames(t *testing.T) {
	t.Parallel()
	authorizer := NewRBACAuthorizer([]RBACRule{
		{Subjects: []string{"group:observers"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"*"}},
	})
	alice := &Principal{Subject: "alice", Groups: []string{"observers"}}
	bob := &Principal{Subject: "bob", Groups: []string{"observers"}}
	require.Equal(t, authorizer.ScopeDigest(alice), authorizer.ScopeDigest(bob),
		"two callers in the same group get the same decisions, so they may share a scope")
}

func TestScopeDigestSeparatesPrincipalsThatMatchDifferentRules(t *testing.T) {
	t.Parallel()
	authorizer := NewRBACAuthorizer([]RBACRule{
		{Subjects: []string{"alice"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"team-a"}},
		{Subjects: []string{"bob"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"team-b"}},
	})
	alice := &Principal{Subject: "alice"}
	bob := &Principal{Subject: "bob"}
	require.NotEqual(t, authorizer.ScopeDigest(alice), authorizer.ScopeDigest(bob))
	// The digest must agree with the decisions it stands for.
	require.NoError(t, authorizer.Authorize(context.Background(), alice, ActionRead, ResourceObservabilityProviders, "team-a", ""))
	require.Error(t, authorizer.Authorize(context.Background(), bob, ActionRead, ResourceObservabilityProviders, "team-a", ""))
}

func TestScopeDigestChangesWhenRulesChange(t *testing.T) {
	t.Parallel()
	rule := RBACRule{Subjects: []string{"alice"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"team-a"}}
	alice := &Principal{Subject: "alice"}
	before := NewRBACAuthorizer([]RBACRule{rule}).ScopeDigest(alice)
	widened := rule
	widened.Namespaces = []string{"*"}
	require.NotEqual(t, before, NewRBACAuthorizer([]RBACRule{widened}).ScopeDigest(alice))
	require.Len(t, before, 64)
}

func TestScopeDigestIsNotAvailableFromAllowAll(t *testing.T) {
	t.Parallel()
	var authorizer Authorizer = &AllowAllAuthorizer{}
	_, ok := authorizer.(ScopeDigester)
	require.False(t, ok, "a non-RBAC authorizer must not report a scope, so its callers never share results")
}

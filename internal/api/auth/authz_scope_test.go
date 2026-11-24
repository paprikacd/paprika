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

// Equal digests must mean equal decisions. Every pair of principals below, including a subject spelled
// like a group, a principal in no group, duplicate groups, a wildcard subject and a rule with no subjects,
// is checked against every action, resource and namespace the rules mention: whenever two digests are
// equal, every Authorize answer is too.
func TestScopeDigestEqualityImpliesEqualDecisions(t *testing.T) {
	t.Parallel()
	authorizer := NewRBACAuthorizer([]RBACRule{
		{Subjects: []string{"group:observers"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"team-a"}},
		{Subjects: []string{"group:admins"}, Actions: []string{"admin"}, Resources: []string{"*"}, Namespaces: []string{"*"}},
		{Subjects: []string{"carol"}, Actions: []string{"write"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"team-b"}},
		{Subjects: []string{"*"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"team-c"}},
		{Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"shared"}},
	})
	principals := []*Principal{
		{Subject: "alice", Groups: []string{"observers"}},
		{Subject: "bob", Groups: []string{"observers", "observers"}},
		{Subject: "carol"},
		{Subject: "carol", Groups: []string{"observers"}},
		{Subject: "dave"},
		{Subject: "erin", Groups: []string{"admins"}},
		{Subject: "group:admins"},
		{Subject: "frank", Groups: []string{"group:admins"}},
		{Subject: "grace", Groups: []string{"observers", "admins"}},
	}
	actions := []Action{ActionRead, ActionWrite, ActionAdmin}
	resources := []Resource{ResourceObservabilityProviders, ResourceInsights, ResourceApplications}
	namespaces := []string{"team-a", "team-b", "team-c", "shared", "other"}
	decisions := func(p *Principal) []bool {
		out := make([]bool, 0, len(actions)*len(resources)*len(namespaces))
		for _, action := range actions {
			for _, resource := range resources {
				for _, namespace := range namespaces {
					out = append(out, authorizer.Authorize(context.Background(), p, action, resource, namespace, "") == nil)
				}
			}
		}
		return out
	}
	shared := 0
	for i, a := range principals {
		for _, b := range principals[i+1:] {
			if authorizer.ScopeDigest(a) == authorizer.ScopeDigest(b) {
				shared++
				require.Equal(t, decisions(a), decisions(b), "%s and %s share a digest but not their decisions", a.Subject, b.Subject)
			}
		}
	}
	require.Positive(t, shared, "the fixture has principals that may share")
	require.NotEqual(t, authorizer.ScopeDigest(principals[0]), authorizer.ScopeDigest(principals[3]), "a named subject separates carol from alice")
	require.NotEqual(t, authorizer.ScopeDigest(principals[5]), authorizer.ScopeDigest(principals[7]), "a group literally named group:admins is not the admins group")
	require.Equal(t, authorizer.ScopeDigest(principals[4]), authorizer.ScopeDigest(principals[7]), "so frank has dave's permissions, and their digest")
}

func TestScopeDigestIsNotAvailableFromAllowAll(t *testing.T) {
	t.Parallel()
	var authorizer Authorizer = &AllowAllAuthorizer{}
	_, ok := authorizer.(ScopeDigester)
	require.False(t, ok, "a non-RBAC authorizer must not report a scope, so its callers never share results")
}

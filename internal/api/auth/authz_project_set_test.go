package auth

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestAuthorizedProjectsAllowAllPreservesCandidateOrderAndIdentity(t *testing.T) {
	t.Parallel()
	candidates := []ProjectRef{
		{Namespace: "tenant-b", Name: "payments"},
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-a", Name: "orders"},
	}

	got, err := (&AllowAllAuthorizer{}).AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, candidates, got)

	got[0].Name = "mutated"
	assert.Equal(t, "payments", candidates[0].Name, "the result must not alias caller-owned candidates")
}

func TestAuthorizedProjectsDenyAllReturnsNoCandidates(t *testing.T) {
	t.Parallel()
	candidates := []ProjectRef{{Namespace: "tenant-a", Name: "payments"}}

	got, err := (&DenyAllAuthorizer{}).AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestAuthorizedProjectsRBACFiltersWildcardsNamespaceAndProject(t *testing.T) {
	t.Parallel()
	authorizer := NewRBACAuthorizer([]RBACRule{
		{
			Subjects:   []string{"alice"},
			Actions:    []string{"read"},
			Resources:  []string{"applications"},
			Namespaces: []string{"tenant-a"},
			Projects:   []string{"payments"},
		},
		{
			Subjects:   []string{"alice"},
			Actions:    []string{"read"},
			Resources:  []string{"applications"},
			Namespaces: []string{"tenant-b"},
			Projects:   []string{"*"},
		},
		{
			Subjects:   []string{"alice"},
			Actions:    []string{"read"},
			Resources:  []string{"applications"},
			Namespaces: []string{"*"},
			Projects:   []string{"shared"},
		},
	})
	candidates := []ProjectRef{
		{Namespace: "tenant-c", Name: "shared"},
		{Namespace: "tenant-b", Name: "payments"},
		{Namespace: "tenant-a", Name: "orders"},
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-c", Name: "payments"},
	}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, []ProjectRef{
		{Namespace: "tenant-c", Name: "shared"},
		{Namespace: "tenant-b", Name: "payments"},
		{Namespace: "tenant-a", Name: "payments"},
	}, got)
}

func TestAuthorizedProjectsMultiAuthorizerIntersectsInOrder(t *testing.T) {
	t.Parallel()
	rbac := NewRBACAuthorizer([]RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"applications"},
		Namespaces: []string{"tenant-a", "tenant-b"},
		Projects:   []string{"payments"},
	}})
	projects := NewProjectAuthorizer(fake.NewClientBuilder().WithObjects([]client.Object{
		appProject("tenant-a", "payments", "bob"),
		appProject("tenant-b", "payments", "alice"),
		appProject("tenant-a", "orders", "alice"),
	}...).Build())
	authorizer := &multiAuthorizer{authorizers: []Authorizer{rbac, projects}}
	candidates := []ProjectRef{
		{Namespace: "tenant-b", Name: "payments"},
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-a", Name: "orders"},
	}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications, candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, []ProjectRef{{Namespace: "tenant-b", Name: "payments"}}, got)
}

func TestAuthorizedProjectsMultiAuthorizerShortCircuitsEmptyIntersection(t *testing.T) {
	t.Parallel()
	first := &projectSetAuthorizer{allowed: map[ProjectRef]bool{}}
	second := &projectSetAuthorizer{err: assert.AnError}
	authorizer := &multiAuthorizer{authorizers: []Authorizer{first, second}}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications,
		[]ProjectRef{{Namespace: "tenant-a", Name: "payments"}},
	)
	require.NoError(t, err)
	assert.Empty(t, got)
	assert.Equal(t, 1, first.calls)
	assert.Zero(t, second.calls)
}

func TestAuthorizedProjectsMultiAuthorizerNeverReintroducesDeniedCandidates(t *testing.T) {
	t.Parallel()
	projectA := ProjectRef{Namespace: "tenant-a", Name: "payments"}
	projectB := ProjectRef{Namespace: "tenant-b", Name: "payments"}
	projectC := ProjectRef{Namespace: "tenant-c", Name: "orders"}
	first := &projectSetAuthorizer{result: []ProjectRef{projectA, projectC}}
	second := &projectSetAuthorizer{result: []ProjectRef{
		projectB,
		projectA,
		projectA,
		{Namespace: "invented", Name: "payments"},
	}}
	authorizer := &multiAuthorizer{authorizers: []Authorizer{first, second}}

	got, err := authorizer.AuthorizedProjects(
		context.Background(), &Principal{Subject: "alice"},
		ActionRead, ResourceApplications,
		[]ProjectRef{projectB, projectA, projectA, projectC},
	)
	require.NoError(t, err)
	assert.Equal(t, []ProjectRef{projectA}, got)
}

type projectSetAuthorizer struct {
	allowed map[ProjectRef]bool
	result  []ProjectRef
	err     error
	calls   int
}

func (a *projectSetAuthorizer) Authorize(
	context.Context, *Principal, Action, Resource, string, string,
) error {
	return nil
}

func (a *projectSetAuthorizer) AuthorizedProjects(
	_ context.Context,
	_ *Principal,
	_ Action,
	_ Resource,
	candidates []ProjectRef,
) ([]ProjectRef, error) {
	a.calls++
	if a.err != nil {
		return nil, a.err
	}
	if a.result != nil {
		return append([]ProjectRef(nil), a.result...), nil
	}
	result := make([]ProjectRef, 0, len(candidates))
	for _, candidate := range candidates {
		if a.allowed[candidate] {
			result = append(result, candidate)
		}
	}
	return result, nil
}

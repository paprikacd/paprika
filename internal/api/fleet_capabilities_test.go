package apiserver

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestFleetCapabilitiesNilAuthorizerAcceptsActualCandidates(t *testing.T) {
	t.Parallel()

	projects := []fleet.ProjectKey{
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-b", Name: "payments"},
	}
	reader := &fleetScopeReader{projects: projects}

	scope, err := buildFleetQueryScope(
		context.Background(),
		reader,
		nil,
		nil,
		[]string{"tenant-b", "tenant-a"},
	)
	require.NoError(t, err)
	require.Equal(t, [][]string{{"tenant-b", "tenant-a"}}, reader.namespaceCalls)
	require.Equal(t, fleet.ProjectSet{
		projects[0]: {},
		projects[1]: {},
	}, scope.Projects)
	wantCapabilities := []fleet.Capability{
		fleet.CapabilityApplicationSync,
		fleet.CapabilityReleaseRollback,
		fleet.CapabilityGateApprove,
		fleet.CapabilityPipelineRetry,
	}
	for _, project := range projects {
		require.Equal(t, wantCapabilities, scope.SortedCapabilities(project))
	}
}

func TestFleetCapabilitiesIntersectsAuthorizedProjectsByFullIdentity(t *testing.T) {
	t.Parallel()

	principal := &auth.Principal{Subject: "alice"}
	projects := []fleet.ProjectKey{
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-b", Name: "payments"},
	}
	reader := &fleetScopeReader{projects: projects}
	authorizer := &fleetScopeAuthorizer{
		authorized: []auth.ProjectRef{
			{Namespace: "tenant-b", Name: "payments"},
			{Namespace: "invented", Name: "payments"},
			{Namespace: "tenant-b", Name: "payments"},
		},
		authorize: func(call fleetPermissionCall) error {
			// Only the three capability resources are valid for this test double.
			//nolint:exhaustive // Resource is an open string type, not a closed enum.
			switch call.resource {
			case auth.ResourceApplications, auth.ResourceReleases:
				return nil
			case auth.ResourcePipelines:
				return auth.ErrUnauthorized
			default:
				t.Fatalf("unexpected resource %q", call.resource)
				return nil
			}
		},
	}

	scope, err := buildFleetQueryScope(context.Background(), reader, authorizer, principal, nil)
	require.NoError(t, err)
	require.Len(t, authorizer.authorizedCalls, 1)
	require.Same(t, principal, authorizer.authorizedCalls[0].principal)
	require.Equal(t, auth.ActionRead, authorizer.authorizedCalls[0].action)
	require.Equal(t, auth.ResourceApplications, authorizer.authorizedCalls[0].resource)
	require.Equal(t, []auth.ProjectRef{
		{Namespace: "tenant-a", Name: "payments"},
		{Namespace: "tenant-b", Name: "payments"},
	}, authorizer.authorizedCalls[0].candidates)
	require.Equal(t, fleet.ProjectSet{projects[1]: {}}, scope.Projects)
	require.Equal(t, []fleet.Capability{
		fleet.CapabilityApplicationSync,
		fleet.CapabilityReleaseRollback,
		fleet.CapabilityGateApprove,
	}, scope.SortedCapabilities(projects[1]))
	require.Equal(t, []fleetPermissionCall{
		{principal: principal, action: auth.ActionWrite, resource: auth.ResourceApplications, project: auth.ProjectRef{Namespace: "tenant-b", Name: "payments"}},
		{principal: principal, action: auth.ActionWrite, resource: auth.ResourceReleases, project: auth.ProjectRef{Namespace: "tenant-b", Name: "payments"}},
		{principal: principal, action: auth.ActionWrite, resource: auth.ResourcePipelines, project: auth.ProjectRef{Namespace: "tenant-b", Name: "payments"}},
	}, authorizer.authorizeCalls)
	// release.rollback and gate.approve share one unique permission tuple.
	require.Len(t, authorizer.authorizeCalls, 3)
}

func TestFleetReadQueryScopeDoesNotAuthorizeWriteCapabilities(t *testing.T) {
	t.Parallel()

	project := fleet.ProjectKey{Namespace: "tenant-a", Name: "payments"}
	backendErr := errors.New("write authorization backend unavailable")
	authorizer := &fleetScopeAuthorizer{
		authorized: []auth.ProjectRef{{Namespace: project.Namespace, Name: project.Name}},
		authorize: func(fleetPermissionCall) error {
			return backendErr
		},
	}

	scope, err := buildFleetReadQueryScope(
		context.Background(),
		&fleetScopeReader{projects: []fleet.ProjectKey{project}},
		authorizer,
		&auth.Principal{Subject: "alice"},
		nil,
	)

	require.NoError(t, err)
	require.Equal(t, fleet.ProjectSet{project: {}}, scope.Projects)
	require.Empty(t, scope.CapabilitiesByProject)
	require.Len(t, authorizer.authorizedCalls, 1)
	require.Empty(t, authorizer.authorizeCalls)
}

func TestFleetCapabilitiesRemainNamespacedAcrossMixedGrants(t *testing.T) {
	t.Parallel()

	projectA := fleet.ProjectKey{Namespace: "tenant-a", Name: "payments"}
	projectB := fleet.ProjectKey{Namespace: "tenant-b", Name: "payments"}
	authorizer := &fleetScopeAuthorizer{
		authorized: []auth.ProjectRef{
			{Namespace: projectA.Namespace, Name: projectA.Name},
			{Namespace: projectB.Namespace, Name: projectB.Name},
		},
		authorize: func(call fleetPermissionCall) error {
			switch {
			case call.project.Namespace == projectA.Namespace && call.resource == auth.ResourceApplications:
				return nil
			case call.project.Namespace == projectA.Namespace && call.resource == auth.ResourcePipelines:
				return nil
			case call.project.Namespace == projectB.Namespace && call.resource == auth.ResourceReleases:
				return nil
			default:
				return auth.ErrUnauthorized
			}
		},
	}

	scope, err := buildFleetQueryScope(
		context.Background(),
		&fleetScopeReader{projects: []fleet.ProjectKey{projectA, projectB}},
		authorizer,
		&auth.Principal{Subject: "alice"},
		nil,
	)
	require.NoError(t, err)
	require.Equal(t, []fleet.Capability{
		fleet.CapabilityApplicationSync,
		fleet.CapabilityPipelineRetry,
	}, scope.SortedCapabilities(projectA))
	require.Equal(t, []fleet.Capability{
		fleet.CapabilityReleaseRollback,
		fleet.CapabilityGateApprove,
	}, scope.SortedCapabilities(projectB))
	require.Len(t, authorizer.authorizeCalls, 6)
}

func TestFleetCapabilitiesFailClosedOnOperationalErrors(t *testing.T) {
	t.Parallel()

	backendErr := errors.New("authorization backend unavailable")
	project := fleet.ProjectKey{Namespace: "tenant", Name: "payments"}
	tests := map[string]struct {
		readerErr     error
		authorizedErr error
		authorize     func(fleetPermissionCall) error
		principal     *auth.Principal
		wantIs        error
	}{
		"project candidate reader": {
			readerErr: backendErr,
			principal: &auth.Principal{Subject: "alice"},
			wantIs:    backendErr,
		},
		"read scope": {
			authorizedErr: backendErr,
			principal:     &auth.Principal{Subject: "alice"},
			wantIs:        backendErr,
		},
		"capability": {
			authorize: func(call fleetPermissionCall) error {
				if call.resource == auth.ResourceReleases {
					return backendErr
				}
				return nil
			},
			principal: &auth.Principal{Subject: "alice"},
			wantIs:    backendErr,
		},
		"missing principal": {
			principal: nil,
			wantIs:    auth.ErrUnauthorized,
		},
	}

	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			reader := &fleetScopeReader{projects: []fleet.ProjectKey{project}, err: test.readerErr}
			authorizer := &fleetScopeAuthorizer{
				authorized:    []auth.ProjectRef{{Namespace: project.Namespace, Name: project.Name}},
				authorizedErr: test.authorizedErr,
				authorize:     test.authorize,
			}

			scope, err := buildFleetQueryScope(context.Background(), reader, authorizer, test.principal, nil)
			require.Error(t, err)
			require.ErrorIs(t, err, test.wantIs)
			require.Empty(t, scope.Projects)
			require.Empty(t, scope.CapabilitiesByProject)
		})
	}
}

func TestFleetCapabilitiesStillAuthorizeAnEmptyCandidateSetOnce(t *testing.T) {
	t.Parallel()

	authorizer := &fleetScopeAuthorizer{}
	scope, err := buildFleetQueryScope(
		context.Background(),
		&fleetScopeReader{},
		authorizer,
		&auth.Principal{Subject: "alice"},
		nil,
	)
	require.NoError(t, err)
	require.Empty(t, scope.Projects)
	require.Empty(t, scope.CapabilitiesByProject)
	require.Len(t, authorizer.authorizedCalls, 1)
	require.Empty(t, authorizer.authorizedCalls[0].candidates)
	require.Empty(t, authorizer.authorizeCalls)
}

func TestFleetCapabilitiesNilReaderIsUnavailable(t *testing.T) {
	t.Parallel()

	scope, err := buildFleetQueryScope(context.Background(), nil, nil, nil, nil)
	require.Error(t, err)
	require.ErrorAs(t, err, new(*fleet.ErrUnavailable))
	require.Empty(t, scope.Projects)
	require.Empty(t, scope.CapabilitiesByProject)
}

type fleetScopeReader struct {
	projects       []fleet.ProjectKey
	err            error
	namespaceCalls [][]string
}

func (r *fleetScopeReader) ProjectKeys(_ context.Context, namespaces []string) ([]fleet.ProjectKey, error) {
	r.namespaceCalls = append(r.namespaceCalls, append([]string(nil), namespaces...))
	return append([]fleet.ProjectKey(nil), r.projects...), r.err
}

func (*fleetScopeReader) QueryApplications(context.Context, fleet.QueryScope, fleet.ApplicationQuery, string) (fleet.ApplicationPage, error) {
	panic("unexpected QueryApplications call")
}

func (*fleetScopeReader) QueryMap(context.Context, fleet.QueryScope, fleet.FleetMapQuery) (fleet.FleetMap, error) {
	panic("unexpected QueryMap call")
}

func (*fleetScopeReader) QueryMatrix(context.Context, fleet.QueryScope, fleet.FleetMatrixQuery) (fleet.FleetMatrix, error) {
	panic("unexpected QueryMatrix call")
}

func (*fleetScopeReader) LoadSnapshot() (*fleet.Snapshot, error) {
	panic("unexpected LoadSnapshot call")
}

func (*fleetScopeReader) CheckReady() error {
	panic("unexpected CheckReady call")
}

type fleetAuthorizedProjectsCall struct {
	principal  *auth.Principal
	action     auth.Action
	resource   auth.Resource
	candidates []auth.ProjectRef
}

type fleetPermissionCall struct {
	principal *auth.Principal
	action    auth.Action
	resource  auth.Resource
	project   auth.ProjectRef
}

type fleetScopeAuthorizer struct {
	authorized      []auth.ProjectRef
	authorizedErr   error
	authorize       func(fleetPermissionCall) error
	authorizedCalls []fleetAuthorizedProjectsCall
	authorizeCalls  []fleetPermissionCall
}

func (a *fleetScopeAuthorizer) AuthorizedProjects(
	_ context.Context,
	principal *auth.Principal,
	action auth.Action,
	resource auth.Resource,
	candidates []auth.ProjectRef,
) ([]auth.ProjectRef, error) {
	a.authorizedCalls = append(a.authorizedCalls, fleetAuthorizedProjectsCall{
		principal:  principal,
		action:     action,
		resource:   resource,
		candidates: append([]auth.ProjectRef(nil), candidates...),
	})
	return append([]auth.ProjectRef(nil), a.authorized...), a.authorizedErr
}

func (a *fleetScopeAuthorizer) Authorize(
	_ context.Context,
	principal *auth.Principal,
	action auth.Action,
	resource auth.Resource,
	namespace string,
	project string,
) error {
	call := fleetPermissionCall{
		principal: principal,
		action:    action,
		resource:  resource,
		project:   auth.ProjectRef{Namespace: namespace, Name: project},
	}
	a.authorizeCalls = append(a.authorizeCalls, call)
	if a.authorize != nil {
		return a.authorize(call)
	}
	return auth.ErrUnauthorized
}

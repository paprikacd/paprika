package admin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/api/auth"
)

type recordingAuthorizer struct {
	authorizeCalls          int
	authorizedProjectsCalls int
	principal               *auth.Principal
	action                  auth.Action
	resource                auth.Resource
	namespace               string
	project                 string
	candidates              []auth.ProjectRef
	authorizeError          error
	authorizedProjects      []auth.ProjectRef
	authorizedProjectsError error
}

func (authorizer *recordingAuthorizer) Authorize(
	_ context.Context,
	principal *auth.Principal,
	action auth.Action,
	resource auth.Resource,
	namespace string,
	project string,
) error {
	authorizer.authorizeCalls++
	authorizer.principal = principal
	authorizer.action = action
	authorizer.resource = resource
	authorizer.namespace = namespace
	authorizer.project = project
	return authorizer.authorizeError
}

func (authorizer *recordingAuthorizer) AuthorizedProjects(
	_ context.Context,
	principal *auth.Principal,
	action auth.Action,
	resource auth.Resource,
	candidates []auth.ProjectRef,
) ([]auth.ProjectRef, error) {
	authorizer.authorizedProjectsCalls++
	authorizer.principal = principal
	authorizer.action = action
	authorizer.resource = resource
	authorizer.candidates = append([]auth.ProjectRef(nil), candidates...)
	return append([]auth.ProjectRef(nil), authorizer.authorizedProjects...),
		authorizer.authorizedProjectsError
}

func validatedAdminSession(t *testing.T) (ValidatedSession, string) {
	t.Helper()
	store, _, _ := newTestStore()
	token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	session, err := store.Validate(token, types.UID("pod-uid-a"))
	require.NoError(t, err)
	return session, token
}

func TestAdminContextInstallsOnlyValidationDerivedMarkerAndPrincipal(t *testing.T) {
	t.Parallel()

	session, _ := validatedAdminSession(t)
	ctx := WithValidatedSession(context.Background(), &session)

	principal := auth.PrincipalFromContext(ctx)
	require.NotNil(t, principal)
	assert.Equal(t, "kubernetes:alice@example.com", principal.Subject)
	assert.Equal(t, []string{"platform-admins", "system:authenticated"}, principal.Groups)
	assert.Empty(t, principal.Email)
	assert.Empty(t, principal.Name)

	description, ok := SessionDescriptionFromContext(ctx)
	require.True(t, ok)
	assert.Equal(t, "alice@example.com", description.Subject)
	assert.Equal(t, AccessMode, description.AccessMode)
	accessMode, ok := AccessModeFromContext(ctx)
	require.True(t, ok)
	assert.Equal(t, AccessMode, accessMode)

	overwritten := auth.WithPrincipal(ctx, &auth.Principal{Subject: "forged-after-validation"})
	reviewedPrincipal, ok := ValidatedPrincipalFromContext(overwritten)
	require.True(t, ok)
	assert.Equal(t, "kubernetes:alice@example.com", reviewedPrincipal.Subject)
}

func TestAdminContextRejectsZeroSessionAndCallerCreatedPrincipal(t *testing.T) {
	t.Parallel()

	for name, ctx := range map[string]context.Context{
		"zero validated session": WithValidatedSession(context.Background(), &ValidatedSession{}),
		"forged subject": auth.WithPrincipal(context.Background(), &auth.Principal{
			Subject: "kubernetes:alice@example.com",
			Groups:  []string{"platform-admins"},
		}),
		"forged access-mode claim": auth.WithPrincipal(context.Background(), &auth.Principal{
			Subject: "attacker",
			Claims:  map[string]any{"access_mode": AccessMode},
		}),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, ok := SessionDescriptionFromContext(ctx)
			assert.False(t, ok)
			_, ok = AccessModeFromContext(ctx)
			assert.False(t, ok)
		})
	}
}

func TestAdminContextCannotBeActivatedByBrowserControlledInputs(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		"http://127.0.0.1:3001/paprika.v1.PaprikaService/SyncApplication?admin=true",
		nil,
	)
	request.Header.Set("X-Paprika-Admin-Session", "caller-session")
	request.Header.Set("X-Paprika-Access-Mode", AccessMode)
	request.Header.Set("Cookie", "paprika_admin="+AccessMode)
	ctx := auth.WithPrincipal(request.Context(), &auth.Principal{
		Subject: "kubernetes:caller",
		Claims: map[string]any{
			"access_mode":    AccessMode,
			"protobuf_admin": true,
		},
	})
	delegate := &recordingAuthorizer{authorizeError: auth.ErrUnauthorized}
	authorizer := NewAdminAwareAuthorizer(delegate)

	err := authorizer.Authorize(
		ctx,
		auth.PrincipalFromContext(ctx),
		auth.ActionAdmin,
		auth.ResourceApplications,
		"*",
		"*",
	)
	require.ErrorIs(t, err, auth.ErrUnauthorized)
	assert.Equal(t, 1, delegate.authorizeCalls)
}

func TestAdminAwareAuthorizerAllowsValidatedSessionWithoutDelegating(t *testing.T) {
	t.Parallel()

	session, _ := validatedAdminSession(t)
	ctx := WithValidatedSession(context.Background(), &session)
	delegate := &recordingAuthorizer{authorizeError: auth.ErrUnauthorized}
	authorizer := NewAdminAwareAuthorizer(delegate)

	require.NoError(t, authorizer.Authorize(
		ctx,
		auth.PrincipalFromContext(ctx),
		auth.ActionAdmin,
		auth.ResourceApplications,
		"any-namespace",
		"any-project",
	))
	assert.Zero(t, delegate.authorizeCalls)

	candidates := []auth.ProjectRef{
		{Namespace: "team-a", Name: "payments"},
		{Namespace: "team-b", Name: "payments"},
	}
	authorized, err := authorizer.AuthorizedProjects(
		ctx,
		auth.PrincipalFromContext(ctx),
		auth.ActionWrite,
		auth.ResourceApplications,
		candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, candidates, authorized)
	assert.Zero(t, delegate.authorizedProjectsCalls)
	authorized[0].Name = "mutated"
	assert.Equal(t, "payments", candidates[0].Name)
}

func TestAdminAwareAuthorizerDelegatesOrdinaryCallsExactlyOnce(t *testing.T) {
	t.Parallel()

	wantError := errors.New("delegate unavailable")
	delegate := &recordingAuthorizer{
		authorizeError: wantError,
		authorizedProjects: []auth.ProjectRef{
			{Namespace: "team-a", Name: "allowed"},
		},
	}
	authorizer := NewAdminAwareAuthorizer(delegate)
	principal := &auth.Principal{Subject: "ordinary-user"}
	ctx := auth.WithPrincipal(context.Background(), principal)

	err := authorizer.Authorize(
		ctx,
		principal,
		auth.ActionWrite,
		auth.ResourceReleases,
		"team-a",
		"payments",
	)
	require.ErrorIs(t, err, wantError)
	assert.Equal(t, 1, delegate.authorizeCalls)
	assert.Same(t, principal, delegate.principal)
	assert.Equal(t, auth.ActionWrite, delegate.action)
	assert.Equal(t, auth.ResourceReleases, delegate.resource)
	assert.Equal(t, "team-a", delegate.namespace)
	assert.Equal(t, "payments", delegate.project)

	candidates := []auth.ProjectRef{{Namespace: "team-a", Name: "allowed"}}
	authorized, err := authorizer.AuthorizedProjects(
		ctx,
		principal,
		auth.ActionRead,
		auth.ResourceApplications,
		candidates,
	)
	require.NoError(t, err)
	assert.Equal(t, candidates, authorized)
	assert.Equal(t, 1, delegate.authorizedProjectsCalls)
	assert.Equal(t, candidates, delegate.candidates)
}

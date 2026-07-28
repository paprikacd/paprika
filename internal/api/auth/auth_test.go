package auth

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	testPassword = "secret"
	testUsername = "admin"
	testNS       = "default"
)

func TestPrincipal_IsInGroup(t *testing.T) {
	t.Parallel()
	p := &Principal{Groups: []string{"admin", "dev"}}
	assert.True(t, p.IsInGroup("admin"))
	assert.False(t, p.IsInGroup("ops"))
}

func TestPrincipal_HasScope(t *testing.T) {
	t.Parallel()
	p := &Principal{Claims: map[string]interface{}{
		"role":  "admin",
		"roles": []interface{}{"read", "write"},
	}}
	assert.True(t, p.HasScope("role", "admin"))
	assert.True(t, p.HasScope("roles", "write"))
	assert.False(t, p.HasScope("role", "user"))
}

func TestPrincipalContext(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	assert.Nil(t, PrincipalFromContext(ctx))

	p := &Principal{Subject: "user-1"}
	ctx = WithPrincipal(ctx, p)
	assert.Equal(t, p, PrincipalFromContext(ctx))
}

func TestBasicAuthenticator(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	authn, err := NewBasicAuthenticator(BasicAuthConfig{
		Username:     testUsername,
		PasswordHash: string(ph),
	})
	require.NoError(t, err)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	require.NoError(t, err)
	req.SetBasicAuth(testUsername, testPassword)

	ctx := WithRequest(context.Background(), req)
	p, err := authn.Authenticate(ctx)
	require.NoError(t, err)
	assert.Equal(t, testUsername, p.Subject)

	req2, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	req2.SetBasicAuth(testUsername, "wrong")
	ctx2 := WithRequest(context.Background(), req2)
	_, err = authn.Authenticate(ctx2)
	assert.ErrorIs(t, err, ErrUnauthenticated)
}

func TestBasicAuthenticator_MissingUsername(t *testing.T) {
	t.Parallel()
	_, err := NewBasicAuthenticator(BasicAuthConfig{PasswordHash: "x"})
	assert.Error(t, err)
}

func TestMultiAuthenticator(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	basic, _ := NewBasicAuthenticator(BasicAuthConfig{
		Username:     testUsername,
		PasswordHash: string(ph),
	})

	multi := NewMultiAuthenticator(basic)

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	req.SetBasicAuth(testUsername, testPassword)
	ctx := WithRequest(context.Background(), req)
	p, err := multi.Authenticate(ctx)
	require.NoError(t, err)
	assert.Equal(t, testUsername, p.Subject)

	ctx2 := context.Background()
	_, err = multi.Authenticate(ctx2)
	assert.Error(t, err)
}

func TestRBACAuthorizer(t *testing.T) {
	t.Parallel()
	rules := []RBACRule{
		{
			Subjects:   []string{"admin"},
			Actions:    []string{"*"},
			Resources:  []string{"*"},
			Namespaces: []string{"*"},
		},
		{
			Subjects:   []string{"group:readers"},
			Actions:    []string{"read"},
			Resources:  []string{"applications"},
			Namespaces: []string{testNS},
		},
	}

	authz := NewRBACAuthorizer(rules)

	admin := &Principal{Subject: "admin"}
	require.NoError(t, authz.Authorize(context.Background(), admin, ActionWrite, ResourceApplications, "prod", ""))

	reader := &Principal{Subject: "bob", Groups: []string{"readers"}}
	require.NoError(t, authz.Authorize(context.Background(), reader, ActionRead, ResourceApplications, testNS, ""))
	assert.Error(t, authz.Authorize(context.Background(), reader, ActionWrite, ResourceApplications, testNS, ""))
	assert.Error(t, authz.Authorize(context.Background(), reader, ActionRead, ResourceApplications, "prod", ""))

	unknown := &Principal{Subject: "eve"}
	assert.Error(t, authz.Authorize(context.Background(), unknown, ActionRead, ResourceApplications, testNS, ""))
}

func TestRBACAuthorizer_Projects(t *testing.T) {
	t.Parallel()
	authz := NewRBACAuthorizer([]RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"applications"},
		Namespaces: []string{"*"},
		Projects:   []string{"payments"},
	}})
	require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "", "payments"))
	assert.Error(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "", "other"))
}

func TestAllowAllAuthorizer(t *testing.T) {
	t.Parallel()
	authz := &AllowAllAuthorizer{}
	assert.NoError(t, authz.Authorize(context.Background(), &Principal{}, ActionAdmin, ResourceApplications, "*", ""))
}

func TestDenyAllAuthorizer(t *testing.T) {
	t.Parallel()
	authz := &DenyAllAuthorizer{}
	assert.Error(t, authz.Authorize(context.Background(), &Principal{}, ActionRead, ResourceApplications, "", ""))
}

func TestClassify(t *testing.T) {
	t.Parallel()
	action, resource := classify("/paprika.v1.PaprikaService/ListApplications")
	assert.Equal(t, ActionRead, action)
	assert.Equal(t, ResourceApplications, resource)

	action, resource = classify("/paprika.v1.PaprikaService/SyncApplication")
	assert.Equal(t, ActionWrite, action)
	assert.Equal(t, ResourceApplications, resource)
}

func TestNamespaceFromRequest(t *testing.T) {
	t.Parallel()
	ns := testNS
	req := connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns})
	got := namespaceFromRequest(req)
	assert.Equal(t, testNS, got)
}

func TestInterceptor_Disabled(t *testing.T) {
	t.Parallel()
	interceptor, err := Interceptor(context.Background(), Config{Enabled: false}, nil)
	require.NoError(t, err)

	next := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		return connect.NewResponse(&paprikav1.ListApplicationsResponse{}), nil
	}

	wrapped := interceptor(next)
	ns := testNS
	resp, err := wrapped(context.Background(), connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns}))
	require.NoError(t, err)
	assert.NotNil(t, resp)
}

func TestInterceptor_BasicAuth(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(context.Background(), Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: string(ph),
		},
		RBACRules: []RBACRule{
			{Subjects: []string{"*"}, Actions: []string{"*"}, Resources: []string{"*"}, Namespaces: []string{"*"}},
		},
	}, nil)
	require.NoError(t, err)

	next := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		p := PrincipalFromContext(ctx)
		assert.NotNil(t, p)
		return connect.NewResponse(&paprikav1.ListApplicationsResponse{}), nil
	}
	wrapped := interceptor(next)

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "/", http.NoBody)
	req.SetBasicAuth(testUsername, testPassword)
	ctx := WithRequest(context.Background(), req)

	ns := testNS
	_, err = wrapped(ctx, connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns}))
	require.NoError(t, err)
}

func TestInterceptor_Unauthenticated(t *testing.T) {
	t.Parallel()
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(context.Background(), Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: string(ph),
		},
	}, nil)
	require.NoError(t, err)

	next := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		t.Fatal("should not reach next")
		return nil, nil
	}
	wrapped := interceptor(next)

	ns := testNS
	_, err = wrapped(context.Background(), connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
}

func TestFleetQueryInterceptorDefersProjectSetAuthorization(t *testing.T) {
	ph, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	require.NoError(t, err)
	interceptor, err := Interceptor(context.Background(), Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: string(ph),
		},
		// With no RBAC rules or project reader, BuildAuthorizer returns DenyAll.
		// Reaching the handlers therefore proves that middleware did not invoke
		// legacy single-project authorization with an empty project.
	}, nil)
	require.NoError(t, err)

	service := &fleetAuthTestService{t: t}
	_, handler := v1connect.NewPaprikaServiceHandler(
		service,
		connect.WithInterceptors(interceptor),
	)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := v1connect.NewPaprikaServiceClient(server.Client(), server.URL)
	authorization := "Basic " + base64.StdEncoding.EncodeToString([]byte(testUsername+":"+testPassword))

	calls := []struct {
		name string
		call func() error
	}{
		{
			name: "applications",
			call: func() error {
				req := connect.NewRequest(&paprikav1.QueryApplicationsRequest{})
				req.Header().Set("Authorization", authorization)
				_, callErr := client.QueryApplications(context.Background(), req)
				return callErr
			},
		},
		{
			name: "map",
			call: func() error {
				req := connect.NewRequest(&paprikav1.QueryFleetMapRequest{})
				req.Header().Set("Authorization", authorization)
				_, callErr := client.QueryFleetMap(context.Background(), req)
				return callErr
			},
		},
		{
			name: "matrix",
			call: func() error {
				req := connect.NewRequest(&paprikav1.QueryFleetMatrixRequest{})
				req.Header().Set("Authorization", authorization)
				_, callErr := client.QueryFleetMatrix(context.Background(), req)
				return callErr
			},
		},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, tc.call())
		})
	}
	assert.Equal(t, 3, service.fleetCalls)

	_, err = client.QueryApplications(
		context.Background(),
		connect.NewRequest(&paprikav1.QueryApplicationsRequest{}),
	)
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	assert.Equal(t, 3, service.fleetCalls, "authentication must still precede the fleet handler")

	listReq := connect.NewRequest(&paprikav1.ListApplicationsRequest{})
	listReq.Header().Set("Authorization", authorization)
	_, err = client.ListApplications(context.Background(), listReq)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	assert.Zero(t, service.legacyCalls, "the bypass must be limited to fleet project-set queries")
}

type fleetAuthTestService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	t           *testing.T
	fleetCalls  int
	legacyCalls int
}

func (s *fleetAuthTestService) QueryApplications(
	ctx context.Context,
	_ *connect.Request[paprikav1.QueryApplicationsRequest],
) (*connect.Response[paprikav1.QueryApplicationsResponse], error) {
	s.requirePrincipal(ctx)
	s.fleetCalls++
	return connect.NewResponse(&paprikav1.QueryApplicationsResponse{}), nil
}

func (s *fleetAuthTestService) QueryFleetMap(
	ctx context.Context,
	_ *connect.Request[paprikav1.QueryFleetMapRequest],
) (*connect.Response[paprikav1.QueryFleetMapResponse], error) {
	s.requirePrincipal(ctx)
	s.fleetCalls++
	return connect.NewResponse(&paprikav1.QueryFleetMapResponse{}), nil
}

func (s *fleetAuthTestService) QueryFleetMatrix(
	ctx context.Context,
	_ *connect.Request[paprikav1.QueryFleetMatrixRequest],
) (*connect.Response[paprikav1.QueryFleetMatrixResponse], error) {
	s.requirePrincipal(ctx)
	s.fleetCalls++
	return connect.NewResponse(&paprikav1.QueryFleetMatrixResponse{}), nil
}

func (s *fleetAuthTestService) ListApplications(
	context.Context,
	*connect.Request[paprikav1.ListApplicationsRequest],
) (*connect.Response[paprikav1.ListApplicationsResponse], error) {
	s.legacyCalls++
	return connect.NewResponse(&paprikav1.ListApplicationsResponse{}), nil
}

func (s *fleetAuthTestService) requirePrincipal(ctx context.Context) {
	s.t.Helper()
	principal := PrincipalFromContext(ctx)
	require.NotNil(s.t, principal)
	assert.Equal(s.t, testUsername, principal.Subject)
}

func TestStringSlice(t *testing.T) {
	t.Parallel()
	assert.Equal(t, []string{"a", "b"}, stringSlice([]interface{}{"a", "b"}))
	assert.Equal(t, []string{"x"}, stringSlice("x"))
	assert.Equal(t, []string{"a", "b"}, stringSlice([]string{"a", "b"}))
}

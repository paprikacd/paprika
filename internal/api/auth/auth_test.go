package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

const (
	testPassword = "secret"
	testUsername = "admin"
	testNS       = "default"
)

func TestPrincipal_IsInGroup(t *testing.T) {
	p := &Principal{Groups: []string{"admin", "dev"}}
	assert.True(t, p.IsInGroup("admin"))
	assert.False(t, p.IsInGroup("ops"))
}

func TestPrincipal_HasScope(t *testing.T) {
	p := &Principal{Claims: map[string]interface{}{
		"role":  "admin",
		"roles": []interface{}{"read", "write"},
	}}
	assert.True(t, p.HasScope("role", "admin"))
	assert.True(t, p.HasScope("roles", "write"))
	assert.False(t, p.HasScope("role", "user"))
}

func TestPrincipalContext(t *testing.T) {
	ctx := context.Background()
	assert.Nil(t, PrincipalFromContext(ctx))

	p := &Principal{Subject: "user-1"}
	ctx = WithPrincipal(ctx, p)
	assert.Equal(t, p, PrincipalFromContext(ctx))
}

func TestBasicAuthenticator(t *testing.T) {
	h := sha256.Sum256([]byte(testPassword))
	authn, err := NewBasicAuthenticator(BasicAuthConfig{
		Username:     testUsername,
		PasswordHash: hex.EncodeToString(h[:]),
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
	_, err := NewBasicAuthenticator(BasicAuthConfig{Password: "x"})
	assert.Error(t, err)
}

func TestMultiAuthenticator(t *testing.T) {
	h := sha256.Sum256([]byte(testPassword))
	basic, _ := NewBasicAuthenticator(BasicAuthConfig{
		Username:     testUsername,
		PasswordHash: hex.EncodeToString(h[:]),
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
	require.NoError(t, authz.Authorize(context.Background(), admin, ActionWrite, ResourceApplications, "prod"))

	reader := &Principal{Subject: "bob", Groups: []string{"readers"}}
	require.NoError(t, authz.Authorize(context.Background(), reader, ActionRead, ResourceApplications, testNS))
	assert.Error(t, authz.Authorize(context.Background(), reader, ActionWrite, ResourceApplications, testNS))
	assert.Error(t, authz.Authorize(context.Background(), reader, ActionRead, ResourceApplications, "prod"))

	unknown := &Principal{Subject: "eve"}
	assert.Error(t, authz.Authorize(context.Background(), unknown, ActionRead, ResourceApplications, testNS))
}

func TestAllowAllAuthorizer(t *testing.T) {
	authz := &AllowAllAuthorizer{}
	assert.NoError(t, authz.Authorize(context.Background(), &Principal{}, ActionAdmin, ResourceApplications, "*"))
}

func TestClassify(t *testing.T) {
	action, resource := classify("/paprika.v1.PaprikaService/ListApplications")
	assert.Equal(t, ActionRead, action)
	assert.Equal(t, ResourceApplications, resource)

	action, resource = classify("/paprika.v1.PaprikaService/SyncApplication")
	assert.Equal(t, ActionWrite, action)
	assert.Equal(t, ResourceApplications, resource)
}

func TestNamespaceFromRequest(t *testing.T) {
	ns := testNS
	req := connect.NewRequest(&paprikav1.ListApplicationsRequest{Namespace: &ns})
	got := namespaceFromRequest(req)
	assert.Equal(t, testNS, got)
}

func TestInterceptor_Disabled(t *testing.T) {
	interceptor, err := Interceptor(Config{Enabled: false})
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
	h := sha256.Sum256([]byte(testPassword))
	interceptor, err := Interceptor(Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username:     testUsername,
			PasswordHash: hex.EncodeToString(h[:]),
		},
	})
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
	interceptor, err := Interceptor(Config{
		Enabled: true,
		BasicAuth: &BasicAuthConfig{
			Username: testUsername,
			Password: testPassword,
		},
	})
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

func TestStringSlice(t *testing.T) {
	assert.Equal(t, []string{"a", "b"}, stringSlice([]interface{}{"a", "b"}))
	assert.Equal(t, []string{"x"}, stringSlice("x"))
	assert.Equal(t, []string{"a", "b"}, stringSlice([]string{"a", "b"}))
}

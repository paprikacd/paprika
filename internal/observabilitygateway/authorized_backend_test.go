package observabilitygateway

import (
	"context"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

type countedClient struct {
	client.Client
	reads atomic.Int32
}

func (c *countedClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	c.reads.Add(1)
	return c.Client.Get(ctx, key, obj, opts...)
}

func TestAuthorizedBackendDeniesBeforeProviderOrSecretRead(t *testing.T) {
	t.Parallel()
	cl := &countedClient{Client: fake.NewClientBuilder().WithScheme(newBackendScheme(t)).Build()}
	b := NewAuthorizedBackend(cl, auth.NewRBACAuthorizer(nil))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "reader", Scopes: []string{"paprika:observe"}})
	_, err := b.Query(ctx, "private/provider", connector.QueryRequest{Query: "up"})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	_, err = b.Explore(ctx, "private/provider", connector.ExploreRequest{Kind: connector.ExploreMetricNames})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Zero(t, cl.reads.Load(), "denied callers must not read provider config or credential Secrets")
}

func TestAuthorizedBackendRejectsMissingPrincipalEvenWithAllowAll(t *testing.T) {
	t.Parallel()
	b := &authorizedBackend{backend: &fakeBackend{}, authorizer: &auth.AllowAllAuthorizer{}}
	_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{})
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	_, err = b.Explore(context.Background(), "obs/prom", connector.ExploreRequest{})
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
	_, err = b.ListProviders(context.Background())
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
}

func TestAuthorizedBackendDeniesCrossNamespaceCredentialBeforeSecretRead(t *testing.T) {
	t.Parallel()
	provider := providerCR("allowed", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Namespace: "private", Name: "creds"}
	})
	cl := &countedClient{Client: fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(provider).Build()}
	rules := []auth.RBACRule{{Subjects: []string{"reader"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"allowed"}}}
	b := NewAuthorizedBackend(cl, auth.NewRBACAuthorizer(rules))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "reader"})
	_, err := b.Query(ctx, "allowed/prom", connector.QueryRequest{Query: "up"})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.EqualValues(t, 1, cl.reads.Load(), "only the allowed provider CR is read; no credential Secret is fetched")
}

func TestAuthorizedBackendFiltersNamespaceAndKeepsQueriesScoped(t *testing.T) {
	t.Parallel()
	inner := &fakeBackend{providers: []ProviderInfo{{Name: "allowed/prom", Namespace: "allowed"}, {Name: "private/prom", Namespace: "private"}}, queryResult: &connector.QueryResult{State: connector.StateOK}}
	b := &authorizedBackend{backend: inner, authorizer: auth.NewRBACAuthorizer([]auth.RBACRule{{Subjects: []string{"reader"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"allowed"}}})}
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "reader"})
	providers, err := b.ListProviders(ctx)
	require.NoError(t, err)
	require.Equal(t, []ProviderInfo{{Name: "allowed/prom", Namespace: "allowed"}}, providers)
	_, err = b.Query(ctx, "allowed/prom", connector.QueryRequest{Query: "up"})
	require.NoError(t, err)
	require.Equal(t, "allowed/prom", inner.lastProvider)
	_, err = b.Query(ctx, "private/prom", connector.QueryRequest{Query: "up"})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Equal(t, "allowed/prom", inner.lastProvider, "denied calls never enter the backend")
}

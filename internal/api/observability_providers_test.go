package apiserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/httpx"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// observabilityProvidersServer builds a server over a fake client holding
// the given provider CRs, authorized against an empty fleet snapshot.
func observabilityProvidersServer(t *testing.T, addr, issuer string, secret []byte, objs ...client.Object) *PaprikaServer {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, observabilityv1alpha1.AddToScheme(scheme))
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()

	snapshot := buildSystemStatusSnapshot(t, 7, nil)
	opts := []ServerOption{WithFleetIndex(&systemStatusReader{snapshot: snapshot})}
	if addr != "" || secret != nil {
		opts = append(opts, WithObservabilityGateway(addr, secret, issuer))
	}
	return NewPaprikaServer(cl, nil, opts...)
}

func prometheusProvider(namespace, name string, discovered bool) *observabilityv1alpha1.ObservabilityProvider {
	labels := map[string]string{}
	if discovered {
		labels[observabilityDiscoveredLabel] = observabilityDiscoveredValue
	}
	return &observabilityv1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name, Labels: labels},
		Spec: observabilityv1alpha1.ObservabilityProviderSpec{
			Type: "prometheus",
			Config: runtime.RawExtension{Raw: []byte(`{
				"endpoint": "https://prometheus.example.test",
				"headers": {"Authorization": "Bearer must-never-leak"}
			}`)},
		},
		Status: observabilityv1alpha1.ObservabilityProviderStatus{
			State:  "OK",
			Reason: "",
			Conditions: []metav1.Condition{{
				Type:               "Ready",
				Status:             metav1.ConditionTrue,
				LastTransitionTime: metav1.NewTime(time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)),
			}},
		},
	}
}

func TestListObservabilityProvidersMapsItems(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil,
		prometheusProvider("obs", "prom", true),
		prometheusProvider("obs", "hand-written", false),
	)

	resp, err := server.ListObservabilityProviders(context.Background(), connect.NewRequest(&paprikav1.ListObservabilityProvidersRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Items, 2)
	assert.Equal(t, uint64(2), resp.Msg.Total)
	assert.Equal(t, uint64(7), resp.Msg.IndexGeneration)

	byName := map[string]*paprikav1.ObservabilityProviderItem{}
	for _, item := range resp.Msg.Items {
		byName[item.Name] = item
	}
	prom := byName["prom"]
	require.NotNil(t, prom)
	assert.Equal(t, "obs", prom.Namespace)
	assert.Equal(t, "prometheus", prom.Type)
	assert.Equal(t, "OK", prom.State)
	assert.True(t, prom.Discovered)
	assert.Equal(t, "https://prometheus.example.test", prom.Endpoint)
	// The connector descriptor advertises metrics only.
	assert.Equal(t, []string{"metrics"}, prom.Signals)
	assert.Equal(t, time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC).UnixMilli(), prom.ObservedAtUnixMs)

	handWritten := byName["hand-written"]
	require.NotNil(t, handWritten)
	assert.False(t, handWritten.Discovered)
}

func TestListObservabilityProvidersExtractsEndpointOnly(t *testing.T) {
	t.Parallel()

	// The opaque config can hold credential material (here an Authorization
	// header). The item must carry the endpoint and nothing else of it.
	server := observabilityProvidersServer(t, "", "", nil, prometheusProvider("obs", "prom", false))
	resp, err := server.ListObservabilityProviders(context.Background(), connect.NewRequest(&paprikav1.ListObservabilityProvidersRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Items, 1)
	assert.NotContains(t, resp.Msg.Items[0].Endpoint, "must-never-leak")
	assert.NotContains(t, resp.Msg.Items[0].Reason, "must-never-leak")
}

func TestListObservabilityProvidersNamespaceFilter(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil,
		prometheusProvider("obs", "prom", false),
		prometheusProvider("other", "prom", false),
	)
	namespace := "obs"
	resp, err := server.ListObservabilityProviders(context.Background(), connect.NewRequest(&paprikav1.ListObservabilityProvidersRequest{Namespace: &namespace}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Items, 1)
	assert.Equal(t, "obs", resp.Msg.Items[0].Namespace)
	assert.Equal(t, uint64(1), resp.Msg.Total)
}

func TestListObservabilityProvidersUnknownTypeReportsNoSignals(t *testing.T) {
	t.Parallel()

	provider := prometheusProvider("obs", "future", false)
	provider.Spec.Type = "clickhouse"
	server := observabilityProvidersServer(t, "", "", nil, provider)

	resp, err := server.ListObservabilityProviders(context.Background(), connect.NewRequest(&paprikav1.ListObservabilityProvidersRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Items, 1)
	assert.Empty(t, resp.Msg.Items[0].Signals)
	assert.NotNil(t, resp.Msg.Items[0].Signals)
}

func TestListObservabilityProvidersNilClientAnswersDegradedShell(t *testing.T) {
	t.Parallel()

	snapshot := buildSystemStatusSnapshot(t, 7, nil)
	server := NewPaprikaServer(nil, nil, WithFleetIndex(&systemStatusReader{snapshot: snapshot}))

	resp, err := server.ListObservabilityProviders(context.Background(), connect.NewRequest(&paprikav1.ListObservabilityProvidersRequest{}))
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.Items)
	assert.NotNil(t, resp.Msg.Items)
	assert.Equal(t, uint64(0), resp.Msg.Total)
	assert.Equal(t, uint64(7), resp.Msg.IndexGeneration)
}

func TestListObservabilityProvidersValidatesNamespace(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	bad := "Not_A_DNS_Label"
	_, err := server.ListObservabilityProviders(context.Background(), connect.NewRequest(&paprikav1.ListObservabilityProvidersRequest{Namespace: &bad}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

var usageTestSecret = []byte("observability-usage-test-secret")

const usageTestIssuer = "https://paprika.example"

// usageGatewayServer stands up the same protection the real gateway mounts:
// the paprika-observability audience authenticator plus a ScopeObserve
// requirement, answering a fixed usage snapshot. It proves the token the
// api-server mints is shaped exactly like the gateway's own OAuth flow
// produces — anything else is rejected here before the handler runs. The
// server speaks h2c (httpx.WithH2C) because the api-server client dials
// cleartext addresses with prior-knowledge HTTP/2 — exactly the production
// pairing; a plain HTTP/1.1 test server would fail the transport, not the
// code under test.
func usageGatewayServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	authenticator, err := auth.NewSelfSignedAuthenticatorForAudience(usageTestSecret, mcp.ObservabilityTokenAudience, usageTestIssuer)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, err := authenticator.Authenticate(auth.WithRequest(r.Context(), r))
		if err != nil {
			http.Error(w, `{"error":"invalid_token"}`, http.StatusUnauthorized)
			return
		}
		observing := false
		for _, scope := range principal.Scopes {
			if scope == string(mcp.ScopeObserve) {
				observing = true
			}
		}
		if !observing {
			http.Error(w, `{"error":"insufficient_scope"}`, http.StatusForbidden)
			return
		}
		handler(w, r)
	}))
	server.Config = httpx.WithH2C(server.Config)
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func TestGetObservabilityUsageNotConfigured(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	resp, err := server.GetObservabilityUsage(context.Background(), connect.NewRequest(&paprikav1.GetObservabilityUsageRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, resp.Msg.State)
	assert.Equal(t, observabilityUsageUnavailableReason, resp.Msg.UnavailableReason)
	assert.Zero(t, resp.Msg.ObservedAtUnixMs)
	assert.Empty(t, resp.Msg.Tools)
	assert.NotNil(t, resp.Msg.Tools)
}

func TestGetObservabilityUsageMapsGatewaySnapshot(t *testing.T) {
	t.Parallel()

	gateway := usageGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		snapshot := observabilitygateway.UsageSnapshot{
			GeneratedAt: time.Date(2026, 10, 12, 13, 0, 0, 0, time.UTC),
			Tools: []observabilitygateway.UsageToolSnapshot{
				{Name: "query_metrics", Calls: 42, Errors: 1, LastUsedAt: time.Now()},
				{Name: "query_logs", Calls: 5, Errors: 0, LastUsedAt: time.Now()},
			},
		}
		_ = json.NewEncoder(w).Encode(snapshot)
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.GetObservabilityUsage(context.Background(), connect.NewRequest(&paprikav1.GetObservabilityUsageRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_OK, resp.Msg.State)
	assert.Empty(t, resp.Msg.UnavailableReason)
	assert.Equal(t, time.Date(2026, 10, 12, 13, 0, 0, 0, time.UTC).UnixMilli(), resp.Msg.ObservedAtUnixMs)
	require.Len(t, resp.Msg.Tools, 2)
	assert.Equal(t, "query_metrics", resp.Msg.Tools[0].Name)
	assert.Equal(t, uint64(42), resp.Msg.Tools[0].Calls)
	assert.Equal(t, uint64(1), resp.Msg.Tools[0].Errors)
}

func TestGetObservabilityUsageGatewayErrorIsSanitized(t *testing.T) {
	t.Parallel()

	gateway := usageGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "internal boom", http.StatusInternalServerError)
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.GetObservabilityUsage(context.Background(), connect.NewRequest(&paprikav1.GetObservabilityUsageRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, resp.Msg.State)
	assert.Equal(t, observabilityUsageErrorReason, resp.Msg.UnavailableReason)
	// The sanitized reason must not echo the gateway address the error came
	// from — it is cluster-internal detail.
	assert.NotContains(t, resp.Msg.UnavailableReason, gateway.URL)
	assert.Empty(t, resp.Msg.Tools)
}

func TestGetObservabilityUsageUnreachableGateway(t *testing.T) {
	t.Parallel()

	gateway := usageGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	// Close before the call so the address is configured but dead.
	gateway.Close()
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.GetObservabilityUsage(context.Background(), connect.NewRequest(&paprikav1.GetObservabilityUsageRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, resp.Msg.State)
	assert.Equal(t, observabilityUsageErrorReason, resp.Msg.UnavailableReason)
}

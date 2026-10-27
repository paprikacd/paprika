package observabilitygateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

const recordFixture = `{"columns":[{"key":"name","type":"string"},{"key":"value","type":"number"}],"rows":[["service",12.5],["waiting",null]],"truncated":true}`
const recordsDashboardQuery = `{"provider":"allowed/uptime","signal":"records","query":"{\"operation\":\"services\"}","start":"2026-10-25T00:00:00Z","end":"2026-10-25T01:00:00Z"}`

func TestRecordsMCPContractAndInvalidFrame(t *testing.T) {
	t.Parallel()
	backend := &fakeBackend{queryResult: &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(recordFixture)}}
	registry := newRegisteredTools(t, backend)
	tool, ok := registry.Lookup("query_records")
	require.True(t, ok)
	require.Equal(t, mcp.ScopeObserve, tool.Scope)
	result, err := invokeTool(t, registry, "query_records", `{"provider":"allowed/app","query":"SELECT 1 AS value","limit":2}`)
	require.NoError(t, err)
	preview, ok := result.(*sdkmcp.CallToolResult)
	require.True(t, ok)
	require.False(t, preview.IsError)
	encoded, marshalErr := json.Marshal(preview.StructuredContent)
	require.NoError(t, marshalErr)
	require.Contains(t, string(encoded), `"signal":"records"`)
	require.Contains(t, string(encoded), `"truncated":true`)
	require.Equal(t, connector.SignalRecords, backend.lastReq.Signal)
	require.Equal(t, 2, backend.lastReq.Limit)
	backend.queryResult = &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(`{"columns":[{"key":"secret","type":"string"}],"rows":[[{"nested":"hidden"}]]}`)}
	result, err = invokeTool(t, registry, "query_records", `{"provider":"allowed/app","query":"SELECT 1 AS value"}`)
	require.NoError(t, err)
	preview, ok = result.(*sdkmcp.CallToolResult)
	require.True(t, ok)
	require.True(t, preview.IsError)
	encoded, marshalErr = json.Marshal(preview.StructuredContent)
	require.NoError(t, marshalErr)
	require.NotContains(t, string(encoded), "hidden")
	for _, extra := range []string{`"credentials":"token"`, `"config":{}`, `"instant":true`, `"page_token":"token"`, `"limit":1001`} {
		_, err = invokeTool(t, registry, "query_records", `{"provider":"allowed/app","query":"SELECT 1 AS value",`+extra+`}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
}

func TestRecordsDashboardAndMCPUseAuthorizedUptimeProvider(t *testing.T) {
	t.Parallel()
	const org = "82bbc22b-0279-4f27-a404-bf30f96aee7d"
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/uptimeapi.v1.ServiceService/ListServices", r.URL.Path)
		require.Equal(t, "Bearer fixture-token", r.Header.Get("Authorization"))
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, org, body["orgId"])
		w.Header().Set("Content-Type", "application/json")
		_, writeErr := w.Write([]byte(`{"services":[{"id":"service-1","name":"Checkout","slug":"checkout"}]}`))
		require.NoError(t, writeErr)
	}))
	defer provider.Close()
	configJSON, err := json.Marshal(map[string]any{"endpoint": provider.URL, "orgId": org})
	require.NoError(t, err)
	cr := providerCR("allowed", "uptime", connector.ProviderUptime, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.Config.Raw = configJSON
		cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "uptime-credentials"}
	})
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "uptime-credentials", Namespace: "allowed", Labels: map[string]string{"observability.paprika.io/credentials": "true"}}, Data: map[string][]byte{"credentials": []byte("fixture-token")}}
	backend := NewAuthorizedBackend(fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(cr, secret).Build(), dashboardTestAuthorizer())
	mux, tokenSecret := dashboardTestMux(t, backend)
	token := catalogTestToken(t, tokenSecret, string(mcp.ScopeObserve))
	rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", token, recordsDashboardQuery)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var response DashboardQueryResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Equal(t, connector.StateOK, response.State)
	frame, frameErr := dataframe.Decode(response.Data)
	require.NoError(t, frameErr)
	require.Equal(t, [][]any{{"service-1", "Checkout", "checkout"}}, frame.Rows)
	tool := queryRecordsTool(backend)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "test-user"})
	_, err = tool.Invoke(ctx, nil, json.RawMessage(`{"provider":"allowed/uptime","query":"{\"operation\":\"services\"}"}`))
	require.NoError(t, err)
	require.EqualValues(t, 2, calls.Load())
	denied := strings.Replace(recordsDashboardQuery, "allowed/uptime", "private/uptime", 1)
	require.Equal(t, http.StatusForbidden, doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", token, denied).Code)
	require.Equal(t, http.StatusUnauthorized, doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", "", recordsDashboardQuery).Code)
	require.Equal(t, http.StatusForbidden, doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", catalogTestToken(t, tokenSecret, string(mcp.ScopeRead)), recordsDashboardQuery).Code)
	require.EqualValues(t, 2, calls.Load(), "denial must happen before credentialed backend access")
}

func TestApplicationProviderCatalogAndProbes(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{connector.ProviderShorted, connector.ProviderUptime, connector.ProviderPostgreSQL} {
		entry, ok := catalog.Get(kind)
		require.True(t, ok)
		conn, err := New(kind)
		require.NoError(t, err)
		require.ElementsMatch(t, entry.Signals, conn.Descriptor().Signals)
		require.Equal(t, connector.SignalRecords, entry.Probe.Signal)
		require.NotEmpty(t, probeQuery(kind))
	}
	require.JSONEq(t, `{"operation":"services","args":{"limit":1}}`, probeQuery(connector.ProviderUptime))
	require.JSONEq(t, `{"operation":"top_shorts","args":{"limit":1}}`, probeQuery(connector.ProviderShorted))
	require.Equal(t, "SELECT 1 AS value", probeQuery(connector.ProviderPostgreSQL))
}

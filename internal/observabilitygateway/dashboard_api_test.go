package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

const dashboardTestQuery = `{"provider":"allowed/prom","signal":"metrics","query":"up","start":"2026-10-25T00:00:00Z","end":"2026-10-25T01:00:00Z","stepSeconds":15.5}`

func dashboardTestMux(t *testing.T, backend Backend) (*http.ServeMux, []byte) {
	t.Helper()
	secret := []byte("dashboard-test-secret")
	authenticator, err := auth.NewSelfSignedAuthenticatorForAudience(secret, mcp.ObservabilityTokenAudience, catalogTestIssuer)
	require.NoError(t, err)
	protect := RequireObserveScope(authenticator, catalogTestIssuer, "/observe")
	mux := http.NewServeMux()
	mux.Handle("GET /observe/api/providers", protect(DashboardProvidersHandler(backend, nil)))
	mux.Handle("POST /observe/api/query", protect(DashboardQueryHandler(backend, nil)))
	mux.Handle("POST /observe/api/explore", protect(DashboardExploreHandler(backend, nil)))
	return mux, secret
}

func dashboardTestAuthorizer() auth.Authorizer {
	return auth.NewRBACAuthorizer([]auth.RBACRule{{Subjects: []string{"test-user"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"allowed"}}})
}

func TestDashboardAPIAuthenticatesAndFiltersProviders(t *testing.T) {
	t.Parallel()
	cl := &countedClient{Client: fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(
		providerCR("allowed", "prom", connector.ProviderPrometheus, nil),
		providerCR("private", "prom", connector.ProviderPrometheus, nil),
	).Build()}
	mux, secret := dashboardTestMux(t, NewAuthorizedBackend(cl, dashboardTestAuthorizer()))
	token := catalogTestToken(t, secret, string(mcp.ScopeObserve))
	for _, endpoint := range []struct{ method, path, body string }{
		{http.MethodGet, "/observe/api/providers", ""},
		{http.MethodPost, "/observe/api/query", dashboardTestQuery},
		{http.MethodPost, "/observe/api/explore", `{"provider":"allowed/prom","kind":"label_names"}`},
	} {
		require.Equal(t, http.StatusUnauthorized, doCatalogRequest(t, mux, endpoint.method, endpoint.path, "", endpoint.body).Code)
		require.Equal(t, http.StatusForbidden, doCatalogRequest(t, mux, endpoint.method, endpoint.path, catalogTestToken(t, secret, string(mcp.ScopeRead)), endpoint.body).Code)
	}
	rec := doCatalogRequest(t, mux, http.MethodGet, "/observe/api/providers", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var providers DashboardProvidersResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &providers))
	require.Equal(t, []ProviderInfo{{Name: "allowed/prom", Namespace: "allowed", Type: connector.ProviderPrometheus}}, providers.Providers)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	for _, endpoint := range []struct{ path, body string }{
		{"/observe/api/query", strings.Replace(dashboardTestQuery, "allowed/prom", "private/prom", 1)},
		{"/observe/api/explore", `{"provider":"private/prom","kind":"label_names"}`},
	} {
		rec := doCatalogRequest(t, mux, http.MethodPost, endpoint.path, token, endpoint.body)
		require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	}
	require.Zero(t, cl.reads.Load(), "authorization must reject before provider/credential reads")
}

func TestDashboardAPIAndMCPShareProviderQueries(t *testing.T) {
	t.Parallel()
	var rangeCalls, instantCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, `up{service="api"}`, r.URL.Query().Get("query"))
		switch r.URL.Path {
		case "/api/v1/query_range":
			rangeCalls.Add(1)
			require.Equal(t, "15.5", r.URL.Query().Get("step"))
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1792886400,"2.50"]]}]}}`))
		case "/api/v1/query":
			instantCalls.Add(1)
			require.NotEmpty(t, r.URL.Query().Get("time"))
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer provider.Close()
	cr := providerCR("allowed", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.Config.Raw = json.RawMessage(fmt.Sprintf(`{"endpoint":%q,"step":"1m"}`, provider.URL))
	})
	backend := NewAuthorizedBackend(fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(cr).Build(), dashboardTestAuthorizer())
	mux, secret := dashboardTestMux(t, backend)
	token := catalogTestToken(t, secret, string(mcp.ScopeObserve))
	query := strings.Replace(dashboardTestQuery, `"query":"up"`, `"query":"up{service=\"api\"}"`, 1)
	rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", token, query)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var response DashboardQueryResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Equal(t, connector.StateOK, response.State)
	reg := newRegisteredTools(t, backend)
	tool, ok := reg.Lookup("query_metrics")
	require.True(t, ok)
	ctx := auth.WithPrincipal(t.Context(), &auth.Principal{Subject: "test-user"})
	result, err := tool.Invoke(ctx, nil, json.RawMessage(strings.Replace(query, "stepSeconds", "step_seconds", 1)))
	require.NoError(t, err)
	require.NotNil(t, result)
	require.EqualValues(t, 2, rangeCalls.Load(), "REST and MCP both use the same provider and precise request step")
	instant := strings.TrimSuffix(query, "}") + `,"instant":true}`
	rec = doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", token, instant)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.EqualValues(t, 1, instantCalls.Load())
}

func TestDashboardAPIRejectsInvalidOrInjectedRequests(t *testing.T) {
	t.Parallel()
	invalid := []string{
		`null`, `[]`, dashboardTestQuery + `{}`,
		strings.TrimSuffix(dashboardTestQuery, "}") + `,"credentials":"secret"}`,
		strings.TrimSuffix(dashboardTestQuery, "}") + `,"config":{"endpoint":"http://private"}}`,
		strings.Replace(dashboardTestQuery, "allowed/prom", "allowed/prom/more", 1),
		strings.Replace(dashboardTestQuery, "metrics", "anything", 1),
		strings.Replace(dashboardTestQuery, "15.5", "0.1", 1),
		strings.Replace(dashboardTestQuery, "15.5", "-1", 1),
		strings.Replace(dashboardTestQuery, "2026-10-25T01:00:00Z", "2026-12-01T00:00:00Z", 1),
		strings.Replace(dashboardTestQuery, `"query":"up"`, `"query":"`+strings.Repeat("x", maxQueryBytes+1)+`"`, 1),
		strings.TrimSuffix(dashboardTestQuery, "}") + `,"limit":1001}`,
		strings.TrimSuffix(dashboardTestQuery, "}") + `,"limit":1.5}`,
		strings.Repeat(" ", dashboardBodyLimit) + dashboardTestQuery,
	}
	for i, body := range invalid {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			backend := &fakeBackend{}
			mux, secret := dashboardTestMux(t, backend)
			rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", catalogTestToken(t, secret, string(mcp.ScopeObserve)), body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			require.Empty(t, backend.lastProvider)
			require.NotContains(t, rec.Body.String(), "secret")
		})
	}
}

func TestDashboardAPIErrorStatesAndSanitization(t *testing.T) {
	t.Parallel()
	for _, state := range []connector.State{connector.StateNotConfigured, connector.StateNotAvailable, connector.StateForbidden, connector.StateError} {
		t.Run(string(state), func(t *testing.T) {
			mux, secret := dashboardTestMux(t, &fakeBackend{queryResult: &connector.QueryResult{State: state, Reason: "fixed reason"}})
			rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", catalogTestToken(t, secret, string(mcp.ScopeObserve)), dashboardTestQuery)
			require.Equal(t, http.StatusOK, rec.Code)
			var result DashboardQueryResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
			require.Equal(t, state, result.State)
			require.Equal(t, "fixed reason", result.Reason)
		})
	}
	for code, status := range map[connect.Code]int{
		connect.CodeInternal: 502, connect.CodePermissionDenied: 403, connect.CodeNotFound: 404,
		connect.CodeDeadlineExceeded: 504, connect.CodeResourceExhausted: 429, connect.CodeCanceled: 408,
	} {
		t.Run(code.String(), func(t *testing.T) {
			backend := &fakeBackend{queryErr: connect.NewError(code, errors.New("secret provider URL https://admin:password@provider"))}
			mux, secret := dashboardTestMux(t, backend)
			rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/query", catalogTestToken(t, secret, string(mcp.ScopeObserve)), dashboardTestQuery)
			require.Equal(t, status, rec.Code)
			require.NotContains(t, rec.Body.String(), "password")
			require.NotContains(t, rec.Body.String(), "secret")
		})
	}
}

func TestDashboardAPIExploreBoundsAndSeriesTruncation(t *testing.T) {
	t.Parallel()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/v1/series", r.URL.Path)
		require.Equal(t, "up", r.URL.Query().Get("match[]"))
		require.Equal(t, "3", r.URL.Query().Get("limit"))
		require.NotEmpty(t, r.URL.Query().Get("start"))
		require.NotEmpty(t, r.URL.Query().Get("end"))
		_, _ = w.Write([]byte(`{"status":"success","data":[{"service":"a"},{"service":"b"},{"service":"c"}],"warnings":["partial response"]}`))
	}))
	defer provider.Close()
	cr := providerCR("allowed", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.Config.Raw = json.RawMessage(fmt.Sprintf(`{"endpoint":%q}`, provider.URL))
	})
	backend := NewAuthorizedBackend(fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(cr).Build(), dashboardTestAuthorizer())
	mux, secret := dashboardTestMux(t, backend)
	token := catalogTestToken(t, secret, string(mcp.ScopeObserve))
	rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/explore", token, `{"provider":"allowed/prom","kind":"metric_series","metric":"up","limit":2}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var result DashboardExploreResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	require.Equal(t, connector.StateOK, result.State)
	require.JSONEq(t, `{"status":"success","data":[{"service":"a"},{"service":"b"}],"truncated":true,"warnings":["partial response"]}`, string(result.Data))
	for _, body := range []string{
		`{"provider":"allowed/prom","kind":"made_up"}`,
		`{"provider":"allowed/prom","kind":"metric_series"}`,
		`{"provider":"allowed/prom","kind":"label_values"}`,
		`{"provider":"allowed/prom","kind":"metric_names","limit":1001}`,
		`{"provider":"allowed/prom","kind":"metric_names","params":{"namespace":"` + strings.Repeat("x", 4097) + `"}}`,
	} {
		rec := doCatalogRequest(t, mux, http.MethodPost, "/observe/api/explore", token, body)
		require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestDashboardQuerySupports31DaysAndBoundsSamples(t *testing.T) {
	t.Parallel()
	input := DashboardQueryRequest{Provider: "allowed/prom", Signal: connector.SignalMetrics, Query: "up", Start: time.Now().Add(-maxQueryWindow), End: time.Now(), StepSeconds: 900}
	input.End = input.Start.Add(maxQueryWindow)
	req, err := input.connectorRequest()
	require.NoError(t, err)
	require.Equal(t, 15*time.Minute, req.Step)
	input.StepSeconds = 1
	_, err = input.connectorRequest()
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	input.End = input.Start.Add(maxQueryWindow + time.Second)
	_, err = input.connectorRequest()
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

type cancelDashboardBackend struct{ fakeBackend }

func (b *cancelDashboardBackend) Query(ctx context.Context, _ string, _ connector.QueryRequest) (*connector.QueryResult, error) {
	<-ctx.Done()
	return nil, contextError(ctx)
}

func TestDashboardQueryPropagatesCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	rec := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/observe/api/query", strings.NewReader(dashboardTestQuery))
	DashboardQueryHandler(&cancelDashboardBackend{}, nil).ServeHTTP(rec, request)
	require.Equal(t, http.StatusRequestTimeout, rec.Code)
}

package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func observeTestService(t *testing.T, gateway string, local ...ProviderConfig) *Server {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewServer(Config{Token: testToken, ObservabilityURL: gateway, Providers: local}, store)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func observeHeaders(token string) map[string]string {
	return map[string]string{observeTokenHeader: token}
}

func observeQueryBody(t *testing.T, reference, kind string) []byte {
	t.Helper()
	query := "up{service=\"api\"}"
	if kind == "traces" {
		query = "{ resource.service.name = \"api\" }"
	}
	return savedQueryJSON(t, Query{ProviderID: observeProviderID(reference), Kind: kind, Query: query, Start: 1700000000.25, End: 1700000600.75, Step: 1.25})
}

func TestObserveProvidersCallerIsolationAndSavedQueryPersistence(t *testing.T) {
	var catalogCalls, queryCalls atomic.Int32
	var revoked atomic.Bool
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token != "alice" && token != "bob" {
			t.Errorf("gateway received a service token or unexpected caller: %q", token)
			http.Error(w, "private gateway error", http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/observe/api/providers":
			catalogCalls.Add(1)
			providers := []observeCatalogProvider{{Name: "team-b/metrics", Namespace: "team-b", Type: "prometheus"}}
			if token == "alice" && !revoked.Load() {
				providers = append(providers, observeCatalogProvider{Name: "team-a/metrics", Namespace: "team-a", Type: "prometheus"}, observeCatalogProvider{Name: "team-a/traces", Namespace: "team-a", Type: "tempo"}, observeCatalogProvider{Name: "team-a/logs", Namespace: "team-a", Type: "loki"})
			}
			writeJSON(w, 200, map[string]any{"providers": providers})
		case "/observe/api/query":
			queryCalls.Add(1)
			var query map[string]any
			if json.NewDecoder(r.Body).Decode(&query) != nil {
				t.Error("invalid gateway query")
			}
			assert.False(t, query["provider"] != "team-a/metrics", "wrong query contract: %+v", query)
			assert.False(t, query["signal"] != "metrics", "wrong query contract: %+v", query)
			assert.False(t, query["stepSeconds"] != 1.25, "wrong query contract: %+v", query)
			assert.False(t, query["query"] != "up{service=\"api\"}", "wrong query contract: %+v", query)
			assert.False(t, query["start"] != "2023-11-14T22:13:20.25Z", "wrong query contract: %+v", query)
			assert.False(t, query["end"] != "2023-11-14T22:23:20.75Z", "wrong query contract: %+v", query)
			assert.False(t, query["limit"] != float64(maxSeries), "wrong query contract: %+v", query)
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1700000000.25,"4.25"],[1700000001.5,"NaN"]]}]}}`)})
		default:
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL, ProviderConfig{ID: "local", Name: "Local", Type: "prometheus", URL: "http://local.invalid"})
	h := s.Handler()
	w := request(t, h, "GET", "/api/providers", nil, observeHeaders("alice"))
	var listing struct{ Providers []Provider }
	require.False(t, w.Code != 200, "catalog: %d %s", w.Code, w.Body)
	require.False(t, json.Unmarshal(w.Body.Bytes(), &listing) != nil, "catalog: %d %s", w.Code, w.Body)
	require.False(t, len(listing.Providers) != 4, "catalog: %d %s", w.Code, w.Body)
	for _, p := range listing.Providers {
		if p.ID == "local" {
			continue
		}
		require.False(t, !validID.MatchString(p.ID), "shared public provider: %+v", p)
		require.False(t, len(p.ID) != 72, "shared public provider: %+v", p)
		require.False(t, p.Source != "observability", "shared public provider: %+v", p)
		require.False(t, p.ProviderRef != p.Name, "shared public provider: %+v", p)
		require.False(t, p.Managed, "shared public provider: %+v", p)
	}
	if observeProviderID("team-a/metrics") == observeProviderID("team-b/metrics") || observeProviderID("a-b/c") == observeProviderID("a/b-c") {
		t.Fatal("namespace identities collided")
	}
	w = request(t, h, "GET", "/api/providers", nil, observeHeaders("bob"))
	require.False(t, w.Code != 200, "caller leaked through catalog cache: %d %s", w.Code, w.Body)
	require.False(t, strings.Contains(w.Body.String(), "team-a"), "caller leaked through catalog cache: %d %s", w.Code, w.Body)
	w = request(t, h, "POST", "/api/query", observeQueryBody(t, "team-a/metrics", "metrics"), observeHeaders("alice"))
	var result QueryResult
	require.False(t, w.Code != 200, "normalized query: %d %s", w.Code, w.Body)
	require.False(t, json.Unmarshal(w.Body.Bytes(), &result) != nil, "normalized query: %d %s", w.Code, w.Body)
	require.False(t, len(result.Series) != 1, "normalized query: %d %s", w.Code, w.Body)
	require.False(t, len(result.Series[0].Points) != 2, "normalized query: %d %s", w.Code, w.Body)
	require.False(t, result.Series[0].Points[0].Timestamp != 1700000000250, "normalized query: %d %s", w.Code, w.Body)
	require.False(t, *result.Series[0].Points[0].Value != 4.25, "normalized query: %d %s", w.Code, w.Body)
	require.False(t, result.Series[0].Points[1].Value != nil, "normalized query: %d %s", w.Code, w.Body)
	document := savedQueryDocument("shared-query")
	document["providerId"] = observeProviderID("team-a/metrics")
	headers := observeHeaders("alice")
	headers["If-None-Match"] = "*"
	w = request(t, h, "PUT", "/api/saved-queries/shared-query", savedQueryJSON(t, document), headers)
	require.False(t, w.Code != 200, "save shared query: %d %s", w.Code, w.Body)
	tag := w.Header().Get("ETag")
	restarted, err := NewServer(Config{Token: testToken, ObservabilityURL: gateway.URL}, s.store)
	if err != nil {
		t.Fatal(err)
	}
	w = request(t, restarted.Handler(), "GET", "/api/saved-queries/shared-query", nil, observeHeaders("alice"))
	require.False(t, w.Code != 200, "persisted remote identity: %d %s", w.Code, w.Body)
	require.False(t, !strings.Contains(w.Body.String(), observeProviderID("team-a/metrics")), "persisted remote identity: %d %s", w.Code, w.Body)
	files, err := os.ReadDir(filepath.Join(s.store.dir, "providers"))
	require.False(t, err != nil, "remote provider configuration must never be persisted: %v %+v", err, files)
	require.False(t, len(files) != 0, "remote provider configuration must never be persisted: %v %+v", err, files)
	w = request(t, h, "GET", "/api/provider-configs", nil, observeHeaders("alice"))
	require.False(t, w.Code != 200, "remote config/token leaked: %d %s", w.Code, w.Body)
	require.False(t, strings.Contains(w.Body.String(), "team-a"), "remote config/token leaked: %d %s", w.Code, w.Body)
	require.False(t, strings.Contains(w.Body.String(), "alice"), "remote config/token leaked: %d %s", w.Code, w.Body)
	// Revocation takes effect even for an already-persisted saved query.
	revoked.Store(true)
	w = request(t, h, "POST", "/api/query", observeQueryBody(t, "team-a/metrics", "metrics"), observeHeaders("alice"))
	require.False(t, w.Code != 404, "revoked provider executed: %d, calls %d", w.Code, queryCalls.Load())
	require.False(t, queryCalls.Load() != 1, "revoked provider executed: %d, calls %d", w.Code, queryCalls.Load())
	headers = observeHeaders("alice")
	headers["If-Match"] = tag
	w = request(t, h, "PUT", "/api/saved-queries/shared-query", savedQueryJSON(t, document), headers)
	require.False(t, w.Code != 400, "revoked provider saved: %d %s", w.Code, w.Body)
	before := catalogCalls.Load()
	for _, path := range []string{"/api/providers", "/api/providers/" + observeProviderID("team-b/metrics") + "/metadata?kind=metrics"} {
		w = request(t, h, "GET", path, nil, nil)
		require.False(t, w.Code != 403, "missing caller %s: %d %s", path, w.Code, w.Body)
	}
	if catalogCalls.Load() != before {
		t.Fatal("missing delegation fell back to a service identity")
	}
}

func TestObserveMetadataTracesAndConnection(t *testing.T) {
	var exploreCalls atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/observe/api/providers" {
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}, {Name: "prod/tempo", Namespace: "prod", Type: "tempo"}}})
			return
		}
		var input map[string]any
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("invalid request body")
		}
		if r.URL.Path == "/observe/api/query" {
			assert.False(t, input["provider"] != "prod/tempo", "bad trace request %+v", input)
			assert.False(t, input["signal"] != "traces", "bad trace request %+v", input)
			assert.False(t, input["limit"] != float64(maxTraces), "bad trace request %+v", input)
			assert.False(t, input["stepSeconds"] != nil, "bad trace request %+v", input)
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"traces":[{"traceID":"abc","rootServiceName":"api","rootTraceName":"GET /","startTimeUnixNano":"1700000000123000000","durationMs":12.25}]}`)})
			return
		}
		exploreCalls.Add(1)
		assert.False(t, input["limit"] != float64(maxMetadataValues), "unbounded explore: %+v", input)
		assert.False(t, input["start"] == nil, "unbounded explore: %+v", input)
		assert.False(t, input["end"] == nil, "unbounded explore: %+v", input)
		var data any
		if input["provider"] == "prod/tempo" {
			if input["kind"] == "label_values" {
				assert.False(t, input["label"] != "resource.service.name", "wrong trace tag %+v", input)
				data = map[string]any{"tagValues": []string{"api", "worker"}, "truncated": true}
			} else {
				data = map[string]any{"tagNames": []string{"resource.service.name"}}
			}
		} else {
			switch input["kind"] {
			case "metric_names":
				data = map[string]any{"status": "success", "data": []string{"up", "requests_total"}}
			case "label_names":
				data = map[string]any{"status": "success", "data": []string{"service"}}
			case "label_values":
				assert.False(t, input["metric"] != "up", "wrong label filter: %+v", input)
				assert.False(t, input["label"] != "service", "wrong label filter: %+v", input)
				data = map[string]any{"status": "success", "data": []string{strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")}}
			case "metric_series":
				assert.False(t, input["metric"] != "up", "missing metric filter: %+v", input)
				data = json.RawMessage(`{"status":"success","truncated":true,"data":[{"__name__":"up","service":"api","instance":"one"},{"__name__":"up","service":"api","instance":"two"},{"__name__":"up","service":"api","instance":"two"}]}`)
			default:
				t.Errorf("unexpected explore %+v", input)
			}
		}
		writeJSON(w, 200, map[string]any{"state": "OK", "data": data})
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	h := s.Handler()
	base := "/api/providers/" + observeProviderID("prod/prom")
	for _, kind := range []string{"metrics", "labels", "values&metric=up&label=service", "series&metric=up"} {
		w := request(t, h, "GET", base+"/metadata?kind="+kind, nil, observeHeaders("alice"))
		var result MetadataResult
		require.False(t, w.Code != 200, "metadata %s: %d %s", kind, w.Code, w.Body)
		require.False(t, json.Unmarshal(w.Body.Bytes(), &result) != nil, "metadata %s: %d %s", kind, w.Code, w.Body)
		require.False(t, strings.HasPrefix(kind, "series") && (result.Series == nil || result.Series.Count != 2 || !result.Series.Truncated || len(result.Series.Labels) != 2 || result.Series.Labels[0].Cardinality != 2), "bounded cardinality: %+v", result.Series)
	}
	for _, token := range []string{"alice", "bob"} {
		w := request(t, h, "GET", base+"/metadata?kind=values&metric=up&label=service", nil, observeHeaders(token))
		require.False(t, w.Code != 200, "metadata cache crossed callers: %s %d %s", token, w.Code, w.Body)
		require.False(t, !strings.Contains(w.Body.String(), token), "metadata cache crossed callers: %s %d %s", token, w.Code, w.Body)
	}
	base = "/api/providers/" + observeProviderID("prod/tempo")
	w := request(t, h, "GET", base+"/metadata?kind=values&label=resource.service.name", nil, observeHeaders("alice"))
	require.False(t, w.Code != 200, "Tempo tags: %d %s", w.Code, w.Body)
	require.False(t, !strings.Contains(w.Body.String(), `"truncated":true`), "Tempo tags: %d %s", w.Code, w.Body)
	for _, reference := range []string{"prod/prom", "prod/tempo"} {
		w = request(t, h, "POST", "/api/providers/"+observeProviderID(reference)+"/test", nil, observeHeaders("alice"))
		require.False(t, w.Code != 200, "connection %s: %d %s", reference, w.Code, w.Body)
		require.False(t, !strings.Contains(w.Body.String(), `"ok":true`), "connection %s: %d %s", reference, w.Code, w.Body)
	}
	w = request(t, h, "POST", "/api/query", observeQueryBody(t, "prod/tempo", "traces"), observeHeaders("alice"))
	var result QueryResult
	require.False(t, w.Code != 200, "trace normalization: %d %s", w.Code, w.Body)
	require.False(t, json.Unmarshal(w.Body.Bytes(), &result) != nil, "trace normalization: %d %s", w.Code, w.Body)
	require.False(t, len(result.Traces) != 1, "trace normalization: %d %s", w.Code, w.Body)
	require.False(t, result.Traces[0].DurationMs != 12.25, "trace normalization: %d %s", w.Code, w.Body)
	require.False(t, result.Traces[0].StartTime != 1700000000123, "trace normalization: %d %s", w.Code, w.Body)
	require.False(t, exploreCalls.Load() != 9, "unexpected exploration count (shared cache?): %d", exploreCalls.Load())
}

func TestObserveFailuresAreNotSuccessfulEmptyResults(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		state  string
		want   int
	}{
		{"caller forbidden", 403, "", 403}, {"expired caller", 401, "", 403}, {"missing provider", 404, "", 404},
		{"busy", 429, "", 429}, {"timeout", 504, "", 504}, {"credential denied", 200, "Forbidden", 403},
		{"not configured", 200, "NotConfigured", 503}, {"not available", 200, "NotAvailable", 503},
		{"failed", 200, "Error", 502}, {"malformed state", 200, "mystery", 502}, {"missing data", 200, "OK", 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/observe/api/providers" {
					writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
					return
				}
				writeJSON(w, tc.status, map[string]any{"state": tc.state, "reason": "https://secret:password@private.invalid"}) //nolint:gosec // G101: deliberately fake credentials verify provider errors are sanitized.
			}))
			defer gateway.Close()
			s := observeTestService(t, gateway.URL)
			w := request(t, s.Handler(), "POST", "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
			if w.Code != tc.want || strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "private.invalid") {
				t.Fatalf("failure mapping: %d %s", w.Code, w.Body)
			}
			if tc.want == 429 && w.Header().Get("Retry-After") != "1" {
				t.Fatal("missing retry hint")
			}
		})
	}
}

func TestObserveProviderIdentityCannotBeShadowed(t *testing.T) {
	s := observeTestService(t, "http://gateway.invalid")
	id := observeProviderID("prod/prom")
	for _, method := range []string{"PUT", "DELETE"} {
		w := request(t, s.Handler(), method, "/api/provider-configs/"+id, providerBody(id, "Shadow", "http://other.invalid"), nil)
		if w.Code != 409 {
			t.Fatalf("%s shared identity: %d %s", method, w.Code, w.Body)
		}
	}
	local := ProviderConfig{ID: id, Name: "Shadow", Type: "prometheus", URL: "http://other.invalid"}
	if _, err := NewServer(Config{Token: testToken, ObservabilityURL: "http://gateway.invalid", Providers: []ProviderConfig{local}}, s.store); err == nil {
		t.Fatal("configured provider shadowed shared identity")
	}
	// With the gateway disabled, the existing local ID space still works.
	if _, err := NewServer(Config{Token: testToken, Providers: []ProviderConfig{local}}, s.store); err != nil {
		t.Fatalf("standalone compatibility: %v", err)
	}
	for _, endpoint := range []string{"file:///secret", "https://user:pass@gateway.invalid", "https://gateway.invalid?token=secret"} {
		if _, err := newObserveGateway(endpoint); err == nil {
			t.Fatalf("unsafe gateway URL accepted: %s", endpoint)
		}
	}
}

func TestObserveGatewayRedirectBoundsAndCancellation(t *testing.T) {
	var leaked atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer target.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, target.URL, http.StatusFound)
		case "/large":
			fmt.Fprint(w, strings.Repeat("x", 129))
		case "/cancel":
			<-r.Context().Done()
		}
	}))
	defer gateway.Close()
	g, err := newObserveGateway(gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/redirect", "/large"} {
		if _, err := g.request(context.Background(), "alice", "GET", path, nil, 128); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	if leaked.Load() != 0 {
		t.Fatal("delegated token followed a redirect")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := g.request(ctx, "alice", "GET", "/cancel", nil, 128); err == nil {
		t.Fatal("cancelled caller completed successfully")
	}
}

func TestObserveNativePartialResultsRemainVisible(t *testing.T) {
	for _, body := range []string{
		`{"status":"success","warnings":["secret backend detail"],"data":{"resultType":"matrix","result":[]}}`,
		`{"status":"success","truncated":true,"data":{"resultType":"matrix","result":[]}}`,
	} {
		result, err := decodePrometheus([]byte(body))
		if err != nil || !result.Truncated {
			t.Fatalf("Prometheus partial marker lost: %+v %v", result, err)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "secret") {
			t.Fatal("provider warning detail leaked")
		}
	}
	for _, body := range []string{
		`{"traces":[],"warnings":["partial backend"]}`,
		`{"traces":[],"truncated":true}`,
		`{"traces":[],"metrics":{"completedJobs":2,"totalJobs":3}}`,
	} {
		result, err := decodeTempo([]byte(body))
		if err != nil || !result.Truncated {
			t.Fatalf("Tempo partial marker lost: %+v %v", result, err)
		}
	}
	result, err := decodeTempo([]byte(`{"traces":[],"metrics":{"inspectedTraces":1000,"completedJobs":3,"totalJobs":3}}`))
	if err != nil || result.Truncated {
		t.Fatalf("inspected traces are not evidence of missing data: %+v %v", result, err)
	}
}

func TestObserveSavedQueryCatalogDoesNotBlockStoreWrites(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	h := s.Handler()
	document := savedQueryDocument("shared-query")
	document["providerId"] = observeProviderID("prod/prom")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodPut, "/api/saved-queries/shared-query", strings.NewReader(string(savedQueryJSON(t, document))))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set(observeTokenHeader, "alice")
	saved := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		h.ServeHTTP(response, req)
		saved <- response
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("saved query did not reach the gateway catalog")
	}
	written := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		written <- request(t, h, http.MethodPut, "/api/dashboards/unrelated", dashboard("unrelated", "Unrelated"), nil)
	}()
	select {
	case response := <-written:
		if response.Code != http.StatusOK {
			t.Fatalf("unrelated dashboard write failed: %d %s", response.Code, response.Body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("gateway catalog request blocked an unrelated dashboard write")
	}
	cancel()
	select {
	case response := <-saved:
		if response.Code != http.StatusBadGateway {
			t.Fatalf("cancelled catalog was persisted: %d %s", response.Code, response.Body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("saved query remained hung after caller cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("caller cancellation did not reach the gateway")
	}
	if _, _, err := s.savedQueries.get("shared-query"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cancelled saved query was persisted: %v", err)
	}
}

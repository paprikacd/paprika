package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testToken = "service-token-with-at-least-32-characters"

func dashboard(id, title string) Dashboard {
	return json.RawMessage(fmt.Sprintf(`{"schemaVersion":1,"id":%q,"title":%q,"timeRange":"1h","refreshInterval":30,"widgets":[{"id":"requests","title":"Requests","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4}}]}`, id, title))
}

func testService(t *testing.T, providers ...ProviderConfig) (*Server, *Store) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewServer(Config{Token: testToken, Providers: providers}, store)
	if err != nil {
		t.Fatal(err)
	}
	return s, store
}

func request(t *testing.T, h http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), method, path, bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestServiceAuthenticationAndHealth(t *testing.T) {
	s, _ := testService(t)
	for _, path := range []string{"/api/providers", "/api/dashboards"} {
		w := request(t, s.Handler(), "GET", path, nil, map[string]string{"Authorization": "Bearer invalid"})
		if w.Code != 401 {
			t.Fatalf("%s returned %d", path, w.Code)
		}
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		w := request(t, s.Handler(), "GET", path, nil, map[string]string{"Authorization": ""})
		if w.Code != 200 {
			t.Fatalf("%s returned %d", path, w.Code)
		}
	}
	if _, err := NewServer(Config{}, s.store); err == nil {
		t.Fatal("missing authentication accepted")
	}
}

func TestDashboardHTTPLifecyclePersistenceAndConflicts(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	w := request(t, h, "PUT", "/api/dashboards/production", dashboard("production", "Production"), map[string]string{"If-None-Match": "*"})
	if w.Code != 200 || w.Header().Get("ETag") == "" {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	initialTag := w.Header().Get("ETag")
	w = request(t, h, "GET", "/api/dashboards/production", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Production") {
		t.Fatalf("get: %d %s", w.Code, w.Body)
	}
	w = request(t, h, "PUT", "/api/dashboards/production", dashboard("production", "Changed"), map[string]string{"If-Match": initialTag})
	if w.Code != 200 {
		t.Fatalf("update: %d %s", w.Code, w.Body)
	}
	w = request(t, h, "PUT", "/api/dashboards/production", dashboard("production", "Stale edit"), map[string]string{"If-Match": initialTag})
	if w.Code != 412 {
		t.Fatalf("stale update: %d", w.Code)
	}
	w = request(t, h, "PUT", "/api/dashboards/production", dashboard("production", "Duplicate"), map[string]string{"If-None-Match": "*"})
	if w.Code != 412 {
		t.Fatalf("duplicate create: %d", w.Code)
	}
	w = request(t, h, "GET", "/api/dashboards", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Changed") {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	reopened, err := OpenStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := reopened.Get("production")
	if err != nil || !strings.Contains(string(doc), "Changed") {
		t.Fatalf("persistence: %s %v", doc, err)
	}
	w = request(t, h, "DELETE", "/api/dashboards/production", nil, map[string]string{"If-Match": initialTag})
	if w.Code != 412 {
		t.Fatalf("stale delete: %d", w.Code)
	}
	w = request(t, h, "DELETE", "/api/dashboards/production", nil, nil)
	if w.Code != 204 {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	w = request(t, h, "GET", "/api/dashboards/production", nil, nil)
	if w.Code != 404 {
		t.Fatalf("get deleted: %d", w.Code)
	}
	reopened, err = OpenStore(store.dir)
	if err != nil || len(reopened.List()) != 0 {
		t.Fatalf("persist deletion: %v", err)
	}
}

func TestDashboardValidation(t *testing.T) {
	s, _ := testService(t)
	valid := string(dashboard("demo", "Demo"))
	for name, body := range map[string]string{
		"id mismatch":         strings.Replace(valid, `"id":"demo"`, `"id":"other"`, 1),
		"grid overflow":       strings.Replace(valid, `"x":0`, `"x":10`, 1),
		"negative position":   strings.Replace(valid, `"y":0`, `"y":-1`, 1),
		"unsupported version": strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":99`, 1),
		"invalid provider":    strings.Replace(valid, `"providerId":"prometheus"`, `"providerId":"http://evil"`, 1),
		"missing query":       strings.Replace(valid, `"query":"up"`, `"query":""`, 1),
		"duplicate json":      valid + valid,
		"too large":           strings.Repeat(" ", maxDocumentBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", []byte(body), nil)
			if w.Code != 400 {
				t.Fatalf("invalid document accepted: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestStoreConcurrentCompareAndSwap(t *testing.T) {
	_, store := testService(t)
	tag, err := store.Put("demo", dashboard("demo", "Demo"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.Put("demo", dashboard("demo", fmt.Sprintf("Revision %d", i)), tag, "")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatalf("want one successful compare-and-swap, got %d", success)
	}
}

func TestDashboardMatchesStrictFrontendContract(t *testing.T) {
	valid := string(dashboard("demo", "Demo"))
	for name, document := range map[string]string{
		"unknown dashboard field":  strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":1,"extra":true`, 1),
		"unknown widget field":     strings.Replace(valid, `"type":"timeseries"`, `"type":"timeseries","extra":true`, 1),
		"unknown layout field":     strings.Replace(valid, `"x":0`, `"x":0,"extra":true`, 1),
		"missing interval":         strings.Replace(valid, `"refreshInterval":30,`, ``, 1),
		"missing unit":             strings.Replace(valid, `"unit":"req/s",`, ``, 1),
		"missing zero coordinate":  strings.Replace(valid, `"x":0,`, ``, 1),
		"null description":         strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":1,"description":null`, 1),
		"null widget description":  strings.Replace(valid, `"type":"timeseries"`, `"type":"timeseries","description":null`, 1),
		"null unit":                strings.Replace(valid, `"unit":"req/s"`, `"unit":null`, 1),
		"empty color":              strings.Replace(valid, `"type":"timeseries"`, `"type":"timeseries","color":""`, 1),
		"css color":                strings.Replace(valid, `"type":"timeseries"`, `"type":"timeseries","color":"red"`, 1),
		"long title":               string(dashboard("demo", strings.Repeat("a", 121))),
		"long unicode title":       string(dashboard("demo", strings.Repeat("😀", 61))),
		"only JS whitespace title": string(dashboard("demo", "\ufeff")),
		"long unit":                strings.Replace(valid, `"unit":"req/s"`, `"unit":"`+strings.Repeat("x", 25)+`"`, 1),
		"long query":               strings.Replace(valid, `"query":"up"`, `"query":"`+strings.Repeat("x", 8193)+`"`, 1),
		"long description":         strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":1,"description":"`+strings.Repeat("x", 501)+`"`, 1),
		"excess grid y":            strings.Replace(valid, `"y":0`, `"y":1001`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", []byte(document)); err == nil {
				t.Fatal("accepted a document rejected by the frontend")
			}
		})
	}
	for _, title := range []string{strings.Repeat("a", 120), strings.Repeat("😀", 60)} {
		if err := validateDashboard("demo", dashboard("demo", title)); err != nil {
			t.Fatalf("valid boundary title rejected: %v", err)
		}
	}
}

func TestPrometheusProviderContractAndSecretIsolation(t *testing.T) {
	t.Setenv("INSIGHTS_TEST_PROVIDER_TOKEN", "private-provider-token")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/prometheus/api/v1/query_range" || r.URL.Query().Get("query") != "rate(requests_total[5m])" || r.URL.Query().Get("step") != "30" || r.Header.Get("Authorization") != "Bearer private-provider-token" {
			t.Errorf("unexpected provider request: path=%s query=%s auth matches=%v", r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization") == "Bearer private-provider-token")
		}
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"requests","service":"api"},"values":[[1700000000,"2.5"],[1700000030,"NaN"],[1700000060,"+Inf"]]}]}}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Production metrics", Type: "prometheus", URL: upstream.URL + "/prometheus", BearerTokenEnv: "INSIGHTS_TEST_PROVIDER_TOKEN"})
	w := request(t, s.Handler(), "GET", "/api/providers", nil, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "private-provider-token") || strings.Contains(w.Body.String(), upstream.URL) {
		t.Fatalf("provider metadata leak: %s", w.Body)
	}
	w = request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"prometheus","kind":"metrics","query":"rate(requests_total[5m])","start":1700000000,"end":1700000600,"step":30}`), nil)
	if w.Code != 200 {
		t.Fatalf("query: %d %s", w.Code, w.Body)
	}
	var result QueryResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	points := result.Series[0].Points
	if len(points) != 3 || points[0].Timestamp != 1700000000000 || *points[0].Value != 2.5 || points[1].Value != nil || points[2].Value != nil {
		t.Fatalf("normalization: %+v", points)
	}
}

func TestTempoSearchContract(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/search" || r.URL.Query().Get("q") != "{ resource.service.name = \"api\" }" || r.URL.Query().Get("limit") != "101" || r.URL.Query().Get("start") != "1700000000" {
			t.Errorf("unexpected trace request: %s", r.URL.String())
		}
		_, _ = io.WriteString(w, `{"traces":[{"traceID":"abc123","rootServiceName":"api","rootTraceName":"GET /orders","startTimeUnixNano":"1700000000123000000","durationMs":42}]}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Traces", Type: "tempo", URL: upstream.URL})
	w := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"tempo","kind":"traces","query":"{ resource.service.name = \"api\" }","start":1700000000,"end":1700000600,"step":0}`), nil)
	if w.Code != 200 {
		t.Fatalf("query: %d %s", w.Code, w.Body)
	}
	var result QueryResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Traces) != 1 || result.Traces[0].StartTime != 1700000000123 || result.Traces[0].DurationMs != 42 || result.Traces[0].Status != "unknown" {
		t.Fatalf("normalized traces: %+v", result)
	}
}

func TestInvalidQueryNeverReachesUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid query reached provider") }))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	for _, body := range []string{
		`{"providerId":"prometheus","kind":"metrics","query":"up","start":1,"end":99999999,"step":1}`,
		`{"providerId":"prometheus","kind":"metrics","query":"up","start":1700000000,"end":1700000600,"step":0}`,
		`{"providerId":"prometheus","kind":"traces","query":"{}","start":1700000000,"end":1700000600}`,
		`{"providerId":"prometheus","kind":"metrics","query":"up","start":1700000000,"end":1700000600,"step":10,"url":"http://evil"}`,
	} {
		w := request(t, s.Handler(), "POST", "/api/query", []byte(body), nil)
		if w.Code != 400 {
			t.Fatalf("invalid query accepted: %d %s", w.Code, w.Body)
		}
	}
}

func TestRedirectDoesNotForwardProviderCredentials(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("provider redirect was followed") }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	w := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"prometheus","kind":"metrics","query":"up","start":1700000000,"end":1700000600,"step":30}`), nil)
	if w.Code != 502 || strings.Contains(w.Body.String(), target.URL) {
		t.Fatalf("redirect response: %d %s", w.Code, w.Body)
	}
}

func TestProviderCancellationPropagates(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(cancelled) }))
	defer upstream.Close()
	p, err := newProvider(&ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := p.query(ctx, Query{Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 30})
		done <- err
	}()
	<-started
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream request was not cancelled")
	}
	if err := <-done; err == nil {
		t.Fatal("cancelled query returned success")
	}
}

func TestMalformedUpstreamIsSanitized(t *testing.T) {
	for _, body := range []string{`{"status":"error","error":"sensitive backend data"}`, `<html>private server error</html>`, strings.Repeat("x", maxResponseBytes+1)} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, body) }))
		s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
		w := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"prometheus","kind":"metrics","query":"up","start":1700000000,"end":1700000600,"step":30}`), nil)
		if w.Code != 502 || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "sensitive") {
			t.Fatalf("unsanitized upstream failure: %d %s", w.Code, w.Body)
		}
		upstream.Close()
	}
}

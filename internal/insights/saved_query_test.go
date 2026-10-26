package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

func savedQueryDocument(id string) map[string]any {
	return map[string]any{"schemaVersion": 1, "id": id, "name": "Requests by service", "providerId": "metrics", "kind": "metrics", "query": "up{service={{service}}} @ {{at}} > {{minimum}}", "parameters": []any{
		map[string]any{"name": "service", "type": "string", "label": "Service", "defaultValue": "api"},
		map[string]any{"name": "at", "type": "number"},
		map[string]any{"name": "minimum", "type": "number", "defaultValue": -7.25},
	}}
}

func savedQueryJSON(t *testing.T, document any) []byte {
	t.Helper()
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func testFixtureValue[T any](t *testing.T, value any) T {
	t.Helper()
	typed, ok := value.(T)
	require.True(t, ok, "unexpected fixture type %T", value)
	return typed
}

func testFixtureObject(t *testing.T, document map[string]any, field string, index int) map[string]any {
	t.Helper()
	items := testFixtureValue[[]any](t, document[field])
	require.Greater(t, len(items), index)
	return testFixtureValue[map[string]any](t, items[index])
}

func TestSavedQueryLifecyclePersistenceAndPreconditions(t *testing.T) {
	provider := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics.internal:9090"}
	s, store := testService(t, provider)
	h := s.Handler()
	document := savedQueryDocument("requests")
	w := request(t, h, "PUT", "/api/saved-queries/requests", savedQueryJSON(t, document), map[string]string{"If-None-Match": "*"})
	require.False(t, w.Code != 200, "create: %d %s", w.Code, w.Body)
	require.False(t, w.Header().Get("ETag") == "", "create: %d %s", w.Code, w.Body)
	initialTag := w.Header().Get("ETag")
	if strings.Contains(w.Body.String(), `"etag"`) {
		t.Fatal("PUT document must remain valid under the strict saved-query schema")
	}
	w = request(t, h, "GET", "/api/saved-queries/requests", nil, nil)
	require.False(t, w.Code != 200, "GET: %d %s", w.Code, w.Body)
	require.False(t, w.Header().Get("ETag") != initialTag, "GET: %d %s", w.Code, w.Body)
	w = request(t, h, "GET", "/api/saved-queries/requests", nil, map[string]string{"If-None-Match": initialTag})
	require.False(t, w.Code != 304, "conditional GET: %d %s", w.Code, w.Body)
	require.False(t, w.Body.Len() != 0, "conditional GET: %d %s", w.Code, w.Body)
	w = request(t, h, "PUT", "/api/saved-queries/requests", savedQueryJSON(t, document), map[string]string{"If-None-Match": "*"})
	require.False(t, w.Code != 412, "duplicate create: %d %s", w.Code, w.Body)
	document["name"] = "Updated requests"
	document["query"] = "up{service={{service}}} > {{minimum}}"
	w = request(t, h, "PUT", "/api/saved-queries/requests", savedQueryJSON(t, document), map[string]string{"If-Match": initialTag})
	require.False(t, w.Code != 200, "conditional update: %d %s", w.Code, w.Body)
	require.False(t, w.Header().Get("ETag") == initialTag, "conditional update: %d %s", w.Code, w.Body)
	newTag := w.Header().Get("ETag")
	for _, method := range []string{"PUT", "DELETE"} {
		w = request(t, h, method, "/api/saved-queries/requests", savedQueryJSON(t, document), map[string]string{"If-Match": initialTag})
		require.False(t, w.Code != 412, "stale %s: %d %s", method, w.Code, w.Body)
	}
	w = request(t, h, "DELETE", "/api/saved-queries/requests", nil, nil)
	require.False(t, w.Code != 428, "unconditional delete: %d %s", w.Code, w.Body)
	for _, tc := range []struct {
		path  string
		count int
	}{
		{"/api/saved-queries", 1}, {"/api/saved-queries?providerId=metrics", 1}, {"/api/saved-queries?providerId=other", 0},
	} {
		w = request(t, h, "GET", tc.path, nil, nil)
		var result struct{ Queries []map[string]any }
		require.False(t, w.Code != 200, "list %s: %d %s", tc.path, w.Code, w.Body)
		require.False(t, json.Unmarshal(w.Body.Bytes(), &result) != nil, "list %s: %d %s", tc.path, w.Code, w.Body)
		require.False(t, len(result.Queries) != tc.count, "list %s: %d %s", tc.path, w.Code, w.Body)
		require.False(t, tc.count > 0 && result.Queries[0]["etag"] != newTag, "list must carry current per-document etag: %s", w.Body)
	}
	w = request(t, h, "GET", "/api/saved-queries?providerId=..%2Fsecret", nil, nil)
	require.False(t, w.Code != 400, "invalid filter: %d", w.Code)
	// The query subdirectory must not interfere with dashboard persistence.
	if _, err := store.Put("dashboard", dashboard("dashboard", "Dashboard"), "", ""); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(store.dir)
	require.False(t, err != nil, "reopen dashboards: %v", err)
	require.False(t, len(reopened.List()) != 1, "reopen dashboards: %v", err)
	restarted, err := NewServer(Config{Token: testToken, Providers: []ProviderConfig{provider}}, reopened)
	if err != nil {
		t.Fatal(err)
	}
	w = request(t, restarted.Handler(), "GET", "/api/saved-queries/requests", nil, nil)
	require.False(t, w.Code != 200, "query persistence: %d %s", w.Code, w.Body)
	require.False(t, w.Header().Get("ETag") != newTag, "query persistence: %d %s", w.Code, w.Body)
	require.False(t, !strings.Contains(w.Body.String(), "Updated requests"), "query persistence: %d %s", w.Code, w.Body)
	w = request(t, restarted.Handler(), "DELETE", "/api/saved-queries/requests", nil, map[string]string{"If-Match": newTag})
	require.False(t, w.Code != 204, "delete: %d %s", w.Code, w.Body)
	restarted, err = NewServer(Config{Token: testToken, Providers: []ProviderConfig{provider}}, reopened)
	require.False(t, err != nil, "delete persistence: %v", err)
	require.False(t, len(restarted.savedQueries.list("")) != 0, "delete persistence: %v", err)
}

func TestSavedQueryValidationStrictBoundsAndTemplateGrammar(t *testing.T) {
	invalid := map[string]func(map[string]any){
		"unknown field":          func(d map[string]any) { d["url"] = "http://arbitrary" },
		"null description":       func(d map[string]any) { d["description"] = nil },
		"null parameters":        func(d map[string]any) { d["parameters"] = nil },
		"mismatched id":          func(d map[string]any) { d["id"] = "other" },
		"invalid provider":       func(d map[string]any) { d["providerId"] = "../metrics" },
		"version":                func(d map[string]any) { d["schemaVersion"] = 2 },
		"blank name":             func(d map[string]any) { d["name"] = "\ufeff \n" },
		"long name":              func(d map[string]any) { d["name"] = strings.Repeat("界", 121) },
		"long description":       func(d map[string]any) { d["description"] = strings.Repeat("x", 501) },
		"long query":             func(d map[string]any) { d["query"] = strings.Repeat("x", 8193) },
		"blank query":            func(d map[string]any) { d["query"] = " \n" },
		"kind":                   func(d map[string]any) { d["kind"] = "logs" },
		"parameter unknown":      func(d map[string]any) { testFixtureObject(t, d, "parameters", 0)["extra"] = true },
		"parameter duplicate":    func(d map[string]any) { testFixtureObject(t, d, "parameters", 1)["name"] = "service" },
		"parameter reserved":     func(d map[string]any) { testFixtureObject(t, d, "parameters", 0)["name"] = "constructor" },
		"parameter type":         func(d map[string]any) { testFixtureObject(t, d, "parameters", 0)["type"] = "boolean" },
		"parameter long label":   func(d map[string]any) { testFixtureObject(t, d, "parameters", 0)["label"] = strings.Repeat("x", 81) },
		"parameter null default": func(d map[string]any) { testFixtureObject(t, d, "parameters", 0)["defaultValue"] = nil },
		"parameter long default": func(d map[string]any) {
			testFixtureObject(t, d, "parameters", 0)["defaultValue"] = strings.Repeat("x", 1025)
		},
		"string numeric default": func(d map[string]any) { testFixtureObject(t, d, "parameters", 0)["defaultValue"] = 2 },
		"number string default":  func(d map[string]any) { testFixtureObject(t, d, "parameters", 1)["defaultValue"] = "2" },
		"too many parameters":    func(d map[string]any) { d["parameters"] = make([]any, 21) },
	}
	for name, mutate := range invalid {
		t.Run(name, func(t *testing.T) {
			document := savedQueryDocument("query")
			mutate(document)
			if _, err := validateSavedQuery("query", savedQueryJSON(t, document)); err == nil {
				t.Fatal("invalid saved query accepted")
			}
		})
	}
	for _, query := range []string{
		`up{service="{{service}}"}`, `up{service='{{service}}'}`, "up{service=`{{service}}`}",
		"up # {{service}}", "up // {{service}}", "up /* {{service}} */", `up{{service}}`, `{{service}}suffix`,
		`{{unknown}}`, `{{ constructor }}`, `{{service`, `up @{{service}}`, `up +{{service}}`,
	} {
		t.Run("template "+query, func(t *testing.T) {
			document := savedQueryDocument("query")
			document["query"] = query
			if _, err := validateSavedQuery("query", savedQueryJSON(t, document)); err == nil {
				t.Fatal("unsafe/undeclared template accepted")
			}
		})
	}
	for _, query := range []string{
		`up{service={{service}}} @{{at}} >{{minimum}}`, `up +{{minimum}}`, `up{literal="a\\\"b",service={{service}}}`,
		"up # comment\n > {{minimum}}", "up /* comment */ > {{minimum}}", "up // comment\r > {{minimum}}", `up`,
	} {
		document := savedQueryDocument("query")
		document["query"] = query
		if _, err := validateSavedQuery("query", savedQueryJSON(t, document)); err != nil {
			t.Fatalf("valid template %s: %v", query, err)
		}
	}
	valid := savedQueryJSON(t, savedQueryDocument("query"))
	for _, raw := range [][]byte{bytes.Replace(valid, []byte(`-7.25`), []byte(`1e999`), 1), append(valid, []byte(` {}`)...), append(valid, bytes.Repeat([]byte(" "), maxSavedQueryBytes)...)} {
		if _, err := validateSavedQuery("query", raw); err == nil {
			t.Fatal("nonfinite, extra JSON, or oversized document accepted")
		}
	}
}

func TestSavedQueryProviderValidationAndIdentity(t *testing.T) {
	s, _ := testService(t,
		ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics:9090"},
		ProviderConfig{ID: "other", Name: "Other", Type: "prometheus", URL: "http://other:9090"},
		ProviderConfig{ID: "tempo", Name: "Tempo", Type: "tempo", URL: "http://tempo:3200"},
	)
	for _, tc := range []struct{ provider, kind string }{{"missing", "metrics"}, {"metrics", "traces"}, {"tempo", "metrics"}} {
		document := savedQueryDocument("query")
		document["providerId"], document["kind"] = tc.provider, tc.kind
		w := request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), nil)
		if w.Code != 400 {
			t.Fatalf("provider %s kind %s: %d %s", tc.provider, tc.kind, w.Code, w.Body)
		}
	}
	document := savedQueryDocument("query")
	w := request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), nil)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	tag := w.Header().Get("ETag")
	for _, tc := range []struct{ provider, kind string }{{"other", "metrics"}, {"tempo", "traces"}} {
		document["providerId"], document["kind"] = tc.provider, tc.kind
		w = request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), map[string]string{"If-Match": tag})
		if w.Code != 409 {
			t.Fatalf("identity changed: %d %s", w.Code, w.Body)
		}
	}
	document["id"] = "trace-query"
	document["query"] = "{ resource.service.name = {{service}} && span.duration > {{minimum}} }"
	w = request(t, s.Handler(), "PUT", "/api/saved-queries/trace-query", savedQueryJSON(t, document), nil)
	if w.Code != 200 {
		t.Fatalf("compatible Tempo library: %d %s", w.Code, w.Body)
	}
}

func TestSavedQueryReferenceDeletionGuards(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "PUT", "/api/provider-configs/metrics", providerBody("metrics", "Metrics", "http://metrics:9090"), nil)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	providerTag := w.Header().Get("ETag")
	w = request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, savedQueryDocument("query")), nil)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	tag := w.Header().Get("ETag")
	for _, refType := range []string{"widget", "tooltip"} {
		var d map[string]any
		_ = json.Unmarshal(dashboard("board", "Board"), &d)
		widget := testFixtureObject(t, d, "widgets", 0)
		if refType == "widget" {
			widget["queryRef"] = map[string]any{"id": "query"}
		} else {
			widget["options"] = map[string]any{"tooltipView": map[string]any{"type": "stat", "source": map[string]any{"type": "saved", "ref": map[string]any{"id": "query"}}}}
		}
		w = request(t, s.Handler(), "PUT", "/api/dashboards/board", savedQueryJSON(t, d), nil)
		if w.Code != 200 {
			t.Fatalf("persist %s reference: %d %s", refType, w.Code, w.Body)
		}
		w = request(t, s.Handler(), "DELETE", "/api/saved-queries/query", nil, map[string]string{"If-Match": tag})
		if w.Code != 409 || !strings.Contains(w.Body.String(), "in use") {
			t.Fatalf("delete %s referenced query: %d %s", refType, w.Code, w.Body)
		}
	}
	w = request(t, s.Handler(), "DELETE", "/api/provider-configs/metrics", nil, map[string]string{"If-Match": providerTag})
	if w.Code != 409 {
		t.Fatalf("delete provider used by query: %d %s", w.Code, w.Body)
	}
	newProvider := ProviderConfig{ID: "metrics", Name: "Tempo", Type: "tempo", URL: "http://tempo:3200"}
	w = request(t, s.Handler(), "PUT", "/api/provider-configs/metrics", savedQueryJSON(t, newProvider), map[string]string{"If-Match": providerTag})
	if w.Code != 409 {
		t.Fatalf("change used provider type: %d %s", w.Code, w.Body)
	}
	w = request(t, s.Handler(), "PUT", "/api/provider-configs/metrics", providerBody("metrics", "Renamed", "http://new-metrics:9090"), map[string]string{"If-Match": providerTag})
	if w.Code != 200 {
		t.Fatalf("provider metadata/URL changes should remain available: %d %s", w.Code, w.Body)
	}
	providerTag = w.Header().Get("ETag")
	w = request(t, s.Handler(), "DELETE", "/api/dashboards/board", nil, nil)
	if w.Code != 204 {
		t.Fatal(w.Body)
	}
	w = request(t, s.Handler(), "DELETE", "/api/saved-queries/query", nil, map[string]string{"If-Match": tag})
	if w.Code != 204 {
		t.Fatalf("delete unreferenced query: %d %s", w.Code, w.Body)
	}
	w = request(t, s.Handler(), "DELETE", "/api/provider-configs/metrics", nil, map[string]string{"If-Match": providerTag})
	if w.Code != 204 {
		t.Fatalf("delete unreferenced provider: %d %s", w.Code, w.Body)
	}
}

func TestSavedQueryStoreConcurrentCASAndCapacity(t *testing.T) {
	s, err := openSavedQueryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tag, err := s.put("query", savedQueryJSON(t, savedQueryDocument("query")), "", "*")
	if err != nil {
		t.Fatal(err)
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := range 16 {
		document := savedQueryDocument("query")
		document["name"] = fmt.Sprintf("Writer %d", i)
		raw := savedQueryJSON(t, document)
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.list("")
			_, _, getErr := s.get("query")
			if getErr != nil {
				t.Error(getErr)
			}
			if _, putErr := s.put("query", raw, tag, ""); putErr == nil {
				wins.Add(1)
			} else if !errors.Is(putErr, ErrConflict) {
				t.Error(putErr)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("conditional update winners = %d, want 1", wins.Load())
	}
	for i := 1; i < maxSavedQueries; i++ {
		id := fmt.Sprintf("q-%03d", i)
		if _, putErr := s.put(id, savedQueryJSON(t, savedQueryDocument(id)), "", "*"); putErr != nil {
			t.Fatal(putErr)
		}
	}
	if _, putErr := s.put("overflow", savedQueryJSON(t, savedQueryDocument("overflow")), "", "*"); !errors.Is(putErr, ErrCapacity) {
		t.Fatalf("capacity limit: %v", putErr)
	}
	data, tag, err := s.get("query")
	if err != nil {
		t.Fatal(err)
	}
	data[0] = '!'
	if _, err := s.put("query", savedQueryJSON(t, savedQueryDocument("query")), tag, ""); err != nil {
		t.Fatalf("update at capacity/copy isolation: %v", err)
	}
}

func TestSavedQueryStoreRejectsCorruptOrUnsafeFiles(t *testing.T) {
	for _, tc := range []string{"malformed", "oversized", "symlink", "filename mismatch"} {
		t.Run(tc, func(t *testing.T) {
			dir := t.TempDir()
			s, err := openSavedQueryStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.dir, "query.json")
			raw := savedQueryJSON(t, savedQueryDocument("query"))
			switch tc {
			case "malformed":
				raw = []byte(`{"id":"query"}`)
			case "oversized":
				raw = append(raw, bytes.Repeat([]byte(" "), maxSavedQueryBytes)...)
			case "filename mismatch":
				raw = savedQueryJSON(t, savedQueryDocument("different"))
			case "symlink":
				target := filepath.Join(dir, "target")
				if err := os.WriteFile(target, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			}
			if tc != "symlink" {
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := openSavedQueryStore(dir); err == nil {
				t.Fatal("unsafe persisted query accepted")
			}
		})
	}
}

func TestSavedQueryServiceAuthentication(t *testing.T) {
	s, _ := testService(t)
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		w := request(t, s.Handler(), method, "/api/saved-queries/query", []byte(`{}`), map[string]string{"Authorization": "Bearer invalid"})
		if w.Code != 401 {
			t.Fatalf("%s without auth: %d", method, w.Code)
		}
	}
}

func TestSavedQuerySavingNeverQueriesProviderAndRestartRetainsOrphans(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	s, store := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	w := request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, savedQueryDocument("query")), nil)
	if w.Code != 200 || calls.Load() != 0 {
		t.Fatalf("saving executed provider request: %d %s, calls=%d", w.Code, w.Body, calls.Load())
	}
	// Operator-managed providers can be removed from a later startup config.
	// The library stays readable and deletable instead of blocking startup.
	restarted, err := NewServer(Config{Token: testToken}, store)
	if err != nil {
		t.Fatal(err)
	}
	w = request(t, restarted.Handler(), "GET", "/api/saved-queries/query", nil, nil)
	if w.Code != 200 {
		t.Fatalf("read orphaned query: %d %s", w.Code, w.Body)
	}
	tag := w.Header().Get("ETag")
	w = request(t, restarted.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, savedQueryDocument("query")), map[string]string{"If-Match": tag})
	if w.Code != 400 {
		t.Fatalf("save without provider: %d %s", w.Code, w.Body)
	}
	w = request(t, restarted.Handler(), "DELETE", "/api/saved-queries/query", nil, map[string]string{"If-Match": tag})
	if w.Code != 204 {
		t.Fatalf("delete orphan: %d %s", w.Code, w.Body)
	}
}

func TestSavedQueryProviderDeletionConcurrentWithSave(t *testing.T) {
	for range 8 {
		s, _ := testService(t)
		h := s.Handler()
		w := request(t, h, "PUT", "/api/provider-configs/metrics", providerBody("metrics", "Metrics", "http://metrics:9090"), nil)
		if w.Code != 200 {
			t.Fatal(w.Body)
		}
		tag := w.Header().Get("ETag")
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			w := request(t, h, "DELETE", "/api/provider-configs/metrics", nil, map[string]string{"If-Match": tag})
			if w.Code != 204 && w.Code != 409 {
				t.Errorf("concurrent delete: %d %s", w.Code, w.Body)
			}
		}()
		raw := savedQueryJSON(t, savedQueryDocument("query"))
		go func() {
			defer wg.Done()
			<-start
			w := request(t, h, "PUT", "/api/saved-queries/query", raw, map[string]string{"If-None-Match": "*"})
			if w.Code != 200 && w.Code != 400 {
				t.Errorf("concurrent save: %d %s", w.Code, w.Body)
			}
		}()
		close(start)
		wg.Wait()
		if _, _, err := s.savedQueries.get("query"); err == nil {
			if _, exists := s.providers.get("metrics"); !exists {
				t.Fatal("concurrent provider deletion left a newly saved query without a provider")
			}
		}
	}
}

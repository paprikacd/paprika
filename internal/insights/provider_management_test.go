package insights

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

func providerBody(id, name, url string) []byte {
	data, _ := json.Marshal(ProviderConfig{ID: id, Name: name, Type: "prometheus", URL: url})
	return data
}

func TestManagedProviderLifecyclePersistenceAndPreconditions(t *testing.T) {
	s, store := testService(t)
	body := providerBody("managed", "Managed metrics", "http://metrics.internal:9090")
	w := request(t, s.Handler(), "PUT", "/api/provider-configs/managed", body, map[string]string{"If-None-Match": "*"})
	require.False(t, w.Code != 200, "create: %d %s", w.Code, w.Body)
	require.False(t, w.Header().Get("ETag") == "", "create: %d %s", w.Code, w.Body)
	tag := w.Header().Get("ETag")
	var view ProviderConfigView
	require.False(t, json.Unmarshal(w.Body.Bytes(), &view) != nil, "create view: %s", w.Body)
	require.False(t, !view.Managed, "create view: %s", w.Body)
	require.False(t, view.ETag != tag, "create view: %s", w.Body)
	w = request(t, s.Handler(), "GET", "/api/providers", nil, nil)
	require.False(t, w.Code != 200, "public metadata leak: %d %s", w.Code, w.Body)
	require.False(t, strings.Contains(w.Body.String(), "metrics.internal"), "public metadata leak: %d %s", w.Code, w.Body)
	require.False(t, !strings.Contains(w.Body.String(), `"managed":true`), "public metadata leak: %d %s", w.Code, w.Body)
	w = request(t, s.Handler(), "GET", "/api/provider-configs", nil, nil)
	require.False(t, w.Code != 200, "configuration view: %d %s", w.Code, w.Body)
	require.False(t, !strings.Contains(w.Body.String(), "metrics.internal"), "configuration view: %d %s", w.Code, w.Body)
	w = request(t, s.Handler(), "PUT", "/api/provider-configs/managed", providerBody("managed", "Renamed", "http://metrics.internal:9090"), map[string]string{"If-Match": tag})
	require.False(t, w.Code != 200, "update: %d %s", w.Code, w.Body)
	w = request(t, s.Handler(), "PUT", "/api/provider-configs/managed", body, map[string]string{"If-Match": tag})
	require.False(t, w.Code != 412, "stale update: %d", w.Code)
	reopened, err := OpenStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewServer(Config{Token: testToken}, reopened)
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.providers.list(); len(got) != 1 || got[0].Name != "Renamed" || !got[0].Managed {
		t.Fatalf("provider persistence: %+v", got)
	}
	if _, startupErr := NewServer(Config{Token: testToken, Providers: []ProviderConfig{{ID: "managed", Name: "Provisioned duplicate", Type: "prometheus", URL: "http://other:9090"}}}, reopened); startupErr == nil {
		t.Fatal("persisted/provisioned collision must fail startup")
	}
	w = request(t, restarted.Handler(), "DELETE", "/api/provider-configs/managed", nil, map[string]string{"If-Match": tag})
	require.False(t, w.Code != 412, "stale delete: %d", w.Code)
	w = request(t, restarted.Handler(), "DELETE", "/api/provider-configs/managed", nil, nil)
	require.False(t, w.Code != 204, "delete: %d %s", w.Code, w.Body)
	restarted, err = NewServer(Config{Token: testToken}, reopened)
	require.False(t, err != nil, "delete persistence: %v", err)
	require.False(t, len(restarted.providers.list()) != 0, "delete persistence: %v", err)
}

func TestProvisionedProvidersImmutableAndManagedSecretsScoped(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "fixed", Name: "Provisioned", Type: "prometheus", URL: "http://metrics:9090"})
	for _, method := range []string{"PUT", "DELETE"} {
		w := request(t, s.Handler(), method, "/api/provider-configs/fixed", providerBody("fixed", "Changed", "http://other:9090"), nil)
		if w.Code != 409 {
			t.Fatalf("%s provisioned provider: %d %s", method, w.Code, w.Body)
		}
	}
	t.Setenv("PAPRIKA_INSIGHTS_TOKEN", "must-not-leave-service")
	body, _ := json.Marshal(ProviderConfig{ID: "bad", Name: "Bad", Type: "prometheus", URL: "http://example.test", BearerTokenEnv: "PAPRIKA_INSIGHTS_TOKEN"})
	w := request(t, s.Handler(), "PUT", "/api/provider-configs/bad", body, nil)
	if w.Code != 400 || strings.Contains(w.Body.String(), "must-not-leave-service") {
		t.Fatalf("unscoped secret accepted/leaked: %d %s", w.Code, w.Body)
	}
	t.Setenv("PAPRIKA_PROVIDER_METRICS_TOKEN", "provider-private-token")
	body, _ = json.Marshal(ProviderConfig{ID: "good", Name: "Good", Type: "prometheus", URL: "http://example.test", BearerTokenEnv: "PAPRIKA_PROVIDER_METRICS_TOKEN"})
	w = request(t, s.Handler(), "PUT", "/api/provider-configs/good", body, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "provider-private-token") {
		t.Fatalf("scoped secret: %d %s", w.Code, w.Body)
	}
}

func TestMetadataDiscoveryCachingAndConnectionTest(t *testing.T) {
	var metadataCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/query":
			if r.URL.Query().Get("query") != "vector(1)" {
				t.Errorf("unexpected connection test query: %s", r.URL.RawQuery)
			}
			_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
		case "/api/v1/label/__name__/values":
			metadataCalls.Add(1)
			_, _ = io.WriteString(w, `{"status":"success","data":["up","http_requests_total","up"]}`)
		case "/api/v1/labels":
			metadataCalls.Add(1)
			_, _ = io.WriteString(w, `{"status":"success","data":["service","instance"]}`)
		case "/api/v1/label/service/values":
			metadataCalls.Add(1)
			if r.URL.Query().Get("match[]") != "http_requests_total" {
				t.Errorf("missing metric filter: %s", r.URL.RawQuery)
			}
			_, _ = io.WriteString(w, `{"status":"success","data":["api","worker"]}`)
		default:
			t.Errorf("unexpected metadata route: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	s, _ := testService(t)
	w := request(t, s.Handler(), "PUT", "/api/provider-configs/metrics", providerBody("metrics", "Metrics", upstream.URL), nil)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	w = request(t, s.Handler(), "POST", "/api/providers/metrics/test", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("connection: %d %s", w.Code, w.Body)
	}
	for i := 0; i < 2; i++ {
		w = request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=metrics", nil, nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `["http_requests_total","up"]`) {
			t.Fatalf("metric discovery: %d %s", w.Code, w.Body)
		}
	}
	if metadataCalls.Load() != 1 {
		t.Fatalf("metadata cache missed: %d calls", metadataCalls.Load())
	}
	for _, path := range []string{"/api/providers/metrics/metadata?kind=labels", "/api/providers/metrics/metadata?kind=values&label=service&metric=http_requests_total"} {
		w = request(t, s.Handler(), "GET", path, nil, nil)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	w = request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=values&label=..%2Fsecrets", nil, nil)
	if w.Code != 400 {
		t.Fatalf("unsafe label accepted: %d", w.Code)
	}
	before := metadataCalls.Load()
	w = request(t, s.Handler(), "PUT", "/api/provider-configs/metrics", providerBody("metrics", "Renamed", upstream.URL), nil)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	w = request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=metrics", nil, nil)
	if w.Code != 200 || metadataCalls.Load() != before+1 {
		t.Fatal("provider edit must invalidate metadata cache")
	}
}

func TestMetadataLimitsAndFailureSanitization(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/query" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, "private provider credential details")
			return
		}
		values := make([]string, 1100)
		for i := range values {
			values[i] = fmt.Sprintf("metric_%04d", i)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": values})
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	w := request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=metrics", nil, nil)
	var result MetadataResult
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Values) != 1000 || !result.Truncated {
		t.Fatalf("metadata limits: %d %s", w.Code, w.Body)
	}
	w = request(t, s.Handler(), "POST", "/api/providers/metrics/test", nil, nil)
	if w.Code != 502 || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("unsanitized connection error: %d %s", w.Code, w.Body)
	}
}

func TestTempoTagMetadata(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/echo":
			_, _ = io.WriteString(w, "echo")
		case "/api/search/tags":
			_, _ = io.WriteString(w, `{"tagNames":["service.name","http.method"]}`)
		case "/api/search/tag/service.name/values":
			_, _ = io.WriteString(w, `{"tagValues":["api","worker"]}`)
		default:
			t.Errorf("unexpected Tempo route: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Tempo", Type: "tempo", URL: upstream.URL})
	for _, path := range []string{"/api/providers/tempo/metadata?kind=labels", "/api/providers/tempo/metadata?kind=values&label=service.name"} {
		w := request(t, s.Handler(), "GET", path, nil, nil)
		if w.Code != 200 {
			t.Fatalf("Tempo metadata: %d %s", w.Code, w.Body)
		}
	}
	w := request(t, s.Handler(), "POST", "/api/providers/tempo/test", nil, nil)
	if w.Code != 200 {
		t.Fatalf("Tempo connection: %d %s", w.Code, w.Body)
	}
}

func TestProviderRegistryConcurrentReadsAndUpdates(t *testing.T) {
	s, _ := testService(t)
	config := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics:9090"}
	if _, err := s.providers.put(&config, "", ""); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				_, err := s.providers.put(&config, "", "")
				if err != nil {
					t.Error(err)
				}
			} else {
				for range 20 {
					s.providers.list()
					s.providers.configs()
					s.providers.get("metrics")
				}
			}
		}()
	}
	wg.Wait()
}

func TestProviderChecksRejectUnrelatedSuccessResponses(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Tempo", Type: "tempo", URL: upstream.URL})
	for _, operation := range []struct{ method, path string }{
		{"POST", "/api/providers/tempo/test"},
		{"GET", "/api/providers/tempo/metadata?kind=labels"},
		{"GET", "/api/providers/tempo/metadata?kind=values&label=service.name"},
	} {
		w := request(t, s.Handler(), operation.method, operation.path, nil, nil)
		if w.Code != 502 {
			t.Fatalf("unrelated 200 response accepted at %s: %d %s", operation.path, w.Code, w.Body)
		}
	}
}

func TestProviderHeaderNamesAndUnicodeNames(t *testing.T) {
	t.Setenv("PAPRIKA_PROVIDER_HEADER", "value")
	for _, headers := range []map[string]string{
		{"Invalid(Header)": "PAPRIKA_PROVIDER_HEADER"},
		{"X-Tenant": "PAPRIKA_PROVIDER_HEADER", "x-tenant": "PAPRIKA_PROVIDER_HEADER"},
	} {
		_, err := newProvider(&ProviderConfig{ID: "test", Name: "Test", Type: "prometheus", URL: "http://metrics:9090", HeadersEnv: headers})
		if err == nil {
			t.Fatalf("invalid or duplicate HTTP header accepted: %v", headers)
		}
	}
	_, err := newProvider(&ProviderConfig{ID: "test", Name: strings.Repeat("界", 120), Type: "prometheus", URL: "http://metrics:9090"})
	if err != nil {
		t.Fatalf("120-character Unicode name must match frontend limits: %v", err)
	}
}

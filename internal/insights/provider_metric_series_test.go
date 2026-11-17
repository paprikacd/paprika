package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMetricSeriesMetadataBoundsAndCache(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		params := r.URL.Query()
		start, _ := strconv.ParseInt(params.Get("start"), 10, 64)
		end, _ := strconv.ParseInt(params.Get("end"), 10, 64)
		if r.URL.Path != "/api/v1/series" || params.Get("match[]") != "http_requests_total" || params.Get("limit") != "1001" || end-start != 86400 {
			t.Errorf("unexpected bounded request: %s", r.URL)
		}
		series := make([]map[string]string, 0, 4)
		series = append(series, map[string]string{"__name__": "http_requests_total", "job": "paprika", "service": "api", "status": "200"}, map[string]string{"__name__": "http_requests_total", "job": "paprika", "service": "api", "status": "500"}, map[string]string{"__name__": "http_requests_total", "job": "paprika", "service": "worker", "status": "200"})
		series = append(series, series[0])
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": series})
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	var first MetadataResult
	for i := 0; i < 2; i++ {
		w := request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=series&metric=http_requests_total", nil, nil)
		var result MetadataResult
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Series == nil {
			t.Fatalf("series discovery: %d %s", w.Code, w.Body)
		}
		if result.Series.Count != 3 || result.Series.Truncated || result.Series.Limit != 1000 || len(result.Series.Labels) != 3 || result.Series.Labels[1].Name != "service" || result.Series.Labels[1].Cardinality != 2 {
			t.Fatalf("incorrect metadata: %+v", result.Series)
		}
		first = result
	}
	if calls.Load() != 1 {
		t.Fatalf("expected cached discovery, got %d calls", calls.Load())
	}
	cloned := cloneMetadata(first)
	cloned.Series.Labels[0].Values[0] = "changed"
	cloned.Series.Count = 999
	if first.Series.Count != 3 || first.Series.Labels[0].Values[0] != "paprika" {
		t.Fatal("metadata cache cloned aliases the original")
	}
}

func TestMetricSeriesMetadataTruncationAndSamples(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		series := make([]map[string]string, 1100)
		for i := range series {
			series[i] = map[string]string{"__name__": "up", "instance": fmt.Sprintf("host-%04d", i), "long": strings.Repeat("x", 257)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": series})
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	w := request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=series&metric=up", nil, nil)
	var result MetadataResult
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Series == nil {
		t.Fatalf("series discovery: %d %s", w.Code, w.Body)
	}
	stats := result.Series
	if stats.Count != 1000 || !stats.Truncated || stats.Labels[0].Cardinality != 1000 || len(stats.Labels[0].Values) != 12 || !stats.Labels[0].ValuesTruncated || stats.Labels[1].Cardinality != 1 || len(stats.Labels[1].Values) != 0 || !stats.Labels[1].ValuesTruncated {
		t.Fatalf("unbounded or misleading counts: %+v %+v", stats, stats.Labels)
	}
}

func TestMetricSeriesMetadataValidationAndFailure(t *testing.T) {
	for _, response := range []string{`{"status":"error","error":"secret"}`, `{"status":"success","data":null}`, `{"status":"success","data":[{}]}`, strings.Repeat("x", (1<<20)+1)} {
		t.Run(strconv.Itoa(len(response)), func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, response)
			}))
			defer upstream.Close()
			s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL}, ProviderConfig{ID: "traces", Name: "Traces", Type: "tempo", URL: upstream.URL})
			for _, path := range []string{"/api/providers/metrics/metadata?kind=series", "/api/providers/metrics/metadata?kind=series&metric=up%7Bjob%3D%22x%22%7D", "/api/providers/traces/metadata?kind=series&metric=up"} {
				w := request(t, s.Handler(), "GET", path, nil, nil)
				if w.Code != 400 {
					t.Fatalf("expected invalid request, got %d %s", w.Code, w.Body)
				}
			}
			if calls.Load() != 0 {
				t.Fatal("invalid selectors must not reach the provider")
			}
			w := request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=series&metric=up", nil, nil)
			if w.Code != 502 || strings.Contains(w.Body.String(), "secret") {
				t.Fatalf("unsafe failure: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestMetricSeriesCancellation(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(canceled)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	p, _ := s.providers.get("metrics")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := p.metadata(ctx, "series", "", "up")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("series request did not reach provider")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("canceled discovery must not succeed")
	}
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("closing discovery must cancel its provider request")
	}
}

func TestMetricSeriesWarningsArePartialAndSanitized(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"status":"success","data":[{"__name__":"up","job":"api"}],"warnings":["private credential details"]}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	w := request(t, s.Handler(), "GET", "/api/providers/metrics/metadata?kind=series&metric=up", nil, nil)
	var result MetadataResult
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Series == nil || !result.Series.Truncated || strings.Contains(w.Body.String(), "credential") {
		t.Fatalf("unsafe partial discovery: %d %s", w.Code, w.Body)
	}
}

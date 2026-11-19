package insights

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// selectorUpstream records each label-values request's match[] and window.
type selectorUpstream struct {
	mu       sync.Mutex
	requests []url.Values
}

func (u *selectorUpstream) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/label/cluster/values" {
			t.Errorf("unexpected route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		u.mu.Lock()
		u.requests = append(u.requests, r.URL.Query())
		u.mu.Unlock()
		_, _ = io.WriteString(w, `{"status":"success","data":["omega","delta"]}`)
	})
}

func (u *selectorUpstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.requests)
}

func selectorService(t *testing.T, providerType string, upstreamURL string) (*Server, string) {
	t.Helper()
	s, _ := testService(t)
	data, _ := json.Marshal(ProviderConfig{ID: "metrics", Name: "Metrics", Type: providerType, URL: upstreamURL})
	if w := request(t, s.Handler(), "PUT", "/api/provider-configs/metrics", data, nil); w.Code != 200 {
		t.Fatal(w.Body)
	}
	return s, "/api/providers/metrics/metadata?kind=values&label=cluster"
}

func TestMetadataSelectorAndWindowReachPrometheus(t *testing.T) {
	upstream := &selectorUpstream{}
	server := httptest.NewServer(upstream.handler(t))
	defer server.Close()
	s, base := selectorService(t, "prometheus", server.URL)

	selector := url.QueryEscape(`http_requests_total{service="api"}`)
	path := base + "&selector=" + selector + "&start=1700000000&end=1700003600"
	w := request(t, s.Handler(), "GET", path, nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"omega"`) {
		t.Fatalf("selector lookup: %d %s", w.Code, w.Body)
	}
	got := upstream.requests[0]
	if got.Get("match[]") != `http_requests_total{service="api"}` {
		t.Fatalf("match[] = %q, want the selector", got.Get("match[]"))
	}
	if got.Get("start") != "1700000000" || got.Get("end") != "1700003600" {
		t.Fatalf("window = %s..%s, want the requested hour", got.Get("start"), got.Get("end"))
	}
}

func TestMetadataDefaultWindowStaysTrailingDay(t *testing.T) {
	upstream := &selectorUpstream{}
	server := httptest.NewServer(upstream.handler(t))
	defer server.Close()
	s, base := selectorService(t, "prometheus", server.URL)
	if w := request(t, s.Handler(), "GET", base, nil, nil); w.Code != 200 {
		t.Fatalf("default lookup: %d %s", w.Code, w.Body)
	}
	got := upstream.requests[0]
	start, _ := strconv.ParseInt(got.Get("start"), 10, 64)
	end, _ := strconv.ParseInt(got.Get("end"), 10, 64)
	if end-start != int64((24 * time.Hour).Seconds()) {
		t.Fatalf("default window = %d seconds, want 86400", end-start)
	}
}

func TestMetadataSelectorIsCachedPerSelectorAndWindow(t *testing.T) {
	upstream := &selectorUpstream{}
	server := httptest.NewServer(upstream.handler(t))
	defer server.Close()
	s, base := selectorService(t, "prometheus", server.URL)
	for _, selector := range []string{`up{cluster="omega"}`, `up{cluster="delta"}`, `up{cluster="omega"}`} {
		path := base + "&selector=" + url.QueryEscape(selector) + "&start=1700000000&end=1700003600"
		if w := request(t, s.Handler(), "GET", path, nil, nil); w.Code != 200 {
			t.Fatalf("%s: %d %s", selector, w.Code, w.Body)
		}
	}
	if upstream.count() != 2 {
		t.Fatalf("upstream calls = %d, want 2 (the repeated selector is cached)", upstream.count())
	}
}

func TestMetadataSelectorAndWindowRefusals(t *testing.T) {
	upstream := &selectorUpstream{}
	server := httptest.NewServer(upstream.handler(t))
	defer server.Close()
	s, base := selectorService(t, "prometheus", server.URL)
	refused := map[string]string{
		"quote escape":         "&selector=" + url.QueryEscape(`up{cluster="x"}"}`),
		"metric and selector":  "&metric=up&selector=" + url.QueryEscape(`up{a="b"}`),
		"start without end":    "&start=1700000000",
		"end before start":     "&start=1700003600&end=1700000000",
		"over thirty-one days": "&start=1700000000&end=" + strconv.FormatInt(1700000000+31*24*3600+1, 10),
		"not whole seconds":    "&start=soon&end=1700003600",
	}
	for name, query := range refused {
		if w := request(t, s.Handler(), "GET", base+query, nil, nil); w.Code != 400 {
			t.Fatalf("%s accepted: %d %s", name, w.Code, w.Body)
		}
	}
	if upstream.count() != 0 {
		t.Fatalf("refused lookups reached the provider %d times", upstream.count())
	}
}

func TestMetadataSelectorNeedsPrometheus(t *testing.T) {
	upstream := &selectorUpstream{}
	server := httptest.NewServer(upstream.handler(t))
	defer server.Close()
	s, base := selectorService(t, "tempo", server.URL)
	path := base + "&selector=" + url.QueryEscape(`up{cluster="omega"}`)
	if w := request(t, s.Handler(), "GET", path, nil, nil); w.Code != 400 {
		t.Fatalf("selector on tempo accepted: %d %s", w.Code, w.Body)
	}
}

// A 31-day label window is accepted, matching the other query caps; 31 days plus one second is refused.
func TestMetadataWindowAcceptsThirtyOneDays(t *testing.T) {
	upstream := &selectorUpstream{}
	server := httptest.NewServer(upstream.handler(t))
	defer server.Close()
	s, base := selectorService(t, "prometheus", server.URL)
	const start = 1700000000
	if w := request(t, s.Handler(), "GET", base+"&start="+strconv.Itoa(start)+"&end="+strconv.Itoa(start+31*24*3600), nil, nil); w.Code != 200 {
		t.Fatalf("31-day label window: %d %s", w.Code, w.Body)
	}
	if w := request(t, s.Handler(), "GET", base+"&start="+strconv.Itoa(start)+"&end="+strconv.Itoa(start+31*24*3600+1), nil, nil); w.Code != 400 {
		t.Fatalf("31-day-plus-one-second label window: %d %s", w.Code, w.Body)
	}
}

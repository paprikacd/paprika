package insights

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// stepRecorder answers every Prometheus range query with one sample and records
// the step each request carried, in arrival order.
type stepRecorder struct {
	mu    sync.Mutex
	steps []string
}

func (r *stepRecorder) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.steps = append(r.steps, req.URL.Query().Get("step"))
		r.mu.Unlock()
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[1700000000.5,"1"]]}]}}`)
	}))
	t.Cleanup(server.Close)
	return server
}

func (r *stepRecorder) sent() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.steps...)
}

// The provider minimum is authoritative: a finer requested step is raised before
// dispatch, the receipt keeps the requested step and reports the dispatched one,
// and a step at or above the minimum is sent unchanged.
func TestMetricsStepIsRaisedToTheProviderMinimum(t *testing.T) {
	cases := []struct {
		name       string
		configured float64
		requested  string
		wantSent   string
	}{
		{name: "the type default raises a 3 s step to 15 s", configured: 0, requested: "3", wantSent: "15"},
		{name: "a configured minimum raises a 3 s step", configured: 30, requested: "3", wantSent: "30"},
		{name: "a step at the minimum is sent unchanged", configured: 30, requested: "30", wantSent: "30"},
		{name: "a coarser step is sent unchanged", configured: 15, requested: "60", wantSent: "60"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			recorder := &stepRecorder{}
			upstream := recorder.server(t)
			s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL, MinStepSeconds: tt.configured})
			body := fmt.Sprintf(`{"providerId":"prometheus","kind":"metrics","query":"up","start":1700000000.5,"end":1700000600.5,"step":%s}`, tt.requested)
			d := readReceiptResult(t, request(t, s.Handler(), http.MethodPost, "/api/query", []byte(body), receiptHeaders())).Diagnostics
			require.Equal(t, []string{tt.wantSent}, recorder.sent(), "the provider must receive the raised step")
			require.Equal(t, tt.requested, fmt.Sprint(d.Requested.Step), "the receipt keeps the requested step")
			require.NotNil(t, d.Effective.Step)
			require.Equal(t, tt.wantSent, fmt.Sprint(*d.Effective.Step), "the receipt reports the dispatched step as effective")
		})
	}
}

// A step is only raised for a metrics query. Traces carry no step at all.
func TestMinimumStepDoesNotChangeTraceQueries(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.URL.Query().Get("step"))
		_, _ = io.WriteString(w, `{"traces":[]}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Traces", Type: "tempo", URL: upstream.URL})
	body := `{"providerId":"tempo","kind":"traces","query":"{}","start":1700000000.5,"end":1700000600.5}`
	d := readReceiptResult(t, request(t, s.Handler(), http.MethodPost, "/api/query", []byte(body), receiptHeaders())).Diagnostics
	require.Nil(t, d.Effective.Step)
}

// The provider list publishes the minimum so clients can plan steps. A Prometheus
// provider with no configured minimum publishes the 15 s default.
func TestProviderListPublishesMinimumStep(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:9090"},
		ProviderConfig{ID: "fine", Name: "Fine metrics", Type: "prometheus", URL: "http://127.0.0.1:9091", MinStepSeconds: 30},
		ProviderConfig{ID: "traces", Name: "Traces", Type: "tempo", URL: "http://127.0.0.1:3200"})
	w := request(t, s.Handler(), http.MethodGet, "/api/providers", nil, nil)
	require.Equal(t, http.StatusOK, w.Code, "%s", w.Body)
	body := w.Body.String()
	require.Contains(t, body, `"id":"prometheus"`)
	require.Contains(t, body, `"minStepSeconds":15`)
	require.Contains(t, body, `"minStepSeconds":30`)
	require.Equal(t, 2, strings.Count(body, `"minStepSeconds"`), "a provider that takes no step publishes none: %s", body)
}

// The configured minimum is bounded to (0, 3600] seconds, the same range the
// gateway accepts for a Prometheus step.
func TestProviderMinimumStepBounds(t *testing.T) {
	for _, bad := range []float64{-1, 3601} {
		_, err := newProvider(&ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:9090", MinStepSeconds: bad})
		require.Error(t, err, "minStepSeconds %v", bad)
	}
	for _, good := range []float64{0, 0.5, 3600} {
		_, err := newProvider(&ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:9090", MinStepSeconds: good})
		require.NoError(t, err, "minStepSeconds %v", good)
	}
}

// A shared catalog entry carries the gateway's declared minimum, or the type
// default when the gateway declares none. An out-of-range minimum fails the
// listing, as any malformed entry does.
func TestCatalogMinimumStepIsPublishedWithTypeDefault(t *testing.T) {
	listing, err := sharedProvidersFromCatalog([]observeCatalogProvider{
		{Name: "team-a/metrics", Namespace: "team-a", Type: "prometheus"},
		{Name: "team-a/fine", Namespace: "team-a", Type: "prometheus", MinStepSeconds: 30},
		{Name: "team-a/traces", Namespace: "team-a", Type: "tempo"},
	})
	require.NoError(t, err)
	byName := map[string]Provider{}
	for _, p := range listing.providers {
		byName[p.ProviderRef] = p
	}
	require.Equal(t, float64(15), byName["team-a/metrics"].MinStepSeconds)
	require.Equal(t, float64(30), byName["team-a/fine"].MinStepSeconds)
	require.Zero(t, byName["team-a/traces"].MinStepSeconds)

	_, err = sharedProvidersFromCatalog([]observeCatalogProvider{{Name: "team-a/metrics", Namespace: "team-a", Type: "prometheus", MinStepSeconds: 4000}})
	require.Error(t, err)
}

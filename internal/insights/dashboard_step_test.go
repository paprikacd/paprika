package insights

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// The dashboard reader picks each widget's step from its own provider's minimum.
// Here the default Prometheus minimum is 15 s and the second provider declares 30 s,
// so a 1h window is sampled at 15 s on one and at 30 s on the other. The range
// reports the coarsest of them, and only a signal whose step differs from the
// range carries its own stepSeconds.
func TestDashboardStepFollowsEachProviderMinimum(t *testing.T) {
	var mu sync.Mutex
	steps := map[string][]string{}
	server := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			steps[name] = append(steps[name], r.URL.Query().Get("step"))
			mu.Unlock()
			_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1792972800,"1"]]}]}}`)
		}))
	}
	defaultProvider, fineProvider := server("default"), server("fine")
	defer defaultProvider.Close()
	defer fineProvider.Close()
	s, _ := testService(t,
		ProviderConfig{ID: "prometheus", Name: "Default metrics", Type: "prometheus", URL: defaultProvider.URL},
		ProviderConfig{ID: "fine", Name: "Fine metrics", Type: "prometheus", URL: fineProvider.URL, MinStepSeconds: 30})
	onDefault := queryReadWidget("default-rate", "up")
	onFine := queryReadWidget("fine-rate", "up")
	onFine["providerId"] = "fine"
	putReadDashboard(t, s, onDefault, onFine)

	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	require.Equal(t, []string{"15"}, steps["default"], "the default Prometheus minimum gives a 1h window 15 s")
	require.Equal(t, []string{"30"}, steps["fine"], "a 30 s minimum raises the same window's step")
	require.Equal(t, 30.0, result.Range.StepSeconds, "the range reports the coarsest provider minimum")

	stepOf := map[string]*float64{}
	for _, signal := range result.Signals {
		stepOf[signal.ProviderID] = signal.StepSeconds
	}
	require.NotNil(t, stepOf["prometheus"], "a signal that differs from the range carries its step")
	require.Equal(t, 15.0, *stepOf["prometheus"])
	require.Nil(t, stepOf["fine"], "a signal at the range step carries none")
}

// The step a metrics signal reports is the one it was dispatched at, so a
// dashboard that repeats a single provider keeps its compact signals.
func TestDashboardSignalStepIsOmittedAtTheRangeStep(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, queryReadWidget("rate", "up"))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	require.Equal(t, 15.0, result.Range.StepSeconds)
	require.Len(t, result.Signals, 1)
	require.Nil(t, result.Signals[0].StepSeconds)
}

// A signal that was never dispatched reports no step: its planned step came from a provider that could not
// be resolved, so it is not a step the range ran at.
func TestDashboardSignalStepIsOmittedWhenNothingWasDispatched(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t,
		ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL},
		ProviderConfig{ID: "fine", Name: "Fine metrics", Type: "prometheus", URL: provider.URL, MinStepSeconds: 30})
	ok := queryReadWidget("rate", "up")
	missing := queryReadWidget("gone", "up")
	missing["providerId"] = "missing"
	putReadDashboard(t, s, ok, missing)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	require.Equal(t, 15.0, result.Range.StepSeconds)
	byProvider := map[string]DashboardSignal{}
	for _, signal := range result.Signals {
		byProvider[signal.ProviderID] = signal
	}
	require.Len(t, result.Signals, 2)
	for _, signal := range result.Signals {
		if signal.State == "error" {
			require.Nil(t, signal.StepSeconds, "an undispatched error signal carries no step")
		}
	}
}

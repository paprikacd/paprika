package insights

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// A query whose worker panics becomes one error signal in its own phase. Its siblings still answer, the response is 200,
// the panic value stays out of the response, and the panic is logged with the query's plan index and a stack.
func TestDashboardQueryPanicBecomesOneErrorSignal(t *testing.T) {
	const secret = "panic-detail-not-for-clients"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
	}))
	defer provider.Close()

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	for _, tc := range []struct {
		name        string
		phase       string
		parallelism int
	}{
		{name: "main phase, parallel", phase: "main", parallelism: 2},
		{name: "main phase, serial", phase: "main", parallelism: 1},
		{name: "comparison phase, parallel", phase: "comparison", parallelism: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs.Reset()
			s, _ := testServiceWithDashboardParallelism(t, tc.parallelism, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			s.dashboardFault = func(phase string, query *Query) {
				if phase == tc.phase && query.Query == "boom" {
					panic(secret)
				}
			}
			putReadDashboard(t, s, comparingStat("boom", "boom", "1d", "up"), comparingStat("steady", "steady", "1d", "up"))

			w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
			require.Equal(t, http.StatusOK, w.Code, "a worker panic must not fail the read")
			require.NotContains(t, w.Body.String(), secret, "the panic value must not reach the response")
			result := readDashboardResult(t, w)

			boom, steady := result.Widgets[0], result.Widgets[1]
			require.Equal(t, "boom", boom.ID)
			require.Equal(t, "steady", steady.ID)
			require.Equal(t, "ok", steady.Comparison.State, "a sibling query still answers")
			require.Equal(t, "ok", result.Signals[1].State, "the sibling's main signal still answers")
			if tc.phase == "main" {
				require.Equal(t, "error", result.Signals[0].State)
				require.NotNil(t, result.Signals[0].Error)
				require.Equal(t, "provider_error", result.Signals[0].Error.Code)
				require.Nil(t, result.Signals[0].LatencyMs, "a panicked query reports no latency")
			} else {
				require.Equal(t, "ok", result.Signals[0].State, "the main query of the panicking comparison still answers")
				require.Equal(t, "error", boom.Comparison.State)
				require.NotNil(t, boom.Comparison.Error)
				require.Equal(t, "provider_error", boom.Comparison.Error.Code)
			}
			// A failed comparison never changes the read's state; a failed main query does.
			wantState := "partial"
			if tc.phase == "comparison" {
				wantState = "ok"
			}
			require.Equal(t, wantState, result.State)

			logged := logs.String()
			require.Contains(t, logged, "dashboard query panicked")
			require.Contains(t, logged, secret, "the panic value is logged server-side")
			require.Contains(t, logged, "stack=", "the stack is logged server-side")
			require.Contains(t, logged, "index=", "the plan index is logged")
			require.Contains(t, logged, "goroutine ", "the logged stack is a goroutine dump")
		})
	}
}

package insights

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A signal reports the time its query spent after Insights admitted it. The provider sleeps
// for a known time, so an admitted signal must report at least that long, and a signal that
// was never admitted must report nothing.
func TestDashboardSignalsReportLatencyOnlyWhenAdmitted(t *testing.T) {
	const delay = 100 * time.Millisecond
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Query().Get("query") {
		case "slow-ok":
			time.Sleep(delay)
			_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1792972800,"1"]]}]}}`)
		case "slow-bad":
			time.Sleep(delay)
			http.Error(w, "upstream failed", http.StatusBadGateway)
		default:
			_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
		}
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, queryReadWidget("ok", "slow-ok"), queryReadWidget("bad", "slow-bad"))

	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","widget_ids":["ok","bad"],`+dashboardQueryWindow+`}`), nil))
	ok, failed := result.Signals[0], result.Signals[1]
	if ok.State != "ok" || ok.LatencyMs == nil || *ok.LatencyMs < delay.Milliseconds() {
		t.Fatalf("admitted successful signal must report at least the provider delay: %+v", ok)
	}
	if failed.Error == nil || failed.Error.Code != "provider_error" || failed.LatencyMs == nil || *failed.LatencyMs < delay.Milliseconds() {
		t.Fatalf("admitted failed signal must still report its execution time: %+v", failed)
	}

	// Admission refused: the signal never reached the gateway and carries no latency.
	s.queryWaitTimeout = 20 * time.Millisecond
	for range cap(s.queries) {
		s.queries <- struct{}{}
	}
	before := calls.Load()
	refused := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","widget_ids":["ok"]}`), nil))
	if refused.Signals[0].Error == nil || refused.Signals[0].Error.Code != "rate_limited" || refused.Signals[0].LatencyMs != nil || calls.Load() != before {
		t.Fatalf("refused signal must carry no latency: %+v", refused.Signals[0])
	}
}

func int64Ptr(v int64) *int64 { return &v }

func TestDashboardSignalLatencyIncludesAdmissionWait(t *testing.T) {
	admission := func(ms float64) QueryDiagnosticPhase {
		return QueryDiagnosticPhase{Name: "admission", DurationMs: &ms}
	}
	zero := 0.0
	upstream := QueryDiagnosticPhase{Name: "upstream", DurationMs: &zero}
	cases := []struct {
		name     string
		admitted bool
		diag     *QueryDiagnostics
		want     *int64
	}{
		{name: "not admitted", admitted: false, diag: &QueryDiagnostics{TotalMs: 40, Phases: []QueryDiagnosticPhase{admission(40)}}, want: nil},
		{name: "no receipt", admitted: true, diag: nil, want: nil},
		{name: "admission wait is included", admitted: true, diag: &QueryDiagnostics{TotalMs: 130.4, Phases: []QueryDiagnosticPhase{admission(30), upstream}}, want: int64Ptr(130)},
		{name: "rounds to whole milliseconds", admitted: true, diag: &QueryDiagnostics{TotalMs: 10.6, Phases: []QueryDiagnosticPhase{admission(0)}}, want: int64Ptr(11)},
		{name: "zero is kept", admitted: true, diag: &QueryDiagnostics{TotalMs: 0, Phases: []QueryDiagnosticPhase{admission(0)}}, want: int64Ptr(0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dashboardSignalLatency(tc.admitted, tc.diag)
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("want no latency, got %d", *got)
			case tc.want != nil && (got == nil || *got != *tc.want):
				t.Fatalf("want %d, got %v", *tc.want, got)
			}
		})
	}
}

// A read cancelled before it starts never admits its queries, so no signal reports a latency, at any parallelism.
func TestDashboardSignalsCancelledBeforeStartReportNoLatency(t *testing.T) {
	for _, parallelism := range []int{1, 2} {
		t.Run(fmt.Sprintf("parallelism %d", parallelism), func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
			}))
			defer provider.Close()
			s, _ := testServiceWithDashboardParallelism(t, parallelism, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			putReadDashboard(t, s, queryReadWidget("a", "a"), queryReadWidget("b", "b"), queryReadWidget("c", "c"))
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/query-dashboard", strings.NewReader(`{"id":"overview"}`))
			req.Header.Set("Authorization", "Bearer "+testToken)
			rec := httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, req)
			result := readDashboardResult(t, rec)
			require.Zero(t, calls.Load(), "a cancelled read runs no provider I/O")
			require.Len(t, result.Signals, 3)
			for _, signal := range result.Signals {
				require.NotNil(t, signal.Error)
				require.Equal(t, "canceled", signal.Error.Code)
				require.Nil(t, signal.LatencyMs, "%s: a query that was never admitted reports no latency", signal.ID)
			}
		})
	}
}

package observabilitygateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/prometheus"
)

// The budget header bounds a REST request's deadline. Anything absent, malformed
// or outside [1s, 30s] keeps queryTimeout, and a value inside it is never longer
// than queryTimeout.
func TestDashboardBudgetHeaderBoundsTheRequestDeadline(t *testing.T) {
	for _, tc := range []struct {
		name   string
		header string
		want   time.Duration
	}{
		{name: "absent", header: "", want: queryTimeout},
		{name: "zero", header: "0", want: queryTimeout},
		{name: "negative", header: "-5000", want: queryTimeout},
		{name: "non-numeric", header: "soon", want: queryTimeout},
		{name: "below the minimum", header: "999", want: queryTimeout},
		{name: "above the gateway bound", header: "60000", want: queryTimeout},
		{name: "within range", header: "1500", want: 1500 * time.Millisecond},
		{name: "at the upper bound", header: "30000", want: queryTimeout},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var remaining time.Duration
			handler := dashboardHandler(nil, "test", func(ctx context.Context, _ http.ResponseWriter, _ *http.Request) error {
				deadline, ok := ctx.Deadline()
				require.True(t, ok, "the request has a deadline")
				remaining = time.Until(deadline)
				return nil
			})
			request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/api/query", nil)
			if tc.header != "" {
				request.Header.Set(ObserveBudgetHeader, tc.header)
			}
			handler.ServeHTTP(httptest.NewRecorder(), request)
			require.LessOrEqual(t, remaining, tc.want)
			require.Greater(t, remaining, tc.want-time.Second, "the deadline is the header's budget, not the default")
		})
	}
}

// A slow backend ends at the caller's budget with the gateway timeout, not after
// the 30 s default.
func TestDashboardBudgetHeaderEndsASlowRequestAtItsBudget(t *testing.T) {
	handler := dashboardHandler(nil, "test", func(ctx context.Context, _ http.ResponseWriter, _ *http.Request) error {
		<-ctx.Done()
		return contextError(ctx)
	})
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/api/query", nil)
	request.Header.Set(ObserveBudgetHeader, "1000")
	recorder := httptest.NewRecorder()
	start := time.Now()
	handler.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusGatewayTimeout, recorder.Code)
	require.Less(t, time.Since(start), 10*time.Second)
}

// A Prometheus backend that keeps running past the caller's budget must not
// turn the slow query into a generic failure. The backend's own timeout is set
// past the budget, so the gateway deadline ends the request with its 504 and
// not with a 200 carrying state Error.
func TestPrometheusSlowQueryEndsAtTheBudgetWithGatewayTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seconds, err := strconv.Atoi(strings.TrimSuffix(r.URL.Query().Get("timeout"), "s"))
		if err != nil {
			seconds = 1
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(seconds) * time.Second):
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"error","errorType":"timeout","error":"query timed out"}`))
	}))
	t.Cleanup(server.Close)

	endpoint, err := json.Marshal(map[string]string{"endpoint": server.URL})
	require.NoError(t, err)
	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.Config.Raw = endpoint
	})).Build()
	b := &k8sBackend{client: cl, budget: newExecutionBudget(1, queryTimeout), newConnector: func(string) (connector.Connector, error) {
		return prometheus.New(), nil
	}}
	handler := dashboardHandler(nil, "test", func(ctx context.Context, _ http.ResponseWriter, _ *http.Request) error {
		_, err := b.Query(ctx, "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
		return err
	})
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/api/query", nil)
	request.Header.Set(ObserveBudgetHeader, "1500")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusGatewayTimeout, recorder.Code, recorder.Body.String())
}

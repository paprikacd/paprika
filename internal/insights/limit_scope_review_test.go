package insights

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// A gateway 502 inside its own server_error envelope says the provider request
// failed, so it is provider_error. A bare 502 (a proxy, a draining pod) or an
// unreachable gateway is gateway_unavailable.
func TestGateway502ClassifiesByEnvelope(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		json bool
		want string
	}{
		{"gateway envelope", `{"error":"server_error","error_description":"observability provider request failed"}`, true, "provider_error"},
		{"proxy page", `<html>bad gateway</html>`, false, "gateway_unavailable"},
		{"foreign json", `{"error":"something_else"}`, true, "gateway_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.json {
					w.Header().Set("Content-Type", "application/json")
				}
				w.WriteHeader(http.StatusBadGateway)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer gateway.Close()
			_, err := mustObserveGateway(t, gateway.URL).restDo(t.Context(), "alice", observeRESTQueryPath, map[string]string{}, 1<<20, nil)
			require.Error(t, err)
			assert.Equal(t, tc.want, classifyQueryFailure(err).Code)
		})
	}

	// A gateway that cannot be reached at all is the gateway's failure.
	closed := httptest.NewServer(http.NotFoundHandler())
	url := closed.URL
	closed.Close()
	_, err := mustObserveGateway(t, url).restDo(t.Context(), "alice", observeRESTQueryPath, map[string]string{}, 1<<20, nil)
	require.Error(t, err)
	assert.Equal(t, "gateway_unavailable", classifyQueryFailure(err).Code)
}

// The per-caller rate limit's 429 keeps its principal scope.
func TestObserveHTTPErrorForKeepsPrincipalScope(t *testing.T) {
	var remote *observeError
	require.ErrorAs(t, observeHTTPErrorFor(http.StatusTooManyRequests, "1", "principal"), &remote)
	assert.Equal(t, "principal", remote.scope)
	// "unknown" names no limit, so it is dropped and read as gateway-wide.
	require.ErrorAs(t, observeHTTPErrorFor(http.StatusTooManyRequests, "1", "unknown"), &remote)
	assert.Empty(t, remote.scope)
}

// Capacity refusals downstream of Insights are counted under closed label sets: a
// gateway 429 by the scope it named (unknown when none), a direct provider's 429
// as pool provider. Other failures are not counted.
func TestCountProviderRefusalLabels(t *testing.T) {
	s, _ := testService(t)
	reader := sdkmetric.NewManualReader()
	counter, err := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)).Meter("test").Int64Counter("paprika_insights_query_capacity_rejections")
	require.NoError(t, err)
	s.capacityRejections = counter

	s.countProviderRefusal(t.Context(), observeHTTPErrorFor(http.StatusTooManyRequests, "", "provider"))
	s.countProviderRefusal(t.Context(), observeHTTPErrorFor(http.StatusTooManyRequests, "", "gateway said hello"))
	s.countProviderRefusal(t.Context(), &providerHTTPError{status: http.StatusTooManyRequests})
	s.countProviderRefusal(t.Context(), errUpstream)
	s.countProviderRefusal(t.Context(), observeHTTPError(http.StatusBadGateway))

	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &rm))
	var got []string
	for _, scope := range rm.ScopeMetrics {
		for _, m := range scope.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			require.True(t, ok)
			for _, point := range sum.DataPoints {
				pool, _ := point.Attributes.Value(attribute.Key("pool"))
				label, _ := point.Attributes.Value(attribute.Key("scope"))
				got = append(got, pool.AsString()+"|"+label.AsString())
			}
		}
	}
	sort.Strings(got)
	assert.Equal(t, []string{"gateway|provider", "gateway|unknown", "provider|"}, got)
}

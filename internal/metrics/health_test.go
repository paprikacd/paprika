package metrics

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/expfmt"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	promexporter "go.opentelemetry.io/otel/exporters/prometheus"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	collectorpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

func TestHealthMetricsPrometheusAndOTLP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	received := make(chan []byte, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", http.StatusInternalServerError)
			return
		}
		select {
		case received <- data:
		default:
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(server.URL), otlpmetrichttp.WithCompression(otlpmetrichttp.NoCompression))
	require.NoError(t, err)
	registry := prometheus.NewRegistry()
	prom, err := promexporter.New(promexporter.WithRegisterer(registry))
	require.NoError(t, err)
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(prom), sdkmetric.WithReader(reader), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(time.Hour))))
	defer func() { require.NoError(t, provider.Shutdown(ctx)) }()
	h := newHealthInstruments(provider.Meter("health-test"))
	now := time.Unix(1800000000, 0).UTC()
	h.now = func() time.Time { return now }
	check := api.HealthCheck{Name: "internal", Interval: "30s", Expression: "true", HTTPProbe: &api.HTTPProbe{URL: "http://frontend.sfh.svc/deepcheck?token=do-not-export"}, SLO: &api.AvailabilitySLO{TargetPercentage: 99.9, Window: "30d"}}
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "sfh", Namespace: "sfh"}, Spec: api.ApplicationSpec{HealthChecks: []api.HealthCheck{check}}, Status: api.ApplicationStatus{HealthChecks: []api.HealthCheckResult{{Name: "internal", Status: api.HealthHealthy, CheckedAt: ptrTime(now), HTTPBody: "secret-response", SLOHistory: health.RecordSLO(check, nil, api.HealthHealthy, now)}}}}
	h.record(ctx, "sfh", "sfh", "internal", api.HealthHealthy, 125*time.Millisecond)
	h.replace(app)
	collected := collectHealthMetrics(t, reader)
	require.Equal(t, float64(1), healthGaugeValue(t, collected["paprika.healthcheck.up"]))
	require.EqualValues(t, 1, healthCounterValue(t, collected["paprika.healthcheck.observations"]))
	require.InDelta(t, .999, healthGaugeValue(t, collected["paprika.slo.target.ratio"]), 0.00001)
	families, err := registry.Gather()
	require.NoError(t, err)
	var rendered bytes.Buffer
	for _, family := range families {
		_, err = expfmt.MetricFamilyToText(&rendered, family)
		require.NoError(t, err)
	}
	require.Contains(t, rendered.String(), "paprika_healthcheck_up")
	require.Contains(t, rendered.String(), "paprika_slo_availability_ratio")
	require.NotContains(t, rendered.String(), "do-not-export")
	require.NotContains(t, rendered.String(), "secret-response")
	require.NoError(t, provider.ForceFlush(ctx))
	select {
	case data := <-received:
		var request collectorpb.ExportMetricsServiceRequest
		require.NoError(t, proto.Unmarshal(data, &request))
		found := map[string]bool{}
		for _, resource := range request.ResourceMetrics {
			for _, scope := range resource.ScopeMetrics {
				for _, m := range scope.Metrics {
					found[m.Name] = true
				}
			}
		}
		require.True(t, found["paprika.healthcheck.up"])
		require.True(t, found["paprika.slo.availability.ratio"])
		require.True(t, found["paprika.healthcheck.duration"])
	case <-ctx.Done():
		t.Fatal("OTLP did not receive health metrics")
	}
	// Stale observations stop exporting up=1; missing checks disappear entirely.
	now = now.Add(2 * time.Minute)
	stale := collectHealthMetrics(t, reader)
	_, exists := stale["paprika.healthcheck.up"]
	require.False(t, exists)
	require.Equal(t, float64(0), healthGaugeValue(t, stale["paprika.healthcheck.fresh"]))
	app.Spec.HealthChecks = nil
	h.replace(app)
	_, exists = collectHealthMetrics(t, reader)["paprika.healthcheck.last_observed"]
	require.False(t, exists)
}

func ptrTime(t time.Time) *metav1.Time { value := metav1.NewTime(t); return &value }

func collectHealthMetrics(t *testing.T, reader *sdkmetric.ManualReader) map[string]metricdata.Metrics {
	t.Helper()
	var data metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(context.Background(), &data))
	result := map[string]metricdata.Metrics{}
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			result[m.Name] = m
		}
	}
	return result
}

func healthGaugeValue(t *testing.T, m metricdata.Metrics) float64 {
	t.Helper()
	g, ok := m.Data.(metricdata.Gauge[float64])
	require.True(t, ok)
	require.Len(t, g.DataPoints, 1)
	return g.DataPoints[0].Value
}
func healthCounterValue(t *testing.T, m metricdata.Metrics) int64 {
	t.Helper()
	g, ok := m.Data.(metricdata.Sum[int64])
	require.True(t, ok)
	require.Len(t, g.DataPoints, 1)
	return g.DataPoints[0].Value
}

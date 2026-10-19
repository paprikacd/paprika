package metrics

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// readMetrics collects one scrape from a manual reader.
func readMetrics(t *testing.T, reader sdkmetric.Reader) metricdata.ResourceMetrics {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatalf("collect metrics: %v", err)
	}
	return collected
}

// gaugePoints returns the data points of a gauge by instrument name.
func gaugePoints(t *testing.T, collected metricdata.ResourceMetrics, name string) map[string]metricdata.Gauge[int64] {
	t.Helper()
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != name {
				continue
			}
			gauge, ok := m.Data.(metricdata.Gauge[int64])
			if !ok {
				t.Fatalf("%s is %T, want an int64 gauge", name, m.Data)
			}
			points := make(map[string]metricdata.Gauge[int64])
			for _, point := range gauge.DataPoints {
				key, _ := point.Attributes.Value(attribute.Key("cluster"))
				points[key.AsString()] = gauge
			}
			return points
		}
	}
	return nil
}

// TestSatelliteGaugesReportAgeOnlyAfterAReport pins the distinction between
// "no report yet" and "reported zero seconds ago". A zero age would tell an
// operator a silent satellite is current.
func TestSatelliteGaugesReportAgeOnlyAfterAReport(t *testing.T) {
	t.Parallel()

	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	_, err := registerSatelliteGauges(provider.Meter("satellite-test"), func(context.Context) []SatelliteObservation {
		return []SatelliteObservation{
			{Namespace: "paprika-system", Name: "reported", HasReport: true, ReportAgeSeconds: 42, Applications: 7},
			{Namespace: "paprika-system", Name: "silent", Applications: 0},
		}
	})
	if err != nil {
		t.Fatalf("register gauges: %v", err)
	}

	collected := readMetrics(t, reader)

	var age metricdata.Gauge[float64]
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name == "paprika.satellite.report.age" {
				gauge, ok := m.Data.(metricdata.Gauge[float64])
				if !ok {
					t.Fatalf("report age is %T, want a float64 gauge", m.Data)
				}
				age = gauge
			}
		}
	}
	if len(age.DataPoints) != 1 {
		t.Fatalf("report age points = %d, want 1 (only the reporting cluster)", len(age.DataPoints))
	}
	if got := age.DataPoints[0].Value; got != 42 {
		t.Fatalf("report age = %v, want 42", got)
	}

	applications := gaugePoints(t, collected, "paprika.satellite.applications")
	if len(applications) != 2 {
		t.Fatalf("application points = %d, want one per satellite", len(applications))
	}
}

// TestSatelliteLinkGaugeOnlyListsConnectedClusters keeps the gauge's meaning
// exact: a series exists only while the link does, so its presence is the
// signal rather than a value someone has to remember to set back to zero.
func TestSatelliteLinkGaugeOnlyListsConnectedClusters(t *testing.T) {
	t.Parallel()

	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	connected := []SatelliteLinkState{{Namespace: "paprika-system", Name: "edge"}}
	if _, err := registerSatelliteLinkGauge(provider.Meter("link-test"), func() []SatelliteLinkState {
		return connected
	}); err != nil {
		t.Fatalf("register link gauge: %v", err)
	}

	collected := readMetrics(t, reader)
	var points int
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "paprika.satellite.link.up" {
				continue
			}
			gauge, ok := m.Data.(metricdata.Gauge[int64])
			if !ok {
				t.Fatalf("link gauge is %T, want an int64 gauge", m.Data)
			}
			points = len(gauge.DataPoints)
			if points != 1 || gauge.DataPoints[0].Value != 1 {
				t.Fatalf("link points = %+v, want one point valued 1", gauge.DataPoints)
			}
		}
	}
	if points == 0 {
		t.Fatal("the link gauge produced no series for a connected cluster")
	}

	connected = nil
	collected = readMetrics(t, reader)
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "paprika.satellite.link.up" {
				continue
			}
			gauge, ok := m.Data.(metricdata.Gauge[int64])
			if !ok {
				t.Fatalf("link gauge is %T, want an int64 gauge", m.Data)
			}
			if len(gauge.DataPoints) != 0 {
				t.Fatalf("link points after detach = %d, want none", len(gauge.DataPoints))
			}
		}
	}
}

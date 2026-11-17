package metrics

import (
	"testing"

	"github.com/prometheus/otlptranslator"
)

// The exporter's namer, called on known instruments. A wrong entry here means
// the scanner would mis-name every instrument of that shape.
func TestExporterNamerKnownInstruments(t *testing.T) {
	cases := []struct {
		name string
		unit string
		typ  otlptranslator.MetricType
		want string
	}{
		{"paprika.render.total", "1", otlptranslator.MetricTypeMonotonicCounter, "paprika_render_total"},
		{"paprika.sync.total", "1", otlptranslator.MetricTypeMonotonicCounter, "paprika_sync_total"},
		{"paprika.git.operations", "1", otlptranslator.MetricTypeMonotonicCounter, "paprika_git_operations_total"},
		{"paprika.git.fetch.received", "By", otlptranslator.MetricTypeMonotonicCounter, "paprika_git_fetch_received_bytes_total"},
		{"paprika.releases.stuck", "{release}", otlptranslator.MetricTypeGauge, "paprika_releases_stuck"},
		{"paprika.fleet.index.degraded", "{state}", otlptranslator.MetricTypeGauge, "paprika_fleet_index_degraded"},
		{"paprika.applications.by_phase", "1", otlptranslator.MetricTypeGauge, "paprika_applications_by_phase_ratio"},
		{"paprika.slo.burn_rate", "1", otlptranslator.MetricTypeGauge, "paprika_slo_burn_rate_ratio"},
		{"paprika.healthcheck.last_observed", "s", otlptranslator.MetricTypeGauge, "paprika_healthcheck_last_observed_seconds"},
		{"paprika.sse.connections", "1", otlptranslator.MetricTypeNonMonotonicCounter, "paprika_sse_connections"},
		{"paprika.render.duration", "s", otlptranslator.MetricTypeHistogram, "paprika_render_duration_seconds"},
	}
	for _, c := range cases {
		got, err := exporterNamer.Build(otlptranslator.Metric{Name: c.name, Unit: c.unit, Type: c.typ})
		if err != nil {
			t.Fatalf("Build(%s): %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("Build(%s, unit %q) = %q, want %q", c.name, c.unit, got, c.want)
		}
	}
}

// The scanner must see the table-driven health gauges (newHealthInstruments),
// which have no literal name at their constructor call.
func TestScannerCoversHealthTable(t *testing.T) {
	defined := repoExportedMetricNames(t)
	for _, want := range []string{
		"paprika_healthcheck_up_ratio",
		"paprika_healthcheck_last_observed_seconds",
		"paprika_slo_availability_ratio",
		"paprika_slo_error_budget_remaining_ratio",
		"paprika_slo_state_ratio",
	} {
		if !defined[want] {
			t.Errorf("health table entry %s not scanned", want)
		}
	}
}

// Names that the chart and docs used to reference and that no code emits.
func TestScannerDoesNotDefinePhantoms(t *testing.T) {
	defined := repoExportedMetricNames(t)
	for _, phantom := range []string{
		"paprika_cluster_phase",
		"paprika_cache_errors_total",
		"paprika_webhook_errors_total",
		"paprika_ratelimit_denials_total",
		"paprika_sync_total_total",
	} {
		if defined[phantom] {
			t.Errorf("%s is defined; it must not be", phantom)
		}
	}
}

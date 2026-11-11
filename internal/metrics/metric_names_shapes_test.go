package metrics

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestScannerReadsEveryDefinitionShape pins the definition shapes the scanner
// must resolve, so a later refactor cannot silently drop one of them. Each
// fixture was also checked by mutating the repository (see the commit message).
func TestScannerReadsEveryDefinitionShape(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(root, rel)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o750))
		require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	}
	write("internal/shapes/consts.go", `package shapes

const probeName = "paprika.probe.const"
const probePrefix = "paprika."
`)
	write("internal/shapes/helpers.go", `package shapes

import (
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/metric"
)

func mustProbeHistogram(m metric.Meter, name string, opts ...metric.Float64HistogramOption) metric.Float64Histogram {
	h, _ := m.Float64Histogram(name, opts...)
	return h
}

var (
	constCounter = mustCounter(nil, probeName, "desc")
	helperHist   = mustProbeHistogram(nil, "paprika.probe.helper", metric.WithUnit("ms"))
	joined       = mustGauge(nil, probePrefix+"probe.joined.gauge", "s", "desc")
	promOpts     = prometheus.NewHistogram(prometheus.HistogramOpts{Namespace: "paprika", Subsystem: "probe", Name: "latency_seconds"})
	plainOpts    = prometheus.NewCounter(prometheus.CounterOpts{Name: "paprika_probe_plain_total"})
)

func mustCounter(m any, name, desc string) int   { return 0 }
func mustGauge(m any, name, unit, desc string) int { return 0 }
`)
	defs, err := scanMetricDefinitions(root)
	require.NoError(t, err)
	got := map[string]metricDefinition{}
	for _, def := range defs {
		got[def.Source] = def
	}
	want := map[string]struct{ exported, kind string }{
		"paprika.probe.const":           {"paprika_probe_const_total", "Counter"},
		"paprika.probe.helper":          {"paprika_probe_helper_milliseconds", "Histogram"},
		"paprika.probe.joined.gauge":    {"paprika_probe_joined_gauge_seconds", "Gauge"},
		"paprika_probe_latency_seconds": {"paprika_probe_latency_seconds", "Histogram"},
		"paprika_probe_plain_total":     {"paprika_probe_plain_total", "Counter"},
	}
	for source, expect := range want {
		def, ok := got[source]
		require.True(t, ok, "definition %s not scanned", source)
		require.Equal(t, expect.exported, def.Exported, source)
		require.Equal(t, expect.kind, def.Kind, source)
	}
}

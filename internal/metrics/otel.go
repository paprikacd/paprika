package metrics

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const meterName = "paprika"

var meter = otel.Meter(meterName)

// Render metrics
var (
	RenderDuration = mustHistogram(meter, "paprika.render.duration", "s",
		"Duration of template rendering", metric.WithExplicitBucketBoundaries(defBuckets...))

	RenderErrors = mustCounter(meter, "paprika.render.errors",
		"Number of template rendering errors")

	RenderTotal = mustCounter(meter, "paprika.render.total",
		"Number of templates rendered")
)

// Sync metrics
var (
	SyncTotal = mustCounter(meter, "paprika.sync.total",
		"Number of application sync operations")

	SyncErrors = mustCounter(meter, "paprika.sync.errors",
		"Number of sync errors")

	SyncDuration = mustHistogram(meter, "paprika.sync.duration", "s",
		"Duration of sync operations", metric.WithExplicitBucketBoundaries(defBuckets...))

	LastSyncTimestamp = mustGauge(meter, "paprika.sync.last_timestamp", "s",
		"Unix timestamp of the last successful sync")
)

// Auth metrics
var (
	AuthAttempts = mustCounter(meter, "paprika.auth.attempts",
		"Number of authentication attempts")

	AuthFailures = mustCounter(meter, "paprika.auth.failures",
		"Number of authentication failures")

	AuthzDenials = mustCounter(meter, "paprika.authz.denials",
		"Number of authorization denials")

	AuthzDecisions = mustCounter(meter, "paprika.authz.decisions",
		"Number of authorization decisions made")
)

// Git/source metrics
var (
	GitOperations = mustCounter(meter, "paprika.git.operations",
		"Number of git operations (clone/fetch)")

	GitErrors = mustCounter(meter, "paprika.git.errors",
		"Number of git operation errors")

	GitDuration = mustHistogram(meter, "paprika.git.duration", "s",
		"Duration of git operations", metric.WithExplicitBucketBoundaries(defBuckets...))

	SourceResolveTotal = mustCounter(meter, "paprika.source.resolve.total",
		"Number of source resolution operations")

	SourceResolveErrors = mustCounter(meter, "paprika.source.resolve.errors",
		"Number of source resolution errors")
)

// SSE / Event broker metrics
var (
	SSEConnections = mustUpDownCounter(meter, "paprika.sse.connections", "1",
		"Number of active SSE connections")

	EventsPublished = mustCounter(meter, "paprika.events.published",
		"Number of events published to the broker")
)

// Release/application gauges
var (
	ReleaseTransitions = mustCounter(meter, "paprika.release.transitions",
		"Number of release phase transitions")

	ActiveApplications = mustGauge(meter, "paprika.applications.active", "1",
		"Number of active applications")

	ApplicationsByPhase = mustGauge(meter, "paprika.applications.by_phase", "1",
		"Number of applications by phase")

	ActiveReleases = mustGauge(meter, "paprika.releases.active", "1",
		"Number of active (non-terminal) releases")

	ReleasesByPhase = mustGauge(meter, "paprika.releases.by_phase", "1",
		"Number of releases by phase")
)

var defBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}

func mustCounter(m metric.Meter, name, desc string) metric.Int64Counter {
	c, err := m.Int64Counter(name, metric.WithDescription(desc), metric.WithUnit("1"))
	if err != nil {
		panic(err)
	}
	return c
}

func mustHistogram(m metric.Meter, name, unit, desc string, opts ...metric.Int64HistogramOption) metric.Int64Histogram {
	allOpts := append([]metric.Int64HistogramOption{metric.WithDescription(desc), metric.WithUnit(unit)}, opts...)
	h, err := m.Int64Histogram(name, allOpts...)
	if err != nil {
		panic(err)
	}
	return h
}

func mustGauge(m metric.Meter, name, unit, desc string) metric.Int64ObservableGauge {
	g, err := m.Int64ObservableGauge(name, metric.WithDescription(desc), metric.WithUnit(unit))
	if err != nil {
		panic(err)
	}
	return g
}

func mustUpDownCounter(m metric.Meter, name, unit, desc string) metric.Int64UpDownCounter {
	c, err := m.Int64UpDownCounter(name, metric.WithDescription(desc), metric.WithUnit(unit))
	if err != nil {
		panic(err)
	}
	return c
}

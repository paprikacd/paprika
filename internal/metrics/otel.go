package metrics

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const meterName = "paprika"

var meter = otel.Meter(meterName)

// Render metrics
var (
	RenderDuration = mustFloatHistogram(meter, "paprika.render.duration", "s",
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

	SyncDuration = mustFloatHistogram(meter, "paprika.sync.duration", "s",
		"Duration of sync operations", metric.WithExplicitBucketBoundaries(defBuckets...))

	LastSyncTimestamp = mustGauge(meter, "paprika.sync.last_timestamp", "s",
		"Unix timestamp of the last successful sync")

	// SelectiveSyncTotal counts SyncResources-triggered filtered applies.
	SelectiveSyncTotal = mustCounter(meter, "paprika.sync.selective.total",
		"Number of selective (resource-filtered) sync applies")

	// SyncWaveWaitDuration records how long a wave gate waited for its
	// resources to become Healthy before the next wave applied.
	SyncWaveWaitDuration = mustFloatHistogram(meter, "paprika.sync.wave.wait.duration", "s",
		"Duration of sync-wave health gates", metric.WithExplicitBucketBoundaries(defBuckets...))

	// DryRunValidationTotal counts ServerSideValidate pre-flight runs by
	// outcome (result=pass|fail).
	DryRunValidationTotal = mustCounter(meter, "paprika.sync.validate.total",
		"Number of server-side validation pre-flights")

	// ResourcePatchTotal counts ApplyResourcePatch calls by outcome
	// (result=dry_run|applied|refused).
	ResourcePatchTotal = mustCounter(meter, "paprika.resource.patch.total",
		"Number of resource patch operations")
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

// API list metrics
var (
	APIListDuration = mustHistogram(meter, "paprika.api.list.duration", "ms",
		"Duration of API list handlers", metric.WithExplicitBucketBoundaries(msBuckets...))

	APIListErrors = mustCounter(meter, "paprika.api.list.errors",
		"Number of API list handler errors")

	APIListItems = mustHistogram(meter, "paprika.api.list.items", "1",
		"Number of objects returned by API list handlers", metric.WithExplicitBucketBoundaries(itemBuckets...))

	APICacheSyncDuration = mustHistogram(meter, "paprika.api.cache.sync.duration", "ms",
		"Duration of split API server Kubernetes informer cache sync", metric.WithExplicitBucketBoundaries(msBuckets...))
)

// Git/source metrics
var (
	GitOperations = mustCounter(meter, "paprika.git.operations",
		"Number of git operations (clone/fetch)")

	GitErrors = mustCounter(meter, "paprika.git.errors",
		"Number of git operation errors")

	GitDuration = mustFloatHistogram(meter, "paprika.git.duration", "s",
		"Duration of git operations", metric.WithExplicitBucketBoundaries(defBuckets...))

	SourceResolveTotal = mustCounter(meter, "paprika.source.resolve.total",
		"Number of source resolution operations")

	SourceResolveErrors = mustCounter(meter, "paprika.source.resolve.errors",
		"Number of source resolution errors")
)

// MCP metrics
var (
	MCPToolCalls = mustCounter(meter, "paprika.mcp.tool.calls",
		"Number of MCP tool calls by tool and outcome")

	MCPToolDuration = mustHistogram(meter, "paprika.mcp.tool.duration", "ms",
		"Duration of MCP tool invocations by tool and outcome",
		metric.WithExplicitBucketBoundaries(msBuckets...))

	MCPToolResponseBytes = mustHistogram(meter, "paprika.mcp.tool.response_bytes", "By",
		"Serialized size of MCP tool results by tool",
		metric.WithExplicitBucketBoundaries(256, 1024, 4096, 16384, 65536, 262144, 1048576))
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

// Control-plane health gauges. These turn "is Paprika keeping up?" into a
// direct series instead of a multi-step PromQL query: reconcile lag is the
// difference between the object's generation and the controller's observed
// generation, and the aggregate counters make the failure modes alertable
// without a join.
var (
	ApplicationReconcileLag = mustGauge(meter, "paprika.application.reconcile.lag", "{generation}",
		"Number of spec generations an application is behind its observed generation")

	ApplicationsStale = mustGauge(meter, "paprika.applications.stale", "{application}",
		"Number of applications whose observed generation is behind their spec generation")

	ApplicationsReleaseRetriesExhausted = mustGauge(meter, "paprika.applications.release_retries_exhausted", "{application}",
		"Number of applications holding the ReleaseRetriesExhausted condition")

	ReleasesStuck = mustGauge(meter, "paprika.releases.stuck", "{release}",
		"Number of active releases older than the stuck-release threshold")
)

var defBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}
var msBuckets = []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000}
var itemBuckets = []float64{0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000}

func mustCounter(m metric.Meter, name, desc string) metric.Int64Counter {
	c, err := m.Int64Counter(name, metric.WithDescription(desc), metric.WithUnit("1"))
	if err != nil {
		panic(err)
	}
	return c
}

func mustFloatHistogram(m metric.Meter, name, unit, desc string, opts ...metric.Float64HistogramOption) metric.Float64Histogram {
	allOpts := append([]metric.Float64HistogramOption{metric.WithDescription(desc), metric.WithUnit(unit)}, opts...)
	h, err := m.Float64Histogram(name, allOpts...)
	if err != nil {
		panic(err)
	}
	return h
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

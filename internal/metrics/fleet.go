package metrics

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// FleetOperation is a bounded fleet index operation attribute.
type FleetOperation string

const (
	FleetOperationBuild  FleetOperation = "build"
	FleetOperationUpdate FleetOperation = "update"
)

// FleetQueryKind is a bounded fleet query-kind attribute.
type FleetQueryKind string

const (
	FleetQueryProjectKeys  FleetQueryKind = "project_keys"
	FleetQueryApplications FleetQueryKind = "applications"
	FleetQueryMap          FleetQueryKind = "map"
	FleetQueryMatrix       FleetQueryKind = "matrix"
)

// FleetOutcome is a bounded fleet operation outcome attribute.
type FleetOutcome string

const (
	FleetOutcomeSuccess     FleetOutcome = "success"
	FleetOutcomeDegraded    FleetOutcome = "degraded"
	FleetOutcomeError       FleetOutcome = "error"
	FleetOutcomeUnavailable FleetOutcome = "unavailable"
)

// FleetCacheOutcome is a bounded fleet cache outcome attribute.
type FleetCacheOutcome string

const (
	FleetCacheHit   FleetCacheOutcome = "hit"
	FleetCacheMiss  FleetCacheOutcome = "miss"
	FleetCacheStale FleetCacheOutcome = "stale"
)

const fleetUnknownAttribute = "unknown"

type fleetIndexMetricState struct {
	itemCount  int64
	generation int64
}

type fleetInstruments struct {
	indexBuildDuration  metric.Float64Histogram
	indexUpdateDuration metric.Float64Histogram
	queryDuration       metric.Float64Histogram
	queryResults        metric.Int64Histogram
	indexItems          metric.Int64ObservableGauge
	indexGeneration     metric.Int64ObservableGauge
	rebuildFailures     metric.Int64Counter
	registration        metric.Registration
	state               atomic.Pointer[fleetIndexMetricState]
}

var defaultFleetInstruments = mustNewFleetInstruments(meter)

func newFleetInstruments(m metric.Meter) (*fleetInstruments, error) {
	indexBuildDuration, err := m.Float64Histogram(
		"paprika.fleet.index.build.duration",
		metric.WithDescription("Duration of full fleet index builds"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(defBuckets...),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet index build duration: %w", err)
	}
	indexUpdateDuration, err := m.Float64Histogram(
		"paprika.fleet.index.update.duration",
		metric.WithDescription("Duration of incremental fleet index updates"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(defBuckets...),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet index update duration: %w", err)
	}
	queryDuration, err := m.Float64Histogram(
		"paprika.fleet.query.duration",
		metric.WithDescription("Duration of cache-only fleet queries"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(defBuckets...),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet query duration: %w", err)
	}
	queryResults, err := m.Int64Histogram(
		"paprika.fleet.query.results",
		metric.WithDescription("Number of items returned by fleet queries"),
		metric.WithUnit("{item}"),
		metric.WithExplicitBucketBoundaries(itemBuckets...),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet query results: %w", err)
	}
	indexItems, err := m.Int64ObservableGauge(
		"paprika.fleet.index.items",
		metric.WithDescription("Number of applications in the installed fleet index snapshot"),
		metric.WithUnit("{application}"),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet index items: %w", err)
	}
	indexGeneration, err := m.Int64ObservableGauge(
		"paprika.fleet.index.generation",
		metric.WithDescription("Generation of the installed fleet index snapshot"),
		metric.WithUnit("{generation}"),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet index generation: %w", err)
	}
	rebuildFailures, err := m.Int64Counter(
		"paprika.fleet.index.rebuild.failures",
		metric.WithDescription("Number of failed fleet index rebuilds"),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, fmt.Errorf("create fleet rebuild failures: %w", err)
	}

	instruments := &fleetInstruments{
		indexBuildDuration:  indexBuildDuration,
		indexUpdateDuration: indexUpdateDuration,
		queryDuration:       queryDuration,
		queryResults:        queryResults,
		indexItems:          indexItems,
		indexGeneration:     indexGeneration,
		rebuildFailures:     rebuildFailures,
	}
	instruments.state.Store(&fleetIndexMetricState{})
	registration, err := m.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		state := instruments.state.Load()
		observer.ObserveInt64(instruments.indexItems, state.itemCount)
		observer.ObserveInt64(instruments.indexGeneration, state.generation)
		return nil
	}, instruments.indexItems, instruments.indexGeneration)
	if err != nil {
		return nil, fmt.Errorf("register fleet index metric callback: %w", err)
	}
	instruments.registration = registration
	return instruments, nil
}

func mustNewFleetInstruments(m metric.Meter) *fleetInstruments {
	instruments, err := newFleetInstruments(m)
	if err != nil {
		panic(err)
	}
	return instruments
}

func (f *fleetInstruments) unregister() error {
	if f == nil || f.registration == nil {
		return nil
	}
	if err := f.registration.Unregister(); err != nil {
		return fmt.Errorf("unregister fleet index metric callback: %w", err)
	}
	return nil
}

// RecordFleetIndexBuild records one full fleet-index build.
func RecordFleetIndexBuild(ctx context.Context, duration time.Duration, outcome FleetOutcome) {
	defaultFleetInstruments.recordIndexBuild(ctx, duration, outcome)
}

func (f *fleetInstruments) recordIndexBuild(ctx context.Context, duration time.Duration, outcome FleetOutcome) {
	f.indexBuildDuration.Record(
		ctx,
		nonNegativeSeconds(duration),
		metric.WithAttributes(
			attribute.String("operation", string(FleetOperationBuild)),
			attribute.String("outcome", normalizeFleetOutcome(outcome)),
		),
	)
}

// RecordFleetIndexUpdate records one incremental fleet-index update.
func RecordFleetIndexUpdate(ctx context.Context, duration time.Duration, outcome FleetOutcome) {
	defaultFleetInstruments.recordIndexUpdate(ctx, duration, outcome)
}

func (f *fleetInstruments) recordIndexUpdate(ctx context.Context, duration time.Duration, outcome FleetOutcome) {
	f.indexUpdateDuration.Record(
		ctx,
		nonNegativeSeconds(duration),
		metric.WithAttributes(
			attribute.String("operation", string(FleetOperationUpdate)),
			attribute.String("outcome", normalizeFleetOutcome(outcome)),
		),
	)
}

// RecordFleetIndexState publishes the latest successfully installed snapshot
// state. Callers intentionally do not update it after a failed rebuild, so the
// observable generation continues to describe the queryable snapshot.
func RecordFleetIndexState(itemCount, generation int64) {
	defaultFleetInstruments.recordIndexState(itemCount, generation)
}

func (f *fleetInstruments) recordIndexState(itemCount, generation int64) {
	next := &fleetIndexMetricState{
		itemCount:  max(itemCount, 0),
		generation: max(generation, 0),
	}
	for {
		current := f.state.Load()
		if current.generation > next.generation {
			return
		}
		if current.itemCount == next.itemCount && current.generation == next.generation {
			return
		}
		if f.state.CompareAndSwap(current, next) {
			return
		}
	}
}

// RecordFleetRebuildFailure increments the low-cardinality rebuild failure
// counter without accepting arbitrary attribute values.
func RecordFleetRebuildFailure(ctx context.Context, operation FleetOperation, outcome FleetOutcome) {
	defaultFleetInstruments.recordRebuildFailure(ctx, operation, outcome)
}

func (f *fleetInstruments) recordRebuildFailure(ctx context.Context, operation FleetOperation, outcome FleetOutcome) {
	f.rebuildFailures.Add(
		ctx,
		1,
		metric.WithAttributes(
			attribute.String("operation", normalizeFleetOperation(operation)),
			attribute.String("outcome", normalizeFleetOutcome(outcome)),
		),
	)
}

// RecordFleetQuery records one cache-only fleet query and its result count.
func RecordFleetQuery(
	ctx context.Context,
	kind FleetQueryKind,
	duration time.Duration,
	resultCount int64,
	activeDimensionCount int,
	cacheOutcome FleetCacheOutcome,
	outcome FleetOutcome,
) {
	defaultFleetInstruments.recordQuery(
		ctx,
		kind,
		duration,
		resultCount,
		activeDimensionCount,
		cacheOutcome,
		outcome,
	)
}

func (f *fleetInstruments) recordQuery(
	ctx context.Context,
	kind FleetQueryKind,
	duration time.Duration,
	resultCount int64,
	activeDimensionCount int,
	cacheOutcome FleetCacheOutcome,
	outcome FleetOutcome,
) {
	attributes := []attribute.KeyValue{
		attribute.String("query_kind", normalizeFleetQueryKind(kind)),
		attribute.String("outcome", normalizeFleetOutcome(outcome)),
		attribute.Int("active_dimension_count", min(max(activeDimensionCount, 0), 9)),
		attribute.String("cache_outcome", normalizeFleetCacheOutcome(cacheOutcome)),
	}
	options := metric.WithAttributes(attributes...)
	f.queryDuration.Record(ctx, nonNegativeSeconds(duration), options)
	f.queryResults.Record(ctx, max(resultCount, 0), options)
}

func nonNegativeSeconds(duration time.Duration) float64 {
	return max(duration.Seconds(), 0)
}

func normalizeFleetOperation(operation FleetOperation) string {
	switch operation {
	case FleetOperationBuild, FleetOperationUpdate:
		return string(operation)
	default:
		return fleetUnknownAttribute
	}
}

func normalizeFleetQueryKind(kind FleetQueryKind) string {
	switch kind {
	case FleetQueryProjectKeys, FleetQueryApplications, FleetQueryMap, FleetQueryMatrix:
		return string(kind)
	default:
		return fleetUnknownAttribute
	}
}

func normalizeFleetOutcome(outcome FleetOutcome) string {
	switch outcome {
	case FleetOutcomeSuccess, FleetOutcomeDegraded, FleetOutcomeError, FleetOutcomeUnavailable:
		return string(outcome)
	default:
		return fleetUnknownAttribute
	}
}

func normalizeFleetCacheOutcome(outcome FleetCacheOutcome) string {
	switch outcome {
	case FleetCacheHit, FleetCacheMiss, FleetCacheStale:
		return string(outcome)
	default:
		return fleetUnknownAttribute
	}
}

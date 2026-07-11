package fleet

import (
	"context"
	"math"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const fleetTracerName = "paprika/fleet"

type fleetTelemetryOutcome string

const (
	fleetTelemetrySuccess     fleetTelemetryOutcome = "success"
	fleetTelemetryDegraded    fleetTelemetryOutcome = "degraded"
	fleetTelemetryError       fleetTelemetryOutcome = "error"
	fleetTelemetryUnavailable fleetTelemetryOutcome = "unavailable"
)

type fleetCacheOutcome string

const (
	fleetCacheHit   fleetCacheOutcome = "hit"
	fleetCacheMiss  fleetCacheOutcome = "miss"
	fleetCacheStale fleetCacheOutcome = "stale"
)

type fleetQueryKind string

const (
	fleetQueryProjectKeys  fleetQueryKind = "project_keys"
	fleetQueryApplications fleetQueryKind = "applications"
	fleetQueryMap          fleetQueryKind = "map"
	fleetQueryMatrix       fleetQueryKind = "matrix"
)

type fleetSpanKind uint8

const (
	fleetSpanKindBuild fleetSpanKind = iota + 1
	fleetSpanKindUpdate
	fleetSpanKindQuery
)

// fleetSpanFields is deliberately numeric except for the bounded cache
// outcome. It cannot carry identities, request filters, cursors, endpoints,
// credentials, or provider query text into trace attributes.
type fleetSpanFields struct {
	Generation           uint64
	ItemCount            uint64
	ResultCount          uint64
	ProjectionErrorCount uint64
	DeltaCount           uint64
	CacheOutcome         fleetCacheOutcome
}

type fleetTelemetrySpan struct {
	span trace.Span
	kind fleetSpanKind
}

func startFleetIndexBuildSpan(ctx context.Context) (context.Context, fleetTelemetrySpan) {
	spanCtx, span := otel.Tracer(fleetTracerName).Start(
		ctx,
		"fleet.index.build",
		trace.WithAttributes(attribute.String("operation", "build")),
	)
	return spanCtx, fleetTelemetrySpan{span: span, kind: fleetSpanKindBuild}
}

func startFleetIndexUpdateSpan(ctx context.Context) (context.Context, fleetTelemetrySpan) {
	spanCtx, span := otel.Tracer(fleetTracerName).Start(
		ctx,
		"fleet.index.update",
		trace.WithAttributes(attribute.String("operation", "update")),
	)
	return spanCtx, fleetTelemetrySpan{span: span, kind: fleetSpanKindUpdate}
}

func startFleetQuerySpan(
	ctx context.Context,
	kind fleetQueryKind,
	activeDimensionCount int,
) (context.Context, fleetTelemetrySpan) {
	spanCtx, span := otel.Tracer(fleetTracerName).Start(
		ctx,
		"fleet.query",
		trace.WithAttributes(
			attribute.String("query_kind", normalizedFleetQueryKind(kind)),
			attribute.Int("active_dimension_count", boundedActiveDimensionCount(activeDimensionCount)),
		),
	)
	return spanCtx, fleetTelemetrySpan{span: span, kind: fleetSpanKindQuery}
}

// End records only the allowlisted, operation-appropriate fields and closes
// the span. It intentionally accepts no error value: exception messages may
// contain raw request or provider data, so callers report only a bounded
// outcome and keep detailed errors in their existing redacted logs.
func (s fleetTelemetrySpan) End(outcome fleetTelemetryOutcome, fields fleetSpanFields) {
	if s.span == nil {
		return
	}

	safeOutcome := normalizedFleetTelemetryOutcome(outcome)
	attributes := []attribute.KeyValue{attribute.String("outcome", string(safeOutcome))}
	if cacheOutcome, present := normalizedFleetCacheOutcome(fields.CacheOutcome); present {
		attributes = append(attributes, attribute.String("cache_outcome", cacheOutcome))
	}
	attributes = append(attributes, s.numericAttributes(fields)...)
	s.span.SetAttributes(attributes...)
	if safeOutcome == fleetTelemetrySuccess {
		s.span.SetStatus(codes.Ok, "")
	} else {
		s.span.SetStatus(codes.Error, string(safeOutcome))
	}
	s.span.End()
}

func (s fleetTelemetrySpan) numericAttributes(fields fleetSpanFields) []attribute.KeyValue {
	generation := attribute.Int64("generation", boundedTelemetryCount(fields.Generation))
	switch s.kind {
	case fleetSpanKindBuild:
		return []attribute.KeyValue{
			generation,
			attribute.Int64("item_count", boundedTelemetryCount(fields.ItemCount)),
			attribute.Int64("projection_error_count", boundedTelemetryCount(fields.ProjectionErrorCount)),
		}
	case fleetSpanKindUpdate:
		return []attribute.KeyValue{
			generation,
			attribute.Int64("item_count", boundedTelemetryCount(fields.ItemCount)),
			attribute.Int64("delta_count", boundedTelemetryCount(fields.DeltaCount)),
			attribute.Int64("projection_error_count", boundedTelemetryCount(fields.ProjectionErrorCount)),
		}
	case fleetSpanKindQuery:
		return []attribute.KeyValue{
			generation,
			attribute.Int64("result_count", boundedTelemetryCount(fields.ResultCount)),
		}
	default:
		return nil
	}
}

func normalizedFleetTelemetryOutcome(outcome fleetTelemetryOutcome) fleetTelemetryOutcome {
	switch outcome {
	case fleetTelemetrySuccess,
		fleetTelemetryDegraded,
		fleetTelemetryError,
		fleetTelemetryUnavailable:
		return outcome
	default:
		return fleetTelemetryError
	}
}

func normalizedFleetCacheOutcome(outcome fleetCacheOutcome) (string, bool) {
	switch outcome {
	case fleetCacheHit, fleetCacheMiss, fleetCacheStale:
		return string(outcome), true
	case "":
		return "", false
	default:
		return "unknown", true
	}
}

func normalizedFleetQueryKind(kind fleetQueryKind) string {
	switch kind {
	case fleetQueryProjectKeys,
		fleetQueryApplications,
		fleetQueryMap,
		fleetQueryMatrix:
		return string(kind)
	default:
		return "unknown"
	}
}

func boundedActiveDimensionCount(count int) int {
	if count < 0 {
		return 0
	}
	if count > 9 {
		return 9
	}
	return count
}

func boundedTelemetryCount(count uint64) int64 {
	if count > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(count) // #nosec G115 -- count is explicitly bounded to MaxInt64.
}

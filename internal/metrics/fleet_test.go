package metrics

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestFleetMetricContractAndAttributeAllowlist(t *testing.T) {
	instruments, reader := newTestFleetInstruments(t)

	ctx := context.Background()
	instruments.recordIndexState(12, 7)
	instruments.recordIndexState(99, 6)
	olderPublication := collectFleetMetrics(t, reader)
	requireFleetGaugePair(t, olderPublication, 12, 7,
		"a late older publication must not regress or split the installed snapshot gauges")

	instruments.recordIndexState(13, 7)
	instruments.recordIndexBuild(ctx, 1500*time.Millisecond, FleetOutcomeSuccess)
	instruments.recordIndexUpdate(ctx, 250*time.Millisecond, FleetOutcomeDegraded)
	instruments.recordRebuildFailure(ctx, FleetOperationUpdate, FleetOutcomeDegraded)
	instruments.recordQuery(
		ctx,
		FleetQueryApplications,
		100*time.Millisecond,
		4,
		12,
		FleetCacheHit,
		FleetOutcomeSuccess,
	)

	for _, sensitive := range []string{
		"search=customer-secret",
		"filters=project/payments",
		"cursor=opaque-production-cursor",
		"payments-api",
		"https://metrics.example.com",
		"Bearer credential-secret",
		`sum(rate(http_requests_total{project="payments"}[5m]))`,
	} {
		instruments.recordQuery(
			ctx,
			FleetQueryKind(sensitive),
			time.Millisecond,
			1,
			-4,
			FleetCacheOutcome(sensitive),
			FleetOutcome(sensitive),
		)
		instruments.recordRebuildFailure(
			ctx,
			FleetOperation(sensitive),
			FleetOutcome(sensitive),
		)
	}

	metrics := collectFleetMetrics(t, reader)
	requireFleetMetric(t, metrics, "paprika.fleet.index.build.duration", "s")
	requireFleetMetric(t, metrics, "paprika.fleet.index.update.duration", "s")
	requireFleetMetric(t, metrics, "paprika.fleet.query.duration", "s")
	requireFleetMetric(t, metrics, "paprika.fleet.index.items", "{application}")
	requireFleetMetric(t, metrics, "paprika.fleet.index.generation", "{generation}")
	requireFleetMetric(t, metrics, "paprika.fleet.query.results", "{item}")
	requireFleetMetric(t, metrics, "paprika.fleet.index.rebuild.failures", "1")

	build := metrics["paprika.fleet.index.build.duration"]
	buildHistogram, ok := build.Data.(metricdata.Histogram[float64])
	require.True(t, ok)
	require.Len(t, buildHistogram.DataPoints, 1)
	require.Equal(t, uint64(1), buildHistogram.DataPoints[0].Count)
	require.InDelta(t, 1.5, buildHistogram.DataPoints[0].Sum, 0.0001)

	requireFleetGaugePair(t, metrics, 13, 7,
		"an equal generation may atomically refresh its matching item count")

	results, ok := metrics["paprika.fleet.query.results"].Data.(metricdata.Histogram[int64])
	require.True(t, ok)
	var resultCount uint64
	var resultSum int64
	for _, point := range results.DataPoints {
		resultCount += point.Count
		resultSum += point.Sum
	}
	require.Equal(t, uint64(8), resultCount)
	require.Equal(t, int64(11), resultSum)

	allowedKeys := map[attribute.Key]struct{}{
		"operation":              {},
		"query_kind":             {},
		"outcome":                {},
		"active_dimension_count": {},
		"cache_outcome":          {},
	}
	allowedValues := map[attribute.Key]map[string]struct{}{
		"operation": {
			"build": {}, "update": {}, "unknown": {},
		},
		"query_kind": {
			"project_keys": {}, "applications": {}, "map": {}, "matrix": {}, "unknown": {},
		},
		"outcome": {
			"success": {}, "degraded": {}, "error": {}, "unavailable": {}, "unknown": {},
		},
		"cache_outcome": {
			"hit": {}, "miss": {}, "stale": {}, "unknown": {},
		},
	}
	for name, metric := range metrics {
		for _, attributes := range fleetMetricAttributeSets(metric.Data) {
			for _, keyValue := range attributes.ToSlice() {
				_, allowed := allowedKeys[keyValue.Key]
				require.Truef(t, allowed, "metric %s contains forbidden attribute key %q", name, keyValue.Key)
				if keyValue.Key == "active_dimension_count" {
					value := keyValue.Value.AsInt64()
					require.GreaterOrEqual(t, value, int64(0))
					require.LessOrEqual(t, value, int64(9))
					continue
				}
				_, allowed = allowedValues[keyValue.Key][keyValue.Value.AsString()]
				require.Truef(t, allowed, "metric %s contains unbounded %s value %q", name, keyValue.Key, keyValue.Value.AsString())
				serialized := strings.ToLower(string(keyValue.Key) + "=" + keyValue.Value.Emit())
				for _, forbidden := range []string{
					"customer-secret", "filters=", "cursor=", "payments-api", "metrics.example.com",
					"credential-secret", "http_requests_total", "promql",
				} {
					require.NotContainsf(t, serialized, forbidden, "metric %s leaked sensitive input", name)
				}
			}
		}
	}
}

func TestFleetMetricInstancesKeepGaugeStateIsolated(t *testing.T) {
	first, firstReader := newTestFleetInstruments(t)
	second, secondReader := newTestFleetInstruments(t)

	first.recordIndexState(41, 9)
	requireFleetGaugePair(t, collectFleetMetrics(t, firstReader), 41, 9,
		"the first meter must expose its installed snapshot")
	requireFleetGaugePair(t, collectFleetMetrics(t, secondReader), 0, 0,
		"a separately constructed meter must not inherit process-global gauge state")

	second.recordIndexState(7, 2)
	requireFleetGaugePair(t, collectFleetMetrics(t, firstReader), 41, 9,
		"updating a second meter must not contaminate the first")
	requireFleetGaugePair(t, collectFleetMetrics(t, secondReader), 7, 2,
		"the second meter must expose only its own state")
}

func newTestFleetInstruments(t *testing.T) (*fleetInstruments, *sdkmetric.ManualReader) {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	instruments, err := newFleetInstruments(provider.Meter(meterName))
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, instruments.unregister())
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	return instruments, reader
}

func requireFleetGaugePair(
	t *testing.T,
	metrics map[string]metricdata.Metrics,
	wantItems int64,
	wantGeneration int64,
	message string,
) {
	t.Helper()
	items, ok := metrics["paprika.fleet.index.items"].Data.(metricdata.Gauge[int64])
	require.True(t, ok)
	require.Len(t, items.DataPoints, 1)
	generation, ok := metrics["paprika.fleet.index.generation"].Data.(metricdata.Gauge[int64])
	require.True(t, ok)
	require.Len(t, generation.DataPoints, 1)
	require.Equal(t, wantItems, items.DataPoints[0].Value, message)
	require.Equal(t, wantGeneration, generation.DataPoints[0].Value, message)
}

func collectFleetMetrics(t *testing.T, reader *sdkmetric.ManualReader) map[string]metricdata.Metrics {
	t.Helper()
	var resourceMetrics metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(context.Background(), &resourceMetrics))
	metrics := make(map[string]metricdata.Metrics)
	for _, scope := range resourceMetrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if strings.HasPrefix(metric.Name, "paprika.fleet.") {
				metrics[metric.Name] = metric
			}
		}
	}
	return metrics
}

func requireFleetMetric(t *testing.T, metrics map[string]metricdata.Metrics, name, unit string) {
	t.Helper()
	metric, ok := metrics[name]
	require.Truef(t, ok, "missing metric %s", name)
	require.Equal(t, unit, metric.Unit)
	require.NotEmpty(t, metric.Description)
}

func fleetMetricAttributeSets(aggregation metricdata.Aggregation) []attribute.Set {
	switch data := aggregation.(type) {
	case metricdata.Histogram[float64]:
		sets := make([]attribute.Set, 0, len(data.DataPoints))
		for _, point := range data.DataPoints {
			sets = append(sets, point.Attributes)
		}
		return sets
	case metricdata.Histogram[int64]:
		sets := make([]attribute.Set, 0, len(data.DataPoints))
		for _, point := range data.DataPoints {
			sets = append(sets, point.Attributes)
		}
		return sets
	case metricdata.Gauge[int64]:
		sets := make([]attribute.Set, 0, len(data.DataPoints))
		for _, point := range data.DataPoints {
			sets = append(sets, point.Attributes)
		}
		return sets
	case metricdata.Sum[int64]:
		sets := make([]attribute.Set, 0, len(data.DataPoints))
		for _, point := range data.DataPoints {
			sets = append(sets, point.Attributes)
		}
		return sets
	default:
		return nil
	}
}

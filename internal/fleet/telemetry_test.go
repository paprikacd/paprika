package fleet

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestFleetQueryObservationKeepsTheSnapshotUsedByTheQuery(t *testing.T) {
	exporter := installFleetTestTracer(t)
	project := ProjectKey{Namespace: "apps", Name: "retail"}
	oldApplication := paginationApplication("apps", "checkout", project)
	index := NewIndex()
	require.NoError(t, index.Install(paginationSnapshot(7, oldApplication)))
	usedSnapshot := requireSnapshot(t, index)

	observation := startFleetQueryObservation(
		context.Background(), fleetQueryApplications,
		"applications", 0,
	)
	require.NoError(t, index.Install(paginationSnapshot(8,
		oldApplication,
		paginationApplication("apps", "worker", project),
	)))
	observation.observeSnapshot(usedSnapshot, fleetCacheHit)
	observation.fields.ResultCount = 1
	observation.end(nil)

	spans := exporter.GetSpans()
	require.Len(t, spans, 1)
	requireFleetSpanAttributes(t, spans[0], "fleet.query", map[string]any{
		"generation":   boundedTelemetryCount(usedSnapshot.Generation),
		"result_count": int64(1),
	})
}

func TestFleetIndexRecordersKeepTheirOperationSnapshot(t *testing.T) {
	exporter := installFleetTestTracer(t)
	project := ProjectKey{Namespace: "apps", Name: "retail"}
	oldApplication := paginationApplication("apps", "checkout", project)
	index := NewIndex()
	require.NoError(t, index.Install(paginationSnapshot(7, oldApplication)))
	usedSnapshot := requireSnapshot(t, index)
	operationFields, operationInstalled := fleetSnapshotSpanFields(usedSnapshot)

	require.NoError(t, index.Install(paginationSnapshot(8,
		oldApplication,
		paginationApplication("apps", "worker", project),
	)))
	ctx, buildSpan := startFleetIndexBuildSpan(context.Background())
	recordFleetBuildTelemetry(
		ctx, time.Now(), buildSpan, operationFields, operationInstalled,
		ProjectionResult{}, nil, false,
	)
	ctx, updateSpan := startFleetIndexUpdateSpan(context.Background())
	recordFleetUpdateTelemetry(
		ctx, time.Now(), updateSpan, operationFields, operationInstalled,
		ProjectionResult{}, nil, 1,
	)

	spans := exporter.GetSpans()
	require.Len(t, spans, 2)
	for _, span := range spans {
		requireFleetSpanAttributes(t, span, span.Name, map[string]any{
			"generation": boundedTelemetryCount(usedSnapshot.Generation),
			"item_count": int64(len(usedSnapshot.Applications)),
		})
	}
}

func TestFleetMapQueryResultCountIsReturnedRootCount(t *testing.T) {
	exporter := installFleetTestTracer(t)
	project := ProjectKey{Namespace: "apps", Name: "retail"}
	index := NewIndex()
	require.NoError(t, index.Install(paginationSnapshot(11,
		paginationApplication("apps", "checkout", project),
		paginationApplication("apps", "worker", project),
	)))

	result, err := index.QueryMap(
		context.Background(),
		QueryScope{Projects: ProjectSet{project: {}}},
		FleetMapQuery{},
	)
	require.NoError(t, err)
	require.Equal(t, uint64(2), result.Total)
	require.Len(t, result.Roots, 1)

	spans := exporter.GetSpans()
	require.Len(t, spans, 1)
	requireFleetSpanAttributes(t, spans[0], "fleet.query", map[string]any{
		"generation":   int64(11),
		"result_count": int64(1),
	})
}

func TestFleetTelemetrySkipsEmptyUpdateBatch(t *testing.T) {
	exporter := installFleetTestTracer(t)
	store, _, _ := populatedProjectionStore()
	rebuilder := NewRebuilder(NewIndex(), store)

	result, err := rebuilder.ApplyDeltas(context.Background(), nil)
	require.NoError(t, err)
	require.Equal(t, ProjectionResult{}, result)
	require.Empty(t, exporter.GetSpans())
}

func TestFleetRuntimeBarrierDoesNotEmitSyntheticUpdate(t *testing.T) {
	exporter := installFleetTestTracer(t)
	store, _, _ := populatedProjectionStore()
	runtime, err := NewRuntime(newFakeRuntimeInformerSource(), store, NewIndex())
	require.NoError(t, err)
	_, err = runtime.rebuilder.Rebuild(context.Background())
	require.NoError(t, err)

	barrierDone := runtime.enqueueBarrier()
	workerDone := make(chan error, 1)
	go func() { workerDone <- runtime.runWorker(context.Background()) }()
	select {
	case <-barrierDone:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for fleet runtime barrier")
	}
	runtime.queue.ShutDownWithDrain()
	require.NoError(t, <-workerDone)

	spans := exporter.GetSpans()
	require.Len(t, spans, 1)
	require.Equal(t, "fleet.index.build", spans[0].Name)
}

func TestFleetTelemetryInstrumentsRebuildUpdateAndReaderQueries(t *testing.T) {
	exporter := installFleetTestTracer(t)
	store, applicationID, projectID := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)

	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	store.mutateApplication(applicationID, func(app *pipelinesv1alpha1.Application) {
		app.Status.SourceRevision = "resolved-2"
	})
	_, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceApplication,
		Key:  applicationID,
	})
	require.NoError(t, err)

	projects, err := index.ProjectKeys(context.Background(), []string{"apps"})
	require.NoError(t, err)
	require.Equal(t, []ProjectKey{projectID}, projects)
	scope := QueryScope{Projects: ProjectSet{projectID: {}}}
	page, err := index.QueryApplications(context.Background(), scope, ApplicationQuery{
		Filter: ApplicationFilter{
			Projects:   []ProjectKey{projectID},
			Namespaces: []string{"apps"},
		},
	}, "")
	require.NoError(t, err)
	require.Len(t, page.Applications, 1)
	mapResult, err := index.QueryMap(context.Background(), scope, FleetMapQuery{})
	require.NoError(t, err)
	require.Equal(t, uint64(1), mapResult.Total)
	matrix, err := index.QueryMatrix(context.Background(), scope, FleetMatrixQuery{
		RowGroup:    GroupDimensionProject,
		ColumnGroup: GroupDimensionHealth,
	})
	require.NoError(t, err)
	require.Len(t, matrix.Cells, 1)

	spans := exporter.GetSpans()
	require.Len(t, spans, 6)
	requireFleetSpanAttributes(t, spans[0], "fleet.index.build", map[string]any{
		"operation":              "build",
		"outcome":                "success",
		"generation":             int64(1),
		"item_count":             int64(1),
		"projection_error_count": int64(0),
	})
	requireFleetSpanAttributes(t, spans[1], "fleet.index.update", map[string]any{
		"operation":              "update",
		"outcome":                "success",
		"generation":             int64(2),
		"item_count":             int64(1),
		"delta_count":            int64(1),
		"projection_error_count": int64(0),
	})
	requireFleetSpanAttributes(t, spans[2], "fleet.query", map[string]any{
		"query_kind":             "project_keys",
		"outcome":                "success",
		"cache_outcome":          "hit",
		"active_dimension_count": int64(1),
		"generation":             int64(2),
		"result_count":           int64(1),
	})
	requireFleetSpanAttributes(t, spans[3], "fleet.query", map[string]any{
		"query_kind":             "applications",
		"outcome":                "success",
		"cache_outcome":          "hit",
		"active_dimension_count": int64(2),
		"generation":             int64(2),
		"result_count":           int64(1),
	})
	requireFleetSpanAttributes(t, spans[4], "fleet.query", map[string]any{
		"query_kind":             "map",
		"outcome":                "success",
		"cache_outcome":          "hit",
		"active_dimension_count": int64(0),
		"generation":             int64(2),
		"result_count":           int64(1),
	})
	requireFleetSpanAttributes(t, spans[5], "fleet.query", map[string]any{
		"query_kind":             "matrix",
		"outcome":                "success",
		"cache_outcome":          "hit",
		"active_dimension_count": int64(0),
		"generation":             int64(2),
		"result_count":           int64(1),
	})
}

func TestFleetTelemetryFailedRebuildIsDegradedAndRetainsGeneration(t *testing.T) {
	exporter := installFleetTestTracer(t)
	store, _, projectID := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	prior := requireSnapshot(t, index)
	exporter.Reset()

	sensitive := strings.Join([]string{
		"https://user",
		"credential@example.invalid/api?query=sum(rate(private_total[5m]))",
	}, ":")
	store.setListError(ResourceStage, errors.New(sensitive))
	_, err = rebuilder.Rebuild(context.Background())
	require.Error(t, err)
	require.Same(t, prior, requireSnapshot(t, index))
	require.Equal(t, uint64(1), prior.Generation)
	require.Error(t, index.CheckReady())

	scope := QueryScope{Projects: ProjectSet{projectID: {}}}
	page, err := index.QueryApplications(context.Background(), scope, ApplicationQuery{}, "")
	require.NoError(t, err)
	require.Len(t, page.Applications, 1)

	spans := exporter.GetSpans()
	require.Len(t, spans, 2)
	requireFleetSpanAttributes(t, spans[0], "fleet.index.build", map[string]any{
		"operation":              "build",
		"outcome":                "degraded",
		"cache_outcome":          "stale",
		"generation":             int64(1),
		"item_count":             int64(1),
		"projection_error_count": int64(0),
	})
	requireFleetSpanAttributes(t, spans[1], "fleet.query", map[string]any{
		"query_kind":             "applications",
		"outcome":                "success",
		"cache_outcome":          "stale",
		"active_dimension_count": int64(0),
		"generation":             int64(1),
		"result_count":           int64(1),
	})
	for _, span := range spans {
		require.Empty(t, span.Events)
		require.NotContains(t, strings.ToLower(span.Status.Description), "secret")
		for _, value := range fleetSpanAttributes(span.Attributes) {
			require.NotContains(t, strings.ToLower(valueString(value)), strings.ToLower(sensitive))
		}
	}
}

func TestFleetTelemetryUnavailableQueryRecordsCacheMiss(t *testing.T) {
	exporter := installFleetTestTracer(t)
	index := NewIndex()

	_, err := index.ProjectKeys(context.Background(), nil)
	require.ErrorAs(t, err, new(*ErrUnavailable))

	spans := exporter.GetSpans()
	require.Len(t, spans, 1)
	requireFleetSpanAttributes(t, spans[0], "fleet.query", map[string]any{
		"query_kind":             "project_keys",
		"outcome":                "unavailable",
		"cache_outcome":          "miss",
		"active_dimension_count": int64(0),
		"generation":             int64(0),
		"result_count":           int64(0),
	})
}

func TestFleetSpanNamesAndAllowedAttributes(t *testing.T) {
	exporter := installFleetTestTracer(t)
	ctx := context.Background()

	_, buildSpan := startFleetIndexBuildSpan(ctx)
	buildSpan.End(fleetTelemetrySuccess, fleetSpanFields{
		Generation:           7,
		ItemCount:            41,
		ProjectionErrorCount: 2,
		CacheOutcome:         fleetCacheHit,
	})

	_, updateSpan := startFleetIndexUpdateSpan(ctx)
	updateSpan.End(fleetTelemetryDegraded, fleetSpanFields{
		Generation:           8,
		ItemCount:            40,
		DeltaCount:           3,
		ProjectionErrorCount: 1,
		CacheOutcome:         fleetCacheStale,
	})

	_, querySpan := startFleetQuerySpan(ctx, fleetQueryApplications, 12)
	querySpan.End(fleetTelemetrySuccess, fleetSpanFields{
		Generation:   8,
		ResultCount:  25,
		CacheOutcome: fleetCacheHit,
	})

	spans := fleetSpansByName(exporter.GetSpans())
	require.Equal(t, map[string]map[string]any{
		"fleet.index.build": {
			"operation":              "build",
			"outcome":                "success",
			"cache_outcome":          "hit",
			"generation":             int64(7),
			"item_count":             int64(41),
			"projection_error_count": int64(2),
		},
		"fleet.index.update": {
			"operation":              "update",
			"outcome":                "degraded",
			"cache_outcome":          "stale",
			"generation":             int64(8),
			"item_count":             int64(40),
			"delta_count":            int64(3),
			"projection_error_count": int64(1),
		},
		"fleet.query": {
			"query_kind":             "applications",
			"outcome":                "success",
			"cache_outcome":          "hit",
			"active_dimension_count": int64(9),
			"generation":             int64(8),
			"result_count":           int64(25),
		},
	}, spans)
}

func TestFleetSpanStatusUsesOnlySafeOutcomes(t *testing.T) {
	exporter := installFleetTestTracer(t)

	_, successSpan := startFleetIndexBuildSpan(context.Background())
	successSpan.End(fleetTelemetrySuccess, fleetSpanFields{})
	_, degradedSpan := startFleetIndexUpdateSpan(context.Background())
	degradedSpan.End(fleetTelemetryDegraded, fleetSpanFields{})
	_, unavailableSpan := startFleetQuerySpan(context.Background(), fleetQueryMatrix, 0)
	unavailableSpan.End(fleetTelemetryUnavailable, fleetSpanFields{CacheOutcome: fleetCacheMiss})

	spans := exporter.GetSpans()
	require.Len(t, spans, 3)
	require.Equal(t, codes.Ok, spans[0].Status.Code)
	require.Empty(t, spans[0].Status.Description)
	require.Equal(t, codes.Error, spans[1].Status.Code)
	require.Equal(t, "degraded", spans[1].Status.Description)
	require.Equal(t, codes.Error, spans[2].Status.Code)
	require.Equal(t, "unavailable", spans[2].Status.Description)
	for _, span := range spans {
		require.Empty(t, span.Events, "raw errors must never be recorded as span events")
	}
}

func TestFleetSpanSanitizesUntrustedEnumValuesAndBoundsNumbers(t *testing.T) {
	exporter := installFleetTestTracer(t)
	sensitiveValues := []string{
		"search=production payments",
		"cursor=eyJwcm9qZWN0Ijoic2VjcmV0In0",
		"project=tenant/payments",
		"application=checkout",
		"endpoint=https://metrics.internal",
		"credential=super-secret-token",
		"promql=sum(rate(http_requests_total[5m]))",
	}

	for index, sensitive := range sensitiveValues {
		_, span := startFleetQuerySpan(
			context.Background(),
			fleetQueryKind(sensitive),
			-index-1,
		)
		span.End(fleetTelemetryOutcome(sensitive), fleetSpanFields{
			Generation:           math.MaxUint64,
			ResultCount:          math.MaxUint64,
			ProjectionErrorCount: math.MaxUint64,
			CacheOutcome:         fleetCacheOutcome(sensitive),
		})
	}

	allowedKeys := map[string]struct{}{
		"query_kind":             {},
		"outcome":                {},
		"cache_outcome":          {},
		"active_dimension_count": {},
		"generation":             {},
		"result_count":           {},
	}
	for _, span := range exporter.GetSpans() {
		require.Equal(t, "fleet.query", span.Name)
		attributes := fleetSpanAttributes(span.Attributes)
		for key, value := range attributes {
			_, allowed := allowedKeys[key]
			require.Truef(t, allowed, "unexpected fleet span attribute %q", key)
			for _, sensitive := range sensitiveValues {
				require.NotContains(t, strings.ToLower(valueString(value)), strings.ToLower(sensitive))
			}
		}
		require.Equal(t, "unknown", attributes["query_kind"])
		require.Equal(t, "error", attributes["outcome"])
		require.Equal(t, "unknown", attributes["cache_outcome"])
		require.Equal(t, int64(0), attributes["active_dimension_count"])
		require.Equal(t, int64(math.MaxInt64), attributes["generation"])
		require.Equal(t, int64(math.MaxInt64), attributes["result_count"])
		require.Equal(t, codes.Error, span.Status.Code)
		require.Equal(t, "error", span.Status.Description)
		require.Empty(t, span.Events)
	}
}

func TestFleetSpanSupportsEveryQueryKindAndDimensionBoundary(t *testing.T) {
	exporter := installFleetTestTracer(t)
	tests := []struct {
		kind       fleetQueryKind
		dimensions int
		wantKind   string
		wantCount  int64
	}{
		{kind: fleetQueryProjectKeys, dimensions: 0, wantKind: "project_keys", wantCount: 0},
		{kind: fleetQueryApplications, dimensions: 1, wantKind: "applications", wantCount: 1},
		{kind: fleetQueryMap, dimensions: 8, wantKind: "map", wantCount: 8},
		{kind: fleetQueryMatrix, dimensions: 9, wantKind: "matrix", wantCount: 9},
	}
	for _, test := range tests {
		_, span := startFleetQuerySpan(context.Background(), test.kind, test.dimensions)
		span.End(fleetTelemetrySuccess, fleetSpanFields{})
	}

	spans := exporter.GetSpans()
	require.Len(t, spans, len(tests))
	for index, test := range tests {
		attributes := fleetSpanAttributes(spans[index].Attributes)
		require.Equal(t, test.wantKind, attributes["query_kind"])
		require.Equal(t, test.wantCount, attributes["active_dimension_count"])
	}
}

func installFleetTestTracer(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	return exporter
}

func fleetSpansByName(spans tracetest.SpanStubs) map[string]map[string]any {
	result := make(map[string]map[string]any, len(spans))
	for _, span := range spans {
		result[span.Name] = fleetSpanAttributes(span.Attributes)
	}
	return result
}

func fleetSpanAttributes(attributes []attribute.KeyValue) map[string]any {
	result := make(map[string]any, len(attributes))
	for _, attr := range attributes {
		result[string(attr.Key)] = attr.Value.AsInterface()
	}
	return result
}

func valueString(value any) string {
	if stringValue, ok := value.(string); ok {
		return stringValue
	}
	return ""
}

func requireFleetSpanAttributes(
	t *testing.T,
	span tracetest.SpanStub,
	wantName string,
	wantAttributes map[string]any,
) {
	t.Helper()
	require.Equal(t, wantName, span.Name)
	attributes := fleetSpanAttributes(span.Attributes)
	for key, value := range wantAttributes {
		require.Equalf(t, value, attributes[key], "span attribute %q", key)
	}
	allowedKeys := map[string]struct{}{
		"operation":              {},
		"query_kind":             {},
		"outcome":                {},
		"active_dimension_count": {},
		"cache_outcome":          {},
		"generation":             {},
		"item_count":             {},
		"result_count":           {},
		"projection_error_count": {},
		"delta_count":            {},
	}
	for key := range attributes {
		_, allowed := allowedKeys[key]
		require.Truef(t, allowed, "unexpected fleet telemetry attribute %q", key)
	}
	require.Empty(t, span.Events)
}

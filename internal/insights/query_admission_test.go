package insights

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// queryCounts reads paprika_insights_queries as a map keyed by provider and outcome.
func queryCounts(t *testing.T, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &rm))
	counts := map[string]int64{}
	for _, scope := range rm.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "paprika_insights_queries" {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			require.True(t, ok)
			for _, point := range sum.DataPoints {
				provider, _ := point.Attributes.Value(attribute.Key("provider"))
				outcome, _ := point.Attributes.Value(attribute.Key("outcome"))
				counts[provider.AsString()+"|"+outcome.AsString()] += point.Value
			}
		}
	}
	return counts
}

// saturatedCatalog fills every catalog phase and every waiting place, so a shared
// query is refused at once without contacting the gateway.
func saturatedCatalog(s *Server) {
	for range cap(s.catalogPhases) {
		s.catalogPhases <- struct{}{}
	}
	for range cap(s.catalogWaiting) {
		s.catalogWaiting <- struct{}{}
	}
}

func meteredService(t *testing.T) (*Server, *sdkmetric.ManualReader) {
	t.Helper()
	// The gateway is never reached: every test below stops before the catalog listing.
	s := observeTestService(t, "http://127.0.0.1:9")
	reader := sdkmetric.NewManualReader()
	meter := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)).Meter("test")
	counter, err := meter.Int64Counter("paprika_insights_queries")
	require.NoError(t, err)
	s.queryCount = counter
	saturatedCatalog(s)
	return s, reader
}

// A catalog-busy rejection is counted under one fixed provider label. The caller's
// provider id never becomes a label value, however many ids it sends.
func TestCatalogBusyCountsUnderFixedProviderLabel(t *testing.T) {
	s, reader := meteredService(t)
	chosen := observeProviderID("prod/prom")
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	require.Equal(t, http.StatusTooManyRequests, w.Code, "body %s", w.Body)
	counts := queryCounts(t, reader)
	assert.Equal(t, map[string]int64{"shared-catalog|catalog_busy": 1}, counts)
	assert.NotContains(t, counts, chosen+"|catalog_busy", "the caller's provider id became a label")
}

// A provider id that is not a valid id is refused with 400 before any admission,
// so a 32 KiB id is never a metric label and never occupies a catalog place.
func TestQueryRejectsInvalidProviderIDBeforeAdmission(t *testing.T) {
	// The body limit is 32 KiB, so the id is just under it and reaches validation.
	huge := "observe-" + strings.Repeat("x", 31<<10)
	for name, providerID := range map[string]string{
		"32 KiB id": huge,
		"space":     "bad id",
		"dot":       "observe-a.b",
	} {
		t.Run(name, func(t *testing.T) {
			s, reader := meteredService(t)
			body := savedQueryJSON(t, Query{ProviderID: providerID, Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 1})
			w := request(t, s.Handler(), http.MethodPost, "/api/query", body, observeHeaders("alice"))
			require.Equal(t, http.StatusBadRequest, w.Code, "body %.200s", w.Body)
			assert.Empty(t, queryCounts(t, reader), "a refused id reached admission")
			assert.Equal(t, cap(s.catalogPhases), len(s.catalogPhases), "the refused id changed the catalog phases")
		})
	}
}

// A valid id keeps its behaviour: an unknown local id is still a 404.
func TestQueryKeepsUnknownValidProviderIDAsNotFound(t *testing.T) {
	s, _ := testService(t)
	body := savedQueryJSON(t, Query{ProviderID: "no-such-provider", Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 1})
	w := request(t, s.Handler(), http.MethodPost, "/api/query", body, nil)
	assert.Equal(t, http.StatusNotFound, w.Code, "body %s", w.Body)
}

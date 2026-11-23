package insights

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/mock"
)

// allGatewayProviderTypes is every provider type the gateway registers.
var allGatewayProviderTypes = []string{
	connector.ProviderPrometheus, connector.ProviderLoki, connector.ProviderTempo, connector.ProviderOTLP,
	connector.ProviderGCPCloudLogging, connector.ProviderGCPCloudMonitoring, connector.ProviderGCPCloudTrace,
	connector.ProviderAWSCloudWatchLogs, connector.ProviderAWSCloudWatchMetrics, connector.ProviderAWSXRay,
	connector.ProviderAWSCloudTrail, connector.ProviderVultrMonitoring, connector.ProviderMock,
	connector.ProviderShorted, connector.ProviderUptime, connector.ProviderPostgreSQL,
}

// catalogFixture lists one entry of each gateway provider type, in the
// gateway's own naming, with the namespace the gateway would build.
func catalogFixture(providerTypes ...string) []observeCatalogProvider {
	entries := make([]observeCatalogProvider, 0, len(providerTypes))
	for i, providerType := range providerTypes {
		namespace := "team"
		entries = append(entries, observeCatalogProvider{Name: namespace + "/" + providerType + "-" + string(rune('a'+i)), Namespace: namespace, Type: providerType})
	}
	return entries
}

func TestSharedCatalogAdmitsDecodedTypesAndListsTheRest(t *testing.T) {
	t.Parallel()

	entries := catalogFixture(append(append([]string{}, allGatewayProviderTypes...), "newer-type")...)
	listing, err := sharedProvidersFromCatalog(entries)
	require.NoError(t, err)

	got := map[string][]string{}
	for _, p := range listing.providers {
		got[p.Type] = p.Capabilities
	}
	assert.Equal(t, map[string][]string{
		connector.ProviderPrometheus: {"metrics"},
		connector.ProviderTempo:      {"traces"},
		connector.ProviderShorted:    {"metrics", "records"},
		connector.ProviderUptime:     {"metrics", "records"},
		connector.ProviderPostgreSQL: {"metrics", "records"},
		connector.ProviderMock:       {"metrics", "traces"},
	}, got)

	reasons := map[string]string{}
	for _, p := range listing.unsupported {
		reasons[p.Type] = p.Reason
		assert.NotEmpty(t, p.Message, p.Type)
	}
	assert.Equal(t, map[string]string{
		connector.ProviderLoki:                 catalog.InsightsReasonLogs,
		connector.ProviderGCPCloudLogging:      catalog.InsightsReasonLogs,
		connector.ProviderAWSCloudWatchLogs:    catalog.InsightsReasonLogs,
		connector.ProviderAWSCloudTrail:        catalog.InsightsReasonLogs,
		connector.ProviderGCPCloudMonitoring:   catalog.InsightsReasonMetricsFormat,
		connector.ProviderAWSCloudWatchMetrics: catalog.InsightsReasonMetricsFormat,
		connector.ProviderVultrMonitoring:      catalog.InsightsReasonMetricsFormat,
		connector.ProviderGCPCloudTrace:        catalog.InsightsReasonTracesFormat,
		connector.ProviderAWSXRay:              catalog.InsightsReasonTracesFormat,
		connector.ProviderOTLP:                 catalog.InsightsReasonPassthrough,
		"newer-type":                           observeReasonUnknownType,
	}, reasons)
}

func TestSharedCatalogUnsupportedMessagesAreFixedCatalogText(t *testing.T) {
	t.Parallel()

	listing, err := sharedProvidersFromCatalog(catalogFixture(connector.ProviderLoki, "newer-type"))
	require.NoError(t, err)
	require.Len(t, listing.unsupported, 2)

	info, ok := catalog.Get(connector.ProviderLoki)
	require.True(t, ok)
	assert.Equal(t, info.Insights.Note, listing.unsupported[0].Message)
	assert.Equal(t, observeMessageUnknownType, listing.unsupported[1].Message)
}

func TestSharedCatalogFailsClosedOnUnsupportedTypeEntries(t *testing.T) {
	t.Parallel()

	// Validation used to skip unsupported types before checking them. Every
	// entry is now checked, so a malformed or duplicate entry of an unlisted
	// type fails the whole listing, as it does for a queryable type.
	malformed := []observeCatalogProvider{{Name: "other/logs", Namespace: "team", Type: connector.ProviderLoki}}
	_, err := sharedProvidersFromCatalog(malformed)
	require.ErrorIs(t, err, errUpstream)

	// An unlisted type's text is shown in the listing, so it must be a bounded identifier.
	for _, badType := range []string{"", "Vultr Monitoring", "<b>x</b>", "vultr\nmonitoring", strings.Repeat("a", 64)} {
		_, err = sharedProvidersFromCatalog([]observeCatalogProvider{{Name: "team/odd", Namespace: "team", Type: badType}})
		require.ErrorIs(t, err, errUpstream, "type %q", badType)
	}

	duplicate := []observeCatalogProvider{
		{Name: "team/vultr", Namespace: "team", Type: connector.ProviderVultrMonitoring},
		{Name: "team/vultr", Namespace: "team", Type: connector.ProviderVultrMonitoring},
	}
	_, err = sharedProvidersFromCatalog(duplicate)
	require.ErrorIs(t, err, errUpstream)
}

func TestObserveListingOmitsUnsupportedKeyWhenNoneAreListed(t *testing.T) {
	t.Parallel()

	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			writeJSON(w, 200, map[string]any{"providers": catalogFixture(connector.ProviderPrometheus, connector.ProviderTempo)})
			return
		}
		t.Errorf("unexpected gateway path: %s", r.URL.Path)
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)

	w := request(t, s.Handler(), "GET", "/api/providers", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.NotContains(t, w.Body.String(), "unsupportedProviders")
}

func TestObserveListingReportsUnsupportedProvidersWithFixedWording(t *testing.T) {
	t.Parallel()

	// The gateway's reason text is carried on the entry. Insights never decodes
	// it, so it must not reach the browser.
	const gatewayReason = "https://secret:password@private.invalid" //nolint:gosec // G101: a fake reason string that must never reach a client.
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			writeJSON(w, 200, map[string]any{"providers": []map[string]any{
				{"name": "prod/prom", "namespace": "prod", "type": connector.ProviderPrometheus},
				{"name": "prod/logs", "namespace": "prod", "type": connector.ProviderLoki, "reason": gatewayReason},
			}})
			return
		}
		t.Errorf("unexpected gateway path: %s", r.URL.Path)
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)

	w := request(t, s.Handler(), "GET", "/api/providers", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.NotContains(t, w.Body.String(), "secret")
	assert.NotContains(t, w.Body.String(), "private.invalid")

	var listing struct {
		Providers            []Provider            `json:"providers"`
		UnsupportedProviders []UnsupportedProvider `json:"unsupportedProviders"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listing))
	require.Len(t, listing.Providers, 1)
	require.Len(t, listing.UnsupportedProviders, 1)
	info, ok := catalog.Get(connector.ProviderLoki)
	require.True(t, ok)
	assert.Equal(t, UnsupportedProvider{Name: "prod/logs", Type: connector.ProviderLoki, TypeLabel: info.DisplayName, Reason: catalog.InsightsReasonLogs, Message: info.Insights.Note}, listing.UnsupportedProviders[0])
	assert.NotEmpty(t, info.DisplayName, "a listed type shows its catalog name, not its raw id")
}

func TestObserveUnsupportedProviderIsNotResolvable(t *testing.T) {
	t.Parallel()

	var dataCalls int
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			writeJSON(w, 200, map[string]any{"providers": catalogFixture(connector.ProviderLoki)})
			return
		}
		dataCalls++
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)

	w := request(t, s.Handler(), "POST", "/api/query", observeQueryBody(t, "team/"+connector.ProviderLoki+"-a", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	assert.Zero(t, dataCalls, "an unsupported provider reached the gateway's data path")
}

func TestObserveMockProviderIsQueryableFromTheGateway(t *testing.T) {
	t.Parallel()

	start := time.Date(2023, 11, 14, 22, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Minute)
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			writeJSON(w, 200, map[string]any{"providers": catalogFixture(connector.ProviderMock)})
		case "/query_metrics":
			// The gateway runs the mock connector itself; Insights must decode its payload.
			result, err := mock.New().Query(r.Context(), connector.QueryRequest{
				Signal: connector.SignalMetrics, Query: "up", Range: connector.TimeRange{Start: start, End: end}, Limit: maxSeries,
			})
			if err != nil || result.State != connector.StateOK {
				t.Errorf("mock metrics query: %v %+v", err, result)
			}
			writeJSON(w, 200, map[string]any{"state": "OK", "data": result.Data})
		default:
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	h := s.Handler()
	reference := "team/" + connector.ProviderMock + "-a"

	w := request(t, h, "GET", "/api/providers", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var listing struct {
		Providers []Provider `json:"providers"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listing))
	require.Len(t, listing.Providers, 1)
	assert.Equal(t, []string{"metrics", "traces"}, listing.Providers[0].Capabilities)

	w = request(t, h, "POST", "/api/query", observeQueryBody(t, reference, "metrics"), observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var result QueryResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	assert.NotEmpty(t, result.Series)

	traceQuery, err := json.Marshal(Query{ProviderID: observeProviderID(reference), Kind: "traces", Query: "{}", TraceID: "00112233445566778899aabbccddeeff", Start: float64(start.Unix()), End: float64(end.Unix())})
	require.NoError(t, err)
	w = request(t, h, "POST", "/api/query", traceQuery, observeHeaders("alice"))
	assert.NotEqual(t, http.StatusOK, w.Code)
	// Trace detail is Tempo-only. The rejection is a sanitized provider error, and
	// the fixture fails the test if the query reaches the gateway's traces route.
	assert.NotEqual(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "provider_error")
}

// The mock connector's trace search is decoded by the Tempo search decoder, so a
// mock provider's traces reach the Traces view with the same shape as Tempo's.
func TestObserveMockTraceSearchDecodesAsTraces(t *testing.T) {
	t.Parallel()

	start := time.Date(2023, 11, 14, 22, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Minute)
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			writeJSON(w, 200, map[string]any{"providers": catalogFixture(connector.ProviderMock)})
		case "/query_traces":
			result, err := mock.New().Query(r.Context(), connector.QueryRequest{
				Signal: connector.SignalTraces, Query: `{ resource.service.name = "api" }`, Range: connector.TimeRange{Start: start, End: end}, Limit: maxTraces,
			})
			if err != nil || result.State != connector.StateOK {
				t.Errorf("mock traces query: %v %+v", err, result)
			}
			writeJSON(w, 200, map[string]any{"state": "OK", "data": result.Data})
		default:
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	h := observeTestService(t, gateway.URL).Handler()
	reference := "team/" + connector.ProviderMock + "-a"

	w := request(t, h, "POST", "/api/query", observeQueryBody(t, reference, "traces"), observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var result QueryResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	assert.NotEmpty(t, result.Traces, "the mock trace search decoded to no traces")
}

package insights

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// stateCatalogEntry is one gateway catalog entry with the state the gateway
// reports, plus a reason the gateway sends with failing providers. Insights must
// use the state and never the reason.
func stateCatalogEntry(name, state string) observeCatalogProvider {
	return observeCatalogProvider{Name: "team/" + name, Namespace: "team", Type: connector.ProviderPrometheus, State: state}
}

func TestSharedProvidersForwardOnlyTheClosedStates(t *testing.T) {
	t.Parallel()

	entries := []observeCatalogProvider{
		stateCatalogEntry("ok", "OK"),
		stateCatalogEntry("not-configured", "NotConfigured"),
		stateCatalogEntry("not-available", "NotAvailable"),
		stateCatalogEntry("error", "Error"),
		stateCatalogEntry("forbidden", "Forbidden"),
		stateCatalogEntry("unknown", "Degraded: https://secret.invalid"),
		stateCatalogEntry("lowercase", "ok"),
		stateCatalogEntry("empty", ""),
	}
	listing, err := sharedProvidersFromCatalog(entries)
	require.NoError(t, err)

	got := map[string]string{}
	for _, p := range listing.providers {
		got[p.Name] = p.State
	}
	assert.Equal(t, map[string]string{
		"team/ok":             "OK",
		"team/not-configured": "NotConfigured",
		"team/not-available":  "NotAvailable",
		"team/error":          "Error",
		"team/forbidden":      "Forbidden",
		"team/unknown":        "",
		"team/lowercase":      "",
		"team/empty":          "",
	}, got)
}

func TestSharedProvidersDoNotCarryStateOnUnsupportedEntries(t *testing.T) {
	t.Parallel()

	listing, err := sharedProvidersFromCatalog([]observeCatalogProvider{
		{Name: "team/logs", Namespace: "team", Type: connector.ProviderLoki, State: "Error"},
	})
	require.NoError(t, err)
	require.Empty(t, listing.providers)
	require.Len(t, listing.unsupported, 1)
	raw, err := json.Marshal(listing.unsupported[0])
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "Error")
}

func TestObserveListingCarriesStateAndNeverTheGatewayReason(t *testing.T) {
	t.Parallel()

	// The gateway's reason text is sent with the state. Insights must not decode
	// it, so it never reaches the browser, while the closed state does.
	const gatewayReason = "https://secret:password@private.invalid" //nolint:gosec // G101: a fake reason string that must never reach a client.
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			writeJSON(w, 200, map[string]any{"providers": []map[string]any{
				{"name": "team/prom", "namespace": "team", "type": connector.ProviderPrometheus, "state": "Forbidden", "reason": gatewayReason},
				{"name": "team/tempo", "namespace": "team", "type": connector.ProviderTempo, "state": "Surprise", "reason": gatewayReason},
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
	assert.NotContains(t, w.Body.String(), "Surprise")

	var listing struct {
		Providers []Provider `json:"providers"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listing))
	states := map[string]string{}
	for _, p := range listing.Providers {
		states[p.Name] = p.State
	}
	assert.Equal(t, map[string]string{"team/prom": "Forbidden", "team/tempo": ""}, states)
}

func TestObserveStateNeverRefusesAQuery(t *testing.T) {
	t.Parallel()

	// A probe verdict can be up to a probe interval old, and a provider that was
	// just fixed must stay usable. A non-OK state therefore only marks the
	// provider; the query still reaches the gateway's data path.
	var dataCalls int
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			writeJSON(w, 200, map[string]any{"providers": []map[string]any{
				{"name": "team/prom", "namespace": "team", "type": connector.ProviderPrometheus, "state": "NotConfigured"},
			}})
		case "/query_metrics":
			dataCalls++
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)})
		default:
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)

	w := request(t, s.Handler(), "POST", "/api/query", observeQueryBody(t, "team/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, 1, dataCalls)
}

package vultrmonitoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// fakeVultrAPI routes the three v2 endpoints this connector reads to canned
// responses and records every request, so the wire shape is asserted, not
// assumed.
type fakeVultrAPI struct {
	srv     *httptest.Server
	mu      sync.Mutex
	queries []string
	auths   []string
}

func (f *fakeVultrAPI) recordedRequests() (queries, auths []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.queries), slices.Clone(f.auths)
}

func newFakeVultrAPI(t *testing.T, accountBandwidth, instances, instanceBandwidth string) *fakeVultrAPI {
	t.Helper()
	fake := &fakeVultrAPI{}
	fake.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		fake.queries = append(fake.queries, r.URL.RequestURI())
		fake.auths = append(fake.auths, r.Header.Get("Authorization"))
		fake.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/account/bandwidth":
			fmt.Fprint(w, accountBandwidth)
		case "/v2/instances":
			fmt.Fprint(w, instances)
		default:
			// /v2/instances/{id}/bandwidth
			fmt.Fprint(w, instanceBandwidth)
		}
	}))
	t.Cleanup(fake.srv.Close)
	return fake
}

func configFor(t *testing.T, endpoint string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"endpoint": endpoint})
	require.NoError(t, err)
	return raw
}

const cannedAccountBandwidth = `{
  "bandwidth": {
    "current_month_to_date": {"timestamp_start": "2026-10-01T00:00:00+00:00", "timestamp_end": "2026-10-15T00:00:00+00:00", "gb_in": 12, "gb_out": 340, "total_instance_hours": 900, "total_instance_count": 3, "instance_bandwidth_credits": 1536, "free_bandwidth_credits": 0, "purchased_bandwidth_credits": 0, "overage": 0, "overage_unit_cost": 0.01, "overage_cost": 0}
  }
}`

const cannedInstances = `{
  "instances": [
    {"id": "abc-1", "label": "core-node", "region": "lax", "status": "active"},
    {"id": "abc-2", "label": "worker-node", "region": "lax", "status": "active"}
  ],
  "meta": {"total": 2, "links": {"next": ""}}
}`

const cannedInstanceBandwidth = `{
  "bandwidth": {
    "2026-10-14": {"incoming_bytes": 1000, "outgoing_bytes": 2000},
    "2026-10-15": {"incoming_bytes": 3000, "outgoing_bytes": 4000}
  }
}`

func TestQueryAccountBandwidth(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       MetricAccountBandwidth,
		Config:      configFor(t, fake.srv.URL),
		Credentials: []byte("test-api-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, cannedAccountBandwidth, string(res.Data))
	queries, auths := fake.recordedRequests()
	require.Equal(t, []string{"/v2/account/bandwidth"}, queries)
	require.Equal(t, []string{"Bearer test-api-key"}, auths)
}

func TestQueryEmptyQueryIsProbe(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Config:      configFor(t, fake.srv.URL),
		Credentials: []byte("test-api-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, cannedAccountBandwidth, string(res.Data))
}

func TestQueryInstanceBandwidthFanout(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       MetricInstanceIncomingBytes,
		Config:      configFor(t, fake.srv.URL),
		Credentials: []byte("test-api-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	var body struct {
		Series []struct {
			InstanceID string          `json:"instance_id"` //nolint:tagliatelle // Assert the existing connector wire field.
			Label      string          `json:"label"`
			Points     [][]interface{} `json:"points"`
		} `json:"series"`
		Partial int `json:"partial"`
	}
	require.NoError(t, json.Unmarshal(res.Data, &body))
	require.Len(t, body.Series, 2)
	require.Equal(t, 0, body.Partial)
	// Points are date-sorted ascending and project the requested direction.
	require.Equal(t, "abc-1", body.Series[0].InstanceID)
	require.Equal(t, [][]interface{}{{"2026-10-14", float64(1000)}, {"2026-10-15", float64(3000)}}, body.Series[0].Points)
	// One instances list read + one bandwidth read per instance.
	queries, auths := fake.recordedRequests()
	require.Len(t, queries, 3)
	require.Equal(t, []string{"Bearer test-api-key", "Bearer test-api-key", "Bearer test-api-key"}, auths)
}

func TestQueryUnknownMetricIsACallerBug(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       "cpu_usage",
		Config:      configFor(t, "http://localhost:1"),
		Credentials: []byte("key"),
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "cpu_usage")
}

func TestQueryMissingCredentialsReportsNotConfigured(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  MetricAccountBandwidth,
		Config: configFor(t, fake.srv.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotConfigured, res.State)
	require.Equal(t, reasonCredentials, res.Reason)
	queries, _ := fake.recordedRequests()
	require.Empty(t, queries)
}

func TestQueryBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"error":"unauthorized"}`)
	}))
	t.Cleanup(denied.Close)
	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       MetricAccountBandwidth,
		Config:      configFor(t, denied.URL),
		Credentials: []byte("bad-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotEmpty(t, res.Reason)
}

func TestQueryWrongSignalIsRejected(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs,
		Query:  MetricAccountBandwidth,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, VultrMonitoring{}.ValidateConfig(nil))
	require.NoError(t, VultrMonitoring{}.ValidateConfig(configFor(t, "http://localhost:1")))
	require.NoError(t, VultrMonitoring{}.ValidateConfig(json.RawMessage(`{"insecureSkipTLS":true}`)))
	require.Error(t, VultrMonitoring{}.ValidateConfig(json.RawMessage(`{"region":"lax"}`)))
	require.Error(t, VultrMonitoring{}.ValidateConfig(json.RawMessage(`{"endpoint":"not a url"}`)))
}

func TestExplorerInterfaceIsSatisfied(t *testing.T) {
	t.Parallel()

	var _ connector.Explorer = VultrMonitoring{}
}

func TestConfigRejectsInlineCredentialsAndUnsafeHeaders(t *testing.T) {
	t.Parallel()
	for name, config := range map[string]string{
		"URL userinfo":                   `{"endpoint":"https://test-only-sentinel@api.vultr.com"}`,
		"URL query":                      `{"endpoint":"https://api.vultr.com?token=test-only-sentinel"}`,
		"URL fragment":                   `{"endpoint":"https://api.vultr.com#test-only-sentinel"}`,
		"authorization":                  `{"headers":{"Authorization":"test-only-sentinel"}}`,
		"cookie":                         `{"headers":{"Cookie":"test-only-sentinel"}}`,
		"proxy authorization":            `{"headers":{"Proxy-Authorization":"test-only-sentinel"}}`,
		"case insensitive authorization": `{"headers":{"aUtHoRiZaTiOn":"test-only-sentinel"}}`,
		"invalid header":                 `{"headers":{"X-Test":"test-only-sentinel\r\nInjected: true"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			err := (VultrMonitoring{}).ValidateConfig(json.RawMessage(config))
			require.Error(t, err)
			require.NotContains(t, err.Error(), "test-only-sentinel", "configuration errors must never reproduce credential values")
		})
	}
}

func TestConfigPreservesVendorDefaultAndSharedOptions(t *testing.T) {
	t.Parallel()
	for _, config := range []string{"", "null", `{}`, `{"insecureSkipTLS":true}`, `{"headers":{"X-Scope-OrgID":"tenant-one"}}`} {
		cfg, err := parseConfig(json.RawMessage(config))
		require.NoError(t, err)
		require.Equal(t, defaultEndpoint, cfg.Endpoint)
	}
	cfg, err := parseConfig(json.RawMessage(`{"endpoint":"https://vultr.internal.example/v2-proxy","insecureSkipTLS":true,"headers":{"X-Scope-OrgID":"tenant-one"}}`))
	require.NoError(t, err)
	require.Equal(t, "https://vultr.internal.example/v2-proxy", cfg.Endpoint)
	require.True(t, cfg.InsecureSkipTLS)
	require.Equal(t, "tenant-one", cfg.Headers["X-Scope-OrgID"])
	// Region remains outside this account-wide connector's existing schema.
	require.Error(t, (VultrMonitoring{}).ValidateConfig(json.RawMessage(`{"region":"lax"}`)))
}

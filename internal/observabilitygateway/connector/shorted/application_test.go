package shorted

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestPortfolioUsesExplicitHoldingsAndPreservesUnknownQuotes(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"prices":{"CBA":{"close":100,"change":2},"BHP":{"close":0,"change":0}}}`)
	q := `{"operation":"portfolio_positions","args":{"positions":[{"stock_code":"CBA","quantity":2,"cost":80},{"stock_code":"BHP","quantity":3},{"stock_code":"CSL","quantity":1}]}}`
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, s.URL), Query: q})
	f := frameResult(t, res, err)
	require.Len(t, f.Rows, 3)
	require.Equal(t, json.Number("200"), cell(t, f, 0, "market_value"))
	require.Equal(t, json.Number("4"), cell(t, f, 0, "day_change"))
	require.Equal(t, json.Number("40"), cell(t, f, 0, "gain"))
	require.Equal(t, json.Number("0"), cell(t, f, 1, "market_value"))
	require.Nil(t, cell(t, f, 1, "day_change_percent"))
	require.Nil(t, cell(t, f, 2, "market_value"))
	require.Equal(t, false, cell(t, f, 2, "complete"))
	require.JSONEq(t, `{"stockCodes":["CBA","BHP","CSL"]}`, (<-calls).body)
	res, err = New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, s.URL), Query: strings.Replace(q, "portfolio_positions", "portfolio_summary", 1)})
	summary := frameResult(t, res, err)
	require.Nil(t, cell(t, summary, 0, "market_value"))
	require.Equal(t, json.Number("2"), cell(t, summary, 0, "valued_positions"))
	require.Equal(t, false, cell(t, summary, 0, "complete"))
	for _, positions := range []string{`[]`, `[{"stock_code":"CBA","quantity":-1}]`, `[{"stock_code":"CBA","quantity":null}]`, `[{"stock_code":"CBA","quantity":1,"path":"/admin"}]`, `[{"stock_code":"CBA","quantity":1},{"stock_code":"cba","quantity":2}]`, `[{"stock_code":"CBA","quantity":1,"cost":-1}]`} {
		_, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, s.URL), Query: `{"operation":"portfolio_positions","args":{"positions":` + positions + `}}`})
		require.ErrorIs(t, err, connector.ErrUnsupported)
	}
	require.Len(t, calls, 1)
}

func TestSectorSourceBasketAndMissingCoverage(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"prices":{"CBA":{"changePercent":2,"volume":100},"WBC":{"changePercent":-1,"volume":50},"ANZ":{"changePercent":0,"volume":0},"NAB":{"changePercent":3,"volume":150},"BHP":{"changePercent":1,"volume":10}}}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, s.URL), Query: `{"operation":"sector_performance"}`})
	f := frameResult(t, res, err)
	require.Len(t, f.Rows, 6)
	require.Equal(t, json.Number("1"), cell(t, f, 0, "performance"))
	require.Equal(t, json.Number("300"), cell(t, f, 0, "volume"))
	require.Equal(t, "NAB, CBA", cell(t, f, 0, "top_gainers"))
	require.Nil(t, cell(t, f, 1, "performance"))
	require.Equal(t, json.Number("1"), cell(t, f, 1, "observed_stocks"))
	require.Equal(t, false, cell(t, f, 1, "complete"))
	var req map[string][]string
	require.NoError(t, json.Unmarshal([]byte((<-calls).body), &req))
	require.Len(t, req["stockCodes"], 24)
}

func TestIndustryFiltersBeforeRowCap(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"timeBuckets":[{"signalKind":"emissions","metricKey":"scope_1_2_emissions","totalValue":3},{"signalKind":"tax_environment","metricKey":"tax_payable","totalValue":42},{"signalKind":"tax_environment","metricKey":"tax_payable","totalValue":43}]}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, ""), Limit: 1, Query: `{"operation":"industry_time_buckets","args":{"industry":"Banks","signal_kind":"tax_environment","metric_key":"tax_payable"}}`})
	f := frameResult(t, res, err)
	require.Len(t, f.Rows, 1)
	require.True(t, f.Truncated)
	require.Equal(t, json.Number("42"), cell(t, f, 0, "total_value"))
	require.JSONEq(t, `{"industry":"Banks","recordLimit":50}`, (<-calls).body)
	_, err = New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, ""), Query: `{"operation":"industry_time_buckets","args":{"signal_kind":"../path"}}`})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Empty(t, calls)
}

func TestScreenerUsesNativeReadProtocol(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"stocks":[{"stockCode":"CBA","shortPct":1.2,"shortPctChange4w":-0.25}],"totalCount":40}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, ""), Query: `{"operation":"screener","args":{"limit":5,"product_codes":["CBA"]}}`})
	f := frameResult(t, res, err)
	require.Equal(t, json.Number("-0.25"), cell(t, f, 0, "short_pct_change_4w"))
	require.True(t, f.Truncated)
	call := <-calls
	require.Equal(t, "/shorts.v1alpha1.ScreenerService/ScreenStocks", call.path)
	require.JSONEq(t, `{"limit":5,"sortField":"SCREENER_SORT_FIELD_SHORT_PCT","sortDirection":"SORT_DIRECTION_DESC","filters":{"productCodes":["CBA"]}}`, call.body)
}

func TestAdminReadsUseDedicatedCredentialAndSafeFields(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"jobs":[{"name":"a","displayName":"Task A","health":"critical","message":"secret-error","logUri":"https://sensitive.invalid"},{"name":"b","health":"overdue","retired":true},{"name":"c","health":"warning"}],"stale":true}`)
	cfg := configured(t, s.URL, s.URL)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: cfg, Credentials: []byte(`{"apiToken":"public-token"}`), Query: `{"operation":"admin_jobs"}`})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotConfigured, res.State)
	require.Empty(t, calls)
	for _, op := range []string{"admin_jobs", "admin_issues", "admin_fleet"} {
		res, err = New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: cfg, Credentials: []byte(`{"apiToken":"public-token","adminToken":"admin-secret"}`), Query: `{"operation":"` + op + `"}`})
		f := frameResult(t, res, err)
		call := <-calls
		require.Equal(t, "GET", call.method)
		require.Equal(t, "/api/admin/jobs", call.path)
		require.Empty(t, call.body)
		require.Equal(t, "Bearer admin-secret", call.auth)
		require.NotContains(t, string(res.Data), "secret-error")
		require.NotContains(t, string(res.Data), "sensitive.invalid")
		if op == "admin_jobs" {
			require.Len(t, f.Rows, 3)
		}
		if op == "admin_issues" {
			require.Len(t, f.Rows, 2)
		}
		if op == "admin_fleet" {
			require.Equal(t, "critical", cell(t, f, 0, "status"))
			require.Equal(t, json.Number("1"), cell(t, f, 0, "retired_jobs"))
			require.Equal(t, true, cell(t, f, 0, "stale"))
		}
	}
}

func TestAdminSyncEscapesAllowedFiltersAndOmitsPrivateMetadata(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"runs":[{"runId":"run-1","status":"success","environment":"production","hostname":"private.internal","errorMessage":"private failure","shortsRecordsUpdated":12,"startedAt":"2026-10-01T00:00:00Z"}]}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, ""), Credentials: []byte(`{"adminToken":"admin-secret"}`), Query: `{"operation":"admin_sync","args":{"limit":5,"environment":"production","exclude_local":false}}`})
	f := frameResult(t, res, err)
	require.Equal(t, json.Number("12"), cell(t, f, 0, "shorts_records_updated"))
	require.NotContains(t, string(res.Data), "private")
	call := <-calls
	require.Equal(t, "GET", call.method)
	require.Equal(t, "/api/admin/sync-status?environment=production&excludeLocal=false&limit=5", call.path)
	_, err = New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: configured(t, s.URL, ""), Credentials: []byte(`{"adminToken":"admin-secret"}`), Query: `{"operation":"admin_sync","args":{"environment":"production&path=/delete"}}`})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Empty(t, calls)
}

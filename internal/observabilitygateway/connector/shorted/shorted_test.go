package shorted

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func configured(t *testing.T, endpoint, market string) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(config{Endpoint: endpoint, MarketDataEndpoint: market})
	require.NoError(t, err)
	return b
}

type captured struct{ path, method, contentType, protocol, auth, body string }

func backend(t *testing.T, status int, body string) (*httptest.Server, chan captured) {
	t.Helper()
	calls := make(chan captured, 8)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		calls <- captured{r.URL.RequestURI(), r.Method, r.Header.Get("Content-Type"), r.Header.Get("Connect-Protocol-Version"), r.Header.Get("Authorization"), string(payload)}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if _, err := io.WriteString(w, body); err != nil {
			t.Log("client closed bounded response")
		}
	}))
	t.Cleanup(s.Close)
	return s, calls
}

func frameResult(t *testing.T, res *connector.QueryResult, err error) *dataframe.Frame {
	t.Helper()
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	frame, decodeErr := dataframe.Decode(res.Data)
	require.NoError(t, decodeErr)
	return frame
}

func cell(t *testing.T, f *dataframe.Frame, row int, key string) any {
	t.Helper()
	for i, c := range f.Columns {
		if c.Key == key {
			return f.Rows[row][i]
		}
	}
	t.Fatalf("missing column %s", key)
	return nil
}

func TestAllowlistedOperationProtocols(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, args, path, response, key string
		want                            any
	}{
		{"top_shorts", `{"limit":2}`, marketService + "GetTopShorts", `{"timeSeries":[{"productCode":"CBA","name":"Bank","latestShortPosition":1.25}]}`, "short_position", json.Number("1.25")},
		{"industry_treemap", `{"view_mode":"PERCENTAGE_CHANGE"}`, marketService + "GetIndustryTreeMap", `{"stocks":[{"industry":"Banks","productCode":"CBA","shortPosition":0}]}`, "short_position", json.Number("0")},
		{"stock_history", `{"product_code":"cba","max_points":10}`, stockService + "GetStockData", `{"productCode":"CBA","points":[{"timestamp":"2026-10-01T00:00:00Z","shortPosition":2}]}`, "product_code", "CBA"},
		{"stock_prices", `{"product_code":"CBA"}`, stockService + "GetStockPrices", `{"productCode":"CBA","points":[{"date":"2026-10-01","close":99.25,"volume":"900"}]}`, "timestamp", "2026-10-01T00:00:00Z"},
		{"stock_details", `{"product_code":"CBA"}`, stockService + "GetStockDetails", `{"productCode":"CBA","companyName":"Bank","summary":"Public company"}`, "company_name", "Bank"},
		{"market_quotes", `{"stock_codes":["CBA","BHP"]}`, priceService + "GetMultipleStockPrices", `{"prices":{"CBA":{"close":101.5,"date":"2026-10-01T00:00:00Z"}}}`, "stock_code", "CBA"},
		{"market_history", `{"stock_code":"BHP","period":"1Y"}`, priceService + "GetHistoricalPrices", `{"prices":[{"stockCode":"BHP","date":{"seconds":"1790812800"},"close":20}]}`, "timestamp", "2026-10-01T00:00:00Z"},
		{"market_correlations", `{"stock_codes":["CBA","BHP"]}`, priceService + "GetStockCorrelations", `{"correlations":{"CBA":{"correlations":{"BHP":-0.25}}}}`, "correlation", json.Number("-0.25")},
		{"market_news", `{"price_sensitive_only":true}`, "/shorts.v1alpha1.NewsService/GetMarketNews", `{"articles":[{"id":"n1","headline":"Announcement","publishedAt":"2026-10-01T00:00:00Z","isPriceSensitive":true}]}`, "is_price_sensitive", true},
		{"industry_records", `{"industry":"Banks"}`, industryService, `{"records":[{"metricKey":"tax_payable","hasMetricValue":false,"metricValue":99}]}`, "metric_value", nil},
		{"industry_time_buckets", `{"industry":"Banks","record_limit":2}`, industryService, `{"timeBuckets":[{"bucketLabel":"2023-24","bucketStart":"2023-07-01","totalValue":25}]}`, "bucket_start", "2023-07-01T00:00:00Z"},
		{"industry_entity_totals", `{"stock_code":"CBA"}`, industryService, `{"entityTotals":[{"stockCode":"CBA","totalValue":55}]}`, "total_value", json.Number("55")},
		{"industry_sources", `{}`, industryService, `{"sources":[{"sourceKey":"ato","licence":"CC BY"}]}`, "licence", "CC BY"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			server, calls := backend(t, 200, tc.response)
			res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, server.URL, server.URL), Query: `{"operation":"` + tc.name + `","args":` + tc.args + `}`})
			frame := frameResult(t, res, err)
			require.Len(t, frame.Rows, 1)
			require.Equal(t, tc.want, cell(t, frame, 0, tc.key))
			request := <-calls
			require.Equal(t, tc.path, request.path)
			require.Equal(t, http.MethodPost, request.method)
			require.Equal(t, "application/json", request.contentType)
			require.Equal(t, "1", request.protocol)
			require.Empty(t, request.auth)
			var body map[string]any
			require.NoError(t, json.Unmarshal([]byte(request.body), &body))
			require.NotContains(t, request.body, "product_code")
			require.NotContains(t, request.body, "stock_codes")
			if tc.name == "top_shorts" {
				require.JSONEq(t, `{"period":"3M","limit":2,"summaryOnly":true}`, request.body)
			}
			if tc.name == "stock_history" {
				require.JSONEq(t, `{"productCode":"CBA","period":"3M","maxPoints":10}`, request.body)
			}
		})
	}
}

func TestProjectionAndNullSemantics(t *testing.T) {
	t.Parallel()
	s, _ := backend(t, 200, `{"productCode":"CBA","downsampled":true,"points":[{"timestamp":"2026-10-01T00:00:00Z","shortPosition":0},{"timestamp":"2026-10-02T00:00:00Z","shortPosition":null}]}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalMetrics, Config: configured(t, s.URL, ""), Query: `{"operation":"stock_history","args":{"product_code":"CBA"},"projection":{"value":"short_position","time":"timestamp","labels":["product_code"]}}`})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"short_position","product_code":"CBA"},"values":[[1790812800,"0"],[1790899200,"NaN"]]}]},"truncated":true}`, string(res.Data))
}

func TestCredentialsAreOriginScoped(t *testing.T) {
	t.Parallel()
	api, apiCalls := backend(t, 200, `{"timeSeries":[]}`)
	market, marketCalls := backend(t, 200, `{"prices":{}}`)
	cfg := configured(t, api.URL, market.URL)
	creds := []byte(`{"apiToken":"api-secret","marketDataToken":"market-secret"}`)
	for _, q := range []string{`{"operation":"top_shorts"}`, `{"operation":"market_quotes","args":{"stock_codes":["CBA"]}}`} {
		res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: cfg, Credentials: creds, Query: q})
		frameResult(t, res, err)
	}
	require.Equal(t, "Bearer api-secret", (<-apiCalls).auth)
	require.Equal(t, "Bearer market-secret", (<-marketCalls).auth)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: cfg, Credentials: []byte(`{"apiToken":"api-secret"}`), Query: `{"operation":"market_quotes","args":{"stock_codes":["CBA"]}}`})
	frameResult(t, res, err)
	require.Empty(t, (<-marketCalls).auth)
}

func TestDeniedShapesNeverReachBackend(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{}`)
	queries := []string{
		`{"operation":"DeleteStock"}`, `{"operation":"../GetTopShorts"}`, `{"operation":"top_shorts","url":"https://bad.invalid"}`,
		`{"operation":"top_shorts","operation":"stock_details"}`, `{"Operation":"top_shorts"}`,
		`{"operation":"top_shorts","args":{"limit":2,"limit":3}}`, `{"operation":"top_shorts","args":{"limit":0}}`, `{"operation":"top_shorts","args":{"limit":101}}`,
		`{"operation":"top_shorts","args":{"period":"50Y"}}`, `{"operation":"top_shorts","args":{"limit":null}}`, `{"operation":"top_shorts","args":{"headers":{}}}`,
		`{"operation":"stock_history","args":{"product_code":"CBA/../../"}}`, `{"operation":"stock_history"}`, `{"operation":"stock_history","args":{"product_code":"CBA","max_points":1001}}`,
		`{"operation":"stock_history","args":{"product_code":"CBA","from":"2026-10-02","to":"2026-10-01"}}`,
		`{"operation":"market_quotes","args":{"stock_codes":["CBA","cba"]}}`, `{"operation":"market_quotes","args":{"stock_codes":[]}}`,
		`{"operation":"market_history","args":{"stock_code":"CBA","period":"MAX"}}`, `{"operation":"market_correlations","args":{"stock_codes":["CBA","BHP"],"period":"1d"}}`, `{"operation":"top_shorts","projection":null}`, `{"operation":"top_shorts","projection":{"value":"short_position"}}`,
		strings.Repeat(" ", maxQueryBytes) + `{"operation":"top_shorts"}`,
	}
	for _, q := range queries {
		res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s.URL, ""), Query: q})
		require.ErrorIs(t, err, connector.ErrUnsupported, q)
		require.Equal(t, connector.StateNotAvailable, res.State)
	}
	require.Empty(t, calls)
	for _, projection := range []string{`{"value":"name"}`, `{"value":"short_position","time":"name"}`, `{"Value":"short_position"}`, `{"value":"short_position","labels":["missing"]}`} {
		_, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalMetrics, Config: configured(t, s.URL, ""), Query: `{"operation":"top_shorts","projection":` + projection + `}`})
		require.ErrorIs(t, err, connector.ErrUnsupported)
	}
	require.Empty(t, calls)
}

func TestConfigAndCredentialValidation(t *testing.T) {
	t.Parallel()
	for _, cfg := range []string{`{"endpoint":"https://user:pass@example.invalid"}`, `{"endpoint":"https://example.invalid/path"}`, `{"endpoint":"https://example.invalid?secret=x"}`, `{"endpoint":"https://example.invalid?"}`, `{"endpoint":"https://example.invalid","headers":{"Authorization":"secret"}}`, `{"endpoint":"https://example.invalid","insecureSkipTLS":true}`, `{"Endpoint":"https://example.invalid"}`, `{"endpoint":"https://one.invalid","endpoint":"https://two.invalid"}`} {
		require.Error(t, New().ValidateConfig(json.RawMessage(cfg)))
	}
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://example.invalid","marketDataEndpoint":"https://prices.invalid/"}`)))
	s, calls := backend(t, 200, `{}`)
	for _, credentials := range []string{`raw-token`, `null`, `{"apiToken":"x\r\ny"}`, `{"apiToken":"x","headers":{}}`} {
		res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s.URL, ""), Credentials: []byte(credentials), Query: `{"operation":"top_shorts"}`})
		require.NoError(t, err)
		require.Equal(t, connector.StateForbidden, res.State)
	}
	require.Empty(t, calls)
	require.False(t, credentialTransportAllowed("http://public.invalid"))
	require.True(t, credentialTransportAllowed("https://public.invalid"))
	require.True(t, credentialTransportAllowed("http://127.0.0.1:1234"))
}

func TestBoundedResponsesAndStatusSanitization(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		status int
		body   string
		state  connector.State
	}{
		{401, `{"secret":"do-not-expose"}`, connector.StateForbidden}, {403, `{"secret":"do-not-expose"}`, connector.StateForbidden}, {404, `not found`, connector.StateNotAvailable}, {500, `do-not-expose`, connector.StateError}, {200, strings.Repeat("x", maxResponseBytes+1), connector.StateError}, {200, `{"timeSeries":"do-not-expose"}`, connector.StateError}, {200, `{"timeSeries":[{"latestShortPosition":"NaN"}]}`, connector.StateError},
	} {
		t.Run(fmt.Sprint(tc.status, len(tc.body)), func(t *testing.T) {
			t.Parallel()
			s, _ := backend(t, tc.status, tc.body)
			res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s.URL, ""), Query: `{"operation":"top_shorts"}`})
			require.NoError(t, err)
			require.Equal(t, tc.state, res.State)
			require.NotContains(t, res.Reason, "do-not-expose")
			require.Empty(t, res.Data)
		})
	}
	s, _ := backend(t, 200, `{"timeSeries":[{"productCode":"CBA","latestShortPosition":1},{"productCode":"BHP","latestShortPosition":2}]}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s.URL, ""), Limit: 1, Query: `{"operation":"top_shorts"}`})
	f := frameResult(t, res, err)
	require.Len(t, f.Rows, 1)
	require.True(t, f.Truncated)
}

func TestRedirectAndCancellation(t *testing.T) {
	t.Parallel()
	var redirected atomic.Int32
	dest := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	t.Cleanup(dest.Close)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, dest.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(s.Close)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s.URL, ""), Credentials: []byte(`{"apiToken":"secret"}`), Query: `{"operation":"top_shorts"}`})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)
	require.Zero(t, redirected.Load())
	blocked := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	t.Cleanup(blocked.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	res, err = New().Query(ctx, connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, blocked.URL, ""), Query: `{"operation":"top_shorts"}`})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)
}

func TestProbeAndTrueZeroEvidence(t *testing.T) {
	t.Parallel()
	s, calls := backend(t, 200, `{"timeSeries":[]}`)
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalMetrics, Config: configured(t, s.URL, "")})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"period":"3M","limit":1,"summaryOnly":true}`, (<-calls).body)
	s2, _ := backend(t, 200, `{"records":[{"hasMetricValue":true},{"hasMetricValue":false,"metricValue":0}]}`)
	res, err = New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s2.URL, ""), Query: `{"operation":"industry_records"}`})
	f := frameResult(t, res, err)
	require.Equal(t, json.Number("0"), cell(t, f, 0, "metric_value"))
	require.Nil(t, cell(t, f, 1, "metric_value"))
}

func TestRowAndCellCaps(t *testing.T) {
	t.Parallel()
	rows := make([]map[string]any, maxRows+1)
	for i := range rows {
		rows[i] = map[string]any{"headline": "News", "id": strconv.Itoa(i)}
	}
	rows[0]["headline"] = strings.Repeat("界", dataframe.MaxCellBytes)
	response, err := json.Marshal(map[string]any{"articles": rows})
	require.NoError(t, err)
	s, _ := backend(t, 200, string(response))
	result, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.Signal("records"), Config: configured(t, s.URL, ""), Query: `{"operation":"market_news"}`})
	f := frameResult(t, result, err)
	require.Len(t, f.Rows, maxRows)
	require.True(t, f.Truncated)
	headline, ok := cell(t, f, 0, "headline").(string)
	require.True(t, ok)
	require.LessOrEqual(t, len(headline), dataframe.MaxCellBytes)
	require.NotContains(t, cell(t, f, 0, "headline"), "\uFFFD")
}

func TestLiveShortedPublicReads(t *testing.T) {
	endpoint := os.Getenv("SHORTED_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("set SHORTED_TEST_ENDPOINT for an authorized public-provider acceptance run")
	}
	cfg := configured(t, endpoint, os.Getenv("SHORTED_TEST_MARKET_ENDPOINT"))
	for _, q := range []string{`{"operation":"top_shorts","args":{"limit":2}}`, `{"operation":"stock_history","args":{"product_code":"CBA","period":"1M","max_points":10}}`, `{"operation":"market_quotes","args":{"stock_codes":["CBA"]}}`, `{"operation":"industry_treemap","args":{"limit":2}}`, `{"operation":"screener","args":{"limit":2}}`, `{"operation":"portfolio_positions","args":{"positions":[{"stock_code":"CBA","quantity":2}]}}`, `{"operation":"sector_performance"}`} {
		result, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalRecords, Config: cfg, Query: q})
		data := frameResult(t, result, err)
		require.NotEmpty(t, data.Rows)
		t.Logf("public read succeeded: %d scalar rows, %d columns", len(data.Rows), len(data.Columns))
	}
}

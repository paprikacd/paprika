package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const receiptMetricsRequest = `{"providerId":"prometheus","kind":"metrics","query":"up{private_label=\"private-query-value\"}","start":1700000000.5,"end":1700000600.5,"step":30}`

func TestQueryDiagnosticsReconcileMeasuredTimeWithoutInventingProviderTime(t *testing.T) {
	t.Setenv("INSIGHTS_RECEIPT_TOKEN", "private-credential")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer private-credential", r.Header.Get("Authorization"))
		require.Equal(t, "1700000000.5", r.URL.Query().Get("start"))
		require.Equal(t, "1700000600.5", r.URL.Query().Get("end"))
		_, _ = io.WriteString(w, `{"status":"success","warnings":["private-upstream-warning"],"data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[1700000000.5,"1"],[1700000030.5,"NaN"]]}]}}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL, BearerTokenEnv: "INSIGHTS_RECEIPT_TOKEN"})
	first := readReceiptResult(t, request(t, s.Handler(), http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil))
	second := readReceiptResult(t, request(t, s.Handler(), http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil))
	d := first.Diagnostics
	require.Equal(t, 1, d.Version)
	require.NotEmpty(t, d.ExecutionID)
	require.NotEqual(t, d.ExecutionID, second.Diagnostics.ExecutionID, "two provider executions need distinct identities")
	require.Equal(t, "partial", d.Outcome)
	require.True(t, d.Truncated)
	require.Equal(t, QueryDiagnosticSource{ProviderID: "prometheus", ProviderType: "prometheus", Transport: "direct"}, d.Source)
	require.Equal(t, QueryDiagnosticBounds{Start: 1700000000.5, End: 1700000600.5, Step: 30}, d.Requested)
	require.Equal(t, "provider", d.Effective.Scope)
	require.True(t, d.Effective.Dispatched)
	require.True(t, d.Effective.RangeApplied)
	require.Equal(t, d.Requested.Start, *d.Effective.Start)
	require.Equal(t, d.Requested.End, *d.Effective.End)
	require.Equal(t, d.Requested.Step, *d.Effective.Step)
	require.Equal(t, &QueryResultCounts{Series: 1, Points: 2}, d.Counts, "a null observation is still a returned point")
	assertExclusiveReceipt(t, d, []string{"admission", "upstream", "normalization"})
	provider := d.Phases[len(d.Phases)-1]
	require.Equal(t, QueryDiagnosticPhase{Name: "provider", Owner: "provider", Clock: "unavailable", Relationship: "nested", Parent: "upstream"}, provider)
	encoded, err := json.Marshal(d)
	require.NoError(t, err)
	for _, secret := range []string{upstream.URL, "private-credential", "INSIGHTS_RECEIPT_TOKEN", "private-query-value", "private-upstream-warning"} {
		require.NotContains(t, string(encoded), secret)
	}
	require.Contains(t, string(encoded), `"durationMs":null`, "unknown is explicit, not zero")
}

func TestQueryDiagnosticsMeasureAdmissionAndReleaseQueue(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	s.queries = make(chan struct{}, 1)
	s.queries <- struct{}{}
	s.queryWaitTimeout = time.Second
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- request(t, s.Handler(), http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil)
	}()
	require.Eventually(t, func() bool { return len(s.queryWaiting) == 1 }, time.Second, time.Millisecond)
	<-s.queries
	result := readReceiptResult(t, <-done)
	require.Equal(t, "success", result.Diagnostics.Outcome)
	require.Greater(t, *result.Diagnostics.Phases[0].DurationMs, float64(0))
	require.Equal(t, &QueryResultCounts{}, result.Diagnostics.Counts, "successful empty is a measured zero count")
	assertExclusiveReceipt(t, result.Diagnostics, []string{"admission", "upstream", "normalization"})
	require.Empty(t, s.queryWaiting)
	require.Empty(t, s.queries)
}

func TestQueryDiagnosticsCapacityAndCancellationNeverClaimExecution(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("an unadmitted query reached the provider")
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	s.queries = make(chan struct{}, 1)
	s.queries <- struct{}{}
	s.queryWaiting = make(chan struct{}, 1)
	s.queryWaiting <- struct{}{}
	w := request(t, s.Handler(), http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil)
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	require.Equal(t, "1", w.Header().Get("Retry-After"))
	failure := readReceiptFailure(t, w)
	require.Equal(t, "rate_limited", failure.Code)
	require.Equal(t, "capacity", failure.Diagnostics.Outcome)
	require.Nil(t, failure.Diagnostics.Counts)
	require.Equal(t, QueryEffectiveBounds{Scope: "provider"}, failure.Diagnostics.Effective)
	assertExclusiveReceipt(t, failure.Diagnostics, []string{"admission"})

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/query", strings.NewReader(receiptMetricsRequest))
	r.Header.Set("Authorization", "Bearer "+testToken)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	require.Equal(t, http.StatusRequestTimeout, w.Code)
	failure = readReceiptFailure(t, w)
	require.Equal(t, "canceled", failure.Code)
	require.Equal(t, "cancelled", failure.Diagnostics.Outcome)
	require.Nil(t, failure.Diagnostics.Counts)
	require.Equal(t, QueryEffectiveBounds{Scope: "provider"}, failure.Diagnostics.Effective)
	assertExclusiveReceipt(t, failure.Diagnostics, []string{"admission"})
}

type receiptTransport func(*http.Request) (*http.Response, error)

func (transport receiptTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

func TestQueryDiagnosticsTimeoutAndBackendFailureAreDistinctAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		status  int
		code    string
		outcome string
	}{
		{"timeout", context.DeadlineExceeded, http.StatusGatewayTimeout, "timeout", "timeout"},
		{"cancellation", context.Canceled, http.StatusRequestTimeout, "canceled", "cancelled"},
		{"backend error", errors.New("private-token at https://private.invalid"), http.StatusBadGateway, "provider_error", "error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: "https://private.invalid"})
			p, ok := s.providers.get("prometheus")
			require.True(t, ok)
			p.client.Transport = receiptTransport(func(*http.Request) (*http.Response, error) { return nil, tc.err })
			w := request(t, s.Handler(), http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil)
			require.Equal(t, tc.status, w.Code)
			failure := readReceiptFailure(t, w)
			require.Equal(t, tc.code, failure.Code)
			require.Equal(t, tc.outcome, failure.Diagnostics.Outcome)
			require.Nil(t, failure.Diagnostics.Counts)
			assertExclusiveReceipt(t, failure.Diagnostics, []string{"admission", "upstream"})
			for _, secret := range []string{"private-token", "private.invalid", "private-query-value"} {
				require.NotContains(t, w.Body.String(), secret)
			}
		})
	}
}

func TestQueryDiagnosticsTempoEffectiveBoundsMatchWireRequest(t *testing.T) {
	for _, detail := range []bool{false, true} {
		t.Run(map[bool]string{false: "search", true: "detail"}[detail], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if detail {
					require.Equal(t, "", r.URL.RawQuery, "trace lookup must not inherit search window bounds")
					_, _ = io.WriteString(w, traceFixture)
					return
				}
				require.Equal(t, "1700000000", r.URL.Query().Get("start"))
				require.Equal(t, "1700000600", r.URL.Query().Get("end"))
				_, _ = io.WriteString(w, `{"traces":[]}`)
			}))
			defer upstream.Close()
			s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Traces", Type: "tempo", URL: upstream.URL})
			query := Query{ProviderID: "tempo", Kind: "traces", Query: "{}", Start: 1700000000.5, End: 1700000600.5}
			if detail {
				query.TraceID = "00112233445566778899aabbccddeeff"
			}
			body, err := json.Marshal(query)
			require.NoError(t, err)
			d := readReceiptResult(t, request(t, s.Handler(), http.MethodPost, "/api/query", body, nil)).Diagnostics
			require.Equal(t, !detail, d.Effective.RangeApplied)
			require.True(t, d.Effective.Dispatched)
			require.Nil(t, d.Effective.Step)
			if detail {
				require.Nil(t, d.Effective.Start)
				require.Nil(t, d.Effective.End)
			} else {
				require.Equal(t, float64(1700000000), *d.Effective.Start)
				require.Equal(t, float64(1700000600), *d.Effective.End)
			}
		})
	}
}

func TestQueryDiagnosticsGatewayDoesNotClaimFinalProviderBounds(t *testing.T) {
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			writeJSON(w, http.StatusOK, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)})
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	d := readReceiptResult(t, request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))).Diagnostics
	require.Equal(t, "gateway", d.Source.Transport)
	require.Equal(t, "gateway", d.Effective.Scope)
	require.True(t, d.Effective.Dispatched)
	require.Equal(t, observeProviderID("prod/prom"), d.Source.ProviderID)
	assertExclusiveReceipt(t, d, []string{"admission", "upstream", "normalization"})
	require.Nil(t, d.Phases[len(d.Phases)-1].DurationMs)
}

func TestQueryDiagnosticsDoesNotClaimDispatchWhenGatewayConnectionFails(t *testing.T) {
	s, _ := testService(t)
	gateway, err := newObserveGateway("https://private.invalid")
	require.NoError(t, err)
	gateway.client.Transport = receiptTransport(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private connection error")
	})
	p := &providerClient{
		public: Provider{ID: "observe-test", Type: "prometheus", Capabilities: []string{"metrics"}},
		remote: &observeProvider{gateway: gateway, reference: "prod/prom", token: "private-token"},
	}
	result, executed, err := s.runProviderQuery(t.Context(), p, &Query{Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 30})
	require.Error(t, err)
	require.False(t, executed)
	require.Equal(t, QueryEffectiveBounds{Scope: "gateway"}, result.Diagnostics.Effective)
	require.Nil(t, result.Diagnostics.Counts)
	assertExclusiveReceipt(t, result.Diagnostics, []string{"admission", "upstream"})
	require.Len(t, result.Diagnostics.Phases, 2, "no provider phase may be attributed before dispatch")
}

type receiptBodyReader func([]byte) (int, error)

func (read receiptBodyReader) Read(p []byte) (int, error) { return read(p) }

func TestObserveTransportReceiptPreservesOperationDeadlineDuringRequestAndBodyRead(t *testing.T) {
	for _, bodyRead := range []bool{false, true} {
		t.Run(map[bool]string{false: "request", true: "body"}[bodyRead], func(t *testing.T) {
			operation, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
			defer cancel()
			transport := &observeMCPTransport{ctx: operation, endpoint: "https://gateway.invalid/observe/mcp", token: "private-token"}
			transport.base = receiptTransport(func(r *http.Request) (*http.Response, error) {
				if !bodyRead {
					<-r.Context().Done()
					return nil, context.Canceled
				}
				body := io.NopCloser(receiptBodyReader(func([]byte) (int, error) {
					<-r.Context().Done()
					return 0, context.Canceled
				}))
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: body}, nil
			})
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, transport.endpoint, http.NoBody)
			require.NoError(t, err)
			response, err := transport.RoundTrip(req)
			if response != nil {
				defer closeReadBody(response.Body)
			}
			require.Error(t, err)
			require.NoError(t, req.Context().Err(), "the caller is still active; only the gateway operation expired")
			failure := queryFailureDetails(err)
			require.Equal(t, "timeout", failure.Code)
			require.Equal(t, http.StatusGatewayTimeout, queryFailureStatus(err, failure.Code))
			require.NotContains(t, err.Error(), "private")
			require.NotContains(t, err.Error(), "gateway.invalid")
		})
	}
}

func readReceiptResult(t *testing.T, w *httptest.ResponseRecorder) QueryResult {
	t.Helper()
	require.Equal(t, http.StatusOK, w.Code, "%s", w.Body)
	var result QueryResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.NotNil(t, result.Diagnostics)
	return result
}

type receiptFailure struct {
	Code        string            `json:"code"`
	Diagnostics *QueryDiagnostics `json:"diagnostics"`
}

func readReceiptFailure(t *testing.T, w *httptest.ResponseRecorder) receiptFailure {
	t.Helper()
	var failure receiptFailure
	require.NoError(t, json.NewDecoder(bytes.NewReader(w.Body.Bytes())).Decode(&failure))
	require.NotNil(t, failure.Diagnostics)
	return failure
}

func assertExclusiveReceipt(t *testing.T, d *QueryDiagnostics, names []string) {
	t.Helper()
	measured := make([]string, 0, len(names))
	total := float64(0)
	for _, phase := range d.Phases {
		if phase.Relationship != "exclusive" {
			continue
		}
		require.Equal(t, "insights", phase.Owner)
		require.Equal(t, "server-monotonic", phase.Clock)
		require.NotNil(t, phase.DurationMs)
		require.GreaterOrEqual(t, *phase.DurationMs, float64(0))
		measured = append(measured, phase.Name)
		total += *phase.DurationMs
	}
	require.Equal(t, names, measured)
	require.InDelta(t, d.TotalMs, total, 0.000001, "exclusive intervals must reconcile to service elapsed time")
}

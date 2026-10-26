package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/stretchr/testify/require"
)

func TestObservabilityCatalogAdmissionClassificationPreservesRequest(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body string
		catalog                  bool
	}{
		{"initialize", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`, true},
		{"discovery", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"server/discover"}`, true},
		{"initialized notification", "POST", "/observe/mcp", `{"jsonrpc":"2.0","method":"notifications/initialized"}`, true},
		{"tool catalog", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"cursor":"next"}}`, true},
		{"provider catalog", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_observability_providers","arguments":{"namespace":"observability"}}}`, true},
		{"REST provider catalog", "GET", "/observe/api/providers", "", true},
		{"REST provider mutation", "POST", "/observe/api/providers", "", false},
		{"REST query", "POST", "/observe/api/query", `{"method":"tools/list"}`, false},
		{"REST exploration", "POST", "/observe/api/explore", `{"method":"tools/list"}`, false},
		{"MCP read verb", "GET", "/observe/mcp", `{"jsonrpc":"2.0","method":"tools/list"}`, false},
		{"other route", "POST", "/healthz", `{"jsonrpc":"2.0","method":"tools/list"}`, false},
		{"query metrics", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics"}}`, false},
		{"query traces", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_traces"}}`, false},
		{"metadata tool", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_metric_series"}}`, false},
		{"saved query write", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_saved_query"}}`, false},
		{"dashboard write", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_dashboard"}}`, false},
		{"tool arguments cannot change pool", "POST", "/observe/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","arguments":{"method":"tools/list","name":"list_observability_providers"}}}`, false},
		{"wrong version", "POST", "/observe/mcp", `{"jsonrpc":"1.0","method":"tools/list"}`, false},
		{"missing version", "POST", "/observe/mcp", `{"method":"tools/list"}`, false},
		{"malformed", "POST", "/observe/mcp", `{"jsonrpc":"2.0","method":"tools/list"`, false},
		{"trailing JSON", "POST", "/observe/mcp", `{"jsonrpc":"2.0","method":"tools/list"}{"method":"tools/call"}`, false},
		{"batch", "POST", "/observe/mcp", `[{"jsonrpc":"2.0","method":"tools/list"}]`, false},
		{"null", "POST", "/observe/mcp", `null`, false},
		{"null params", "POST", "/observe/mcp", `{"jsonrpc":"2.0","method":"tools/call","params":null}`, false},
		{"wrong params shape", "POST", "/observe/mcp", `{"jsonrpc":"2.0","method":"tools/call","params":["list_observability_providers"]}`, false},
		{"wrong method type", "POST", "/observe/mcp", `{"jsonrpc":"2.0","method":17}`, false},
		{"empty body", "POST", "/observe/mcp", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), tc.method, tc.path, strings.NewReader(tc.body))
			// Headers are untrusted hints; only the JSON body selects the pool.
			req.Header.Set("Mcp-Method", "tools/list")
			req.Header.Set("Mcp-Name", "list_observability_providers")
			require.Equal(t, tc.catalog, isObservabilityCatalogRequest(req))
			body, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			require.Equal(t, tc.body, string(body), "classification must leave the exact body available to authentication and the SDK")
		})
	}
}

func TestObservabilityCatalogAdmissionAgreesWithSDKCaseAndDuplicateKeys(t *testing.T) {
	for _, tc := range []struct {
		name, body, method, tool string
		catalog                  bool
	}{
		{"method alias", `{"jsonrpc":"2.0","id":1,"method":"tools/call","Method":"tools/list","params":{"name":"query_metrics"}}`, "tools/call", "query_metrics", false},
		{"params alias", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_traces"},"Params":{"name":"list_observability_providers"}}`, "tools/call", "query_traces", false},
		{"tool name alias", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_dashboard","Name":"list_observability_providers"}}`, "tools/call", "update_dashboard", false},
		{"method duplicate last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/list","method":"tools/call","params":{"name":"query_metrics"}}`, "tools/call", "query_metrics", false},
		{"params duplicate last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_observability_providers"},"params":{"name":"query_metrics"}}`, "tools/call", "query_metrics", false},
		{"name duplicate last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_observability_providers","name":"query_metrics"}}`, "tools/call", "query_metrics", false},
		{"escaped method exact key", `{"jsonrpc":"2.0","id":1,"method":"tools/list","m\u0065thod":"tools/call","params":{"name":"query_metrics"}}`, "tools/call", "query_metrics", false},
		{"escaped tool exact key", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_observability_providers","n\u0061me":"query_metrics"}}`, "tools/call", "query_metrics", false},
		{"catalog ignores differently cased method", `{"jsonrpc":"2.0","id":1,"method":"tools/list","Method":"tools/call","params":{"name":"query_metrics"}}`, "tools/list", "query_metrics", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			message, err := sdkjsonrpc.DecodeMessage([]byte(tc.body))
			require.NoError(t, err)
			request, ok := message.(*sdkjsonrpc.Request)
			require.True(t, ok)
			require.Equal(t, tc.method, request.Method)
			var params map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(request.Params, &params))
			var tool string
			require.NoError(t, json.Unmarshal(params["name"], &tool))
			require.Equal(t, tc.tool, tool)
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", strings.NewReader(tc.body))
			require.Equal(t, tc.catalog, isObservabilityCatalogRequest(req))
			preserved, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			require.Equal(t, tc.body, string(preserved))
		})
	}
}

type observedAdmissionBody struct {
	io.Reader
	reads, closes int
}

func (body *observedAdmissionBody) Read(p []byte) (int, error) {
	body.reads++
	return body.Reader.Read(p)
}
func (body *observedAdmissionBody) Close() error { body.closes++; return nil }

func TestObservabilityCatalogAdmissionBoundsReadsAndPreservesClose(t *testing.T) {
	const envelope = `{"jsonrpc":"2.0","method":"tools/list"}`
	for _, tc := range []struct {
		name          string
		size          int
		unknownLength bool
		catalog       bool
	}{
		{"exact boundary", maxObserveCatalogEnvelopeBytes, false, true},
		{"declared oversize", maxObserveCatalogEnvelopeBytes + 200, false, false},
		{"chunked oversize", maxObserveCatalogEnvelopeBytes + 200, true, false},
		{"chunked small body", len(envelope), true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := envelope + strings.Repeat(" ", tc.size-len(envelope))
			reader := strings.NewReader(payload)
			body := &observedAdmissionBody{Reader: reader}
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", body)
			req.ContentLength = int64(tc.size)
			if tc.unknownLength {
				req.ContentLength = -1
			}
			require.Equal(t, tc.catalog, isObservabilityCatalogRequest(req))
			if !tc.unknownLength && tc.size > maxObserveCatalogEnvelopeBytes {
				require.Zero(t, body.reads, "declared oversize must skip classification reads")
			}
			require.LessOrEqual(t, tc.size-reader.Len(), maxObserveCatalogEnvelopeBytes+1, "unknown-length bodies must be read through a bounded prefix")
			require.Zero(t, body.closes)
			preserved, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			require.Equal(t, payload, string(preserved))
			require.NoError(t, req.Body.Close())
			require.Equal(t, 1, body.closes, "the restored body must close its original reader")
		})
	}
}

func TestObservabilityCatalogAdmissionPreservesIncompleteUploadError(t *testing.T) {
	// A client can send valid JSON and close before its promised Content-Length.
	// net/http exposes that short upload as UnexpectedEOF once, then EOF. The
	// classifier must not turn that failed body read into a successful MCP write.
	const payload = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_dashboard"}}`
	req, err := http.ReadRequest(bufio.NewReader(strings.NewReader("POST /observe/mcp HTTP/1.1\r\nHost: observe.test\r\nContent-Length: " + strconv.Itoa(len(payload)+20) + "\r\n\r\n" + payload)))
	require.NoError(t, err)
	req = req.WithContext(t.Context())
	t.Cleanup(func() { require.NoError(t, req.Body.Close()) })
	require.False(t, isObservabilityCatalogRequest(req))
	body, err := io.ReadAll(req.Body)
	require.Equal(t, payload, string(body))
	require.ErrorIs(t, err, io.ErrUnexpectedEOF)
}

func awaitAdmissionEvent[T any](t *testing.T, events <-chan T, message string) T {
	t.Helper()
	select {
	case value := <-events:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal(message)
		var zero T
		return zero
	}
}

func TestObservabilityCatalogReserveServesNestedMCPWhileOuterCallsAreHeld(t *testing.T) {
	const outer = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_dashboard"}}`
	const listing = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_observability_providers"}}`
	entered := make(chan string, 8)
	completed := make(chan int, 8)
	release := make(chan struct{})
	defer close(release)
	limited := limitObservabilityProtocolRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("hold") == "true" {
			entered <- string(body)
			<-release
		}
		_, _ = w.Write(body)
	}))
	start := func(body string) {
		t.Helper()
		go func() {
			rec := httptest.NewRecorder()
			limited.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp?hold=true", strings.NewReader(body)))
			completed <- rec.Code
		}()
		require.Equal(t, body, awaitAdmissionEvent(t, entered, "held request did not enter its pool"))
	}
	check := func(body string, status int) {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", strings.NewReader(body))
		req.Header.Set("Mcp-Method", "tools/list")
		req.Header.Set("Mcp-Name", "list_observability_providers")
		limited.ServeHTTP(rec, req)
		require.Equal(t, status, rec.Code)
		if status == http.StatusOK {
			require.Equal(t, body, rec.Body.String())
		} else {
			require.Equal(t, "1", rec.Header().Get("Retry-After"))
			require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		}
	}
	for range 4 {
		start(outer)
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		listing,
	} {
		check(body, http.StatusOK)
	}
	check(outer, http.StatusTooManyRequests)
	check(`{"jsonrpc":"2.0","id":1,"method":"tools/call","Method":"tools/list","params":{"name":"query_metrics"}}`, http.StatusTooManyRequests)
	for range 4 {
		start(listing)
	}
	check(listing, http.StatusTooManyRequests)
	for range 8 {
		release <- struct{}{}
	}
	for range 8 {
		require.Equal(t, http.StatusOK, awaitAdmissionEvent(t, completed, "admitted request retained its slots"))
	}
	check(listing, http.StatusOK)
	check(outer, http.StatusOK)
}

type cancelledAdmissionBody struct {
	ctx     context.Context
	started chan<- struct{}
	once    sync.Once
}

func (body *cancelledAdmissionBody) Read([]byte) (int, error) {
	body.once.Do(func() { body.started <- struct{}{} })
	<-body.ctx.Done()
	return 0, body.ctx.Err()
}
func (*cancelledAdmissionBody) Close() error { return nil }

func TestObservabilityAdmissionBoundsSlowClassificationAndReleasesCancelledIntake(t *testing.T) {
	started, completed := make(chan struct{}, 8), make(chan struct{}, 8)
	limited := limitObservabilityProtocolRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	cancellations := make([]context.CancelFunc, 0, 8)
	for range 8 {
		ctx, cancel := context.WithCancel(t.Context())
		cancellations = append(cancellations, cancel)
		defer cancel()
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/observe/mcp", &cancelledAdmissionBody{ctx: ctx, started: started})
		req.ContentLength = -1
		go func() {
			limited.ServeHTTP(httptest.NewRecorder(), req)
			completed <- struct{}{}
		}()
		awaitAdmissionEvent(t, started, "classification did not acquire its available intake slot")
	}
	check := func(path string, status int) {
		t.Helper()
		rec := httptest.NewRecorder()
		limited.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		require.Equal(t, status, rec.Code, path)
		if status == http.StatusTooManyRequests {
			require.Equal(t, "1", rec.Header().Get("Retry-After"))
			require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		}
	}
	check("/observe/api/providers", http.StatusTooManyRequests)
	check("/observe/mcp", http.StatusTooManyRequests)
	check("/healthz", http.StatusNoContent)
	cancellations[0]()
	awaitAdmissionEvent(t, completed, "cancelled body classification retained its intake slot")
	check("/observe/api/providers", http.StatusNoContent)
	for _, cancel := range cancellations[1:] {
		cancel()
	}
	for range 7 {
		awaitAdmissionEvent(t, completed, "cancelled body classification did not return")
	}
	check("/observe/api/providers", http.StatusNoContent)
}

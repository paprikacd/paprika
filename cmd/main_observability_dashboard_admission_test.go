package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	sdkjsonrpc "github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/stretchr/testify/require"
)

const dashboardAdmissionEnvelope = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_dashboard","arguments":{"id":"demo"}}}`

// validateExecuteEnvelope is a dry run that executes queries: nested data work
// through the gateway, so it needs the orchestration pool like query_dashboard.
const validateExecuteEnvelope = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard","arguments":{"id":"demo","execute":true}}}`

// validatePlainEnvelope is a dry run that only checks: ordinary work.
const validatePlainEnvelope = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard","arguments":{"id":"demo"}}}`

func TestObservabilityDashboardAdmissionAgreesWithSDK(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		class      observabilityRequestClass
	}{
		{"dashboard", dashboardAdmissionEnvelope, observabilityDashboardRequest},
		{"catalog", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, observabilityCatalogRequest},
		{"metrics", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics"}}`, observabilityWorkRequest},
		{"write", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_dashboard"}}`, observabilityWorkRequest},
		{"method alias", `{"jsonrpc":"2.0","id":1,"method":"tools/call","Method":"tools/list","params":{"name":"query_metrics"}}`, observabilityWorkRequest},
		{"params alias", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics"},"Params":{"name":"query_dashboard"}}`, observabilityWorkRequest},
		{"name alias", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","Name":"query_dashboard"}}`, observabilityWorkRequest},
		{"duplicate name last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_dashboard","name":"query_metrics"}}`, observabilityWorkRequest},
		{"duplicate params last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_dashboard"},"params":{"name":"query_metrics"}}`, observabilityWorkRequest},
		{"duplicate method last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"tools/list","params":{"name":"query_dashboard"}}`, observabilityCatalogRequest},
		{"escaped exact name", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_metrics","n\u0061me":"query_dashboard"}}`, observabilityDashboardRequest},
		{"dashboard ignores differently cased name", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_dashboard","Name":"query_metrics"}}`, observabilityDashboardRequest},
		{"render dashboard", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"render_dashboard","arguments":{"id":"demo"}}}`, observabilityDashboardRequest},
		{"validate with execute true", validateExecuteEnvelope, observabilityDashboardRequest},
		{"validate without execute", validatePlainEnvelope, observabilityWorkRequest},
		{"validate execute false", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard","arguments":{"id":"demo","execute":false}}}`, observabilityWorkRequest},
		{"validate execute string true", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard","arguments":{"id":"demo","execute":"true"}}}`, observabilityWorkRequest},
		{"validate execute capitalised", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard","arguments":{"id":"demo","Execute":true}}}`, observabilityWorkRequest},
		{"validate duplicate execute last wins", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard","arguments":{"id":"demo","execute":true,"execute":false}}}`, observabilityWorkRequest},
		{"validate without arguments", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_dashboard"}}`, observabilityWorkRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			message, err := sdkjsonrpc.DecodeMessage([]byte(tc.body))
			require.NoError(t, err)
			request, ok := message.(*sdkjsonrpc.Request)
			require.True(t, ok)
			var params map[string]json.RawMessage
			if request.Method == "tools/call" {
				require.NoError(t, json.Unmarshal(request.Params, &params))
				var tool string
				require.NoError(t, json.Unmarshal(params["name"], &tool))
				require.Equal(t, tc.class == observabilityDashboardRequest, sdkOrchestrates(tool, params["arguments"]))
			}
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", strings.NewReader(tc.body))
			req.Header.Set("Mcp-Method", "tools/call")
			req.Header.Set("Mcp-Name", "query_dashboard")
			require.Equal(t, tc.class, classifyObservabilityProtocolRequest(req))
			preserved, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			require.Equal(t, tc.body, string(preserved))
		})
	}
}

// sdkOrchestrates is the SDK-side reading of the same classification: the three
// orchestration tools, with validate_dashboard only when it executes.
func sdkOrchestrates(tool string, arguments json.RawMessage) bool {
	var fields map[string]json.RawMessage
	var execute bool
	if json.Unmarshal(arguments, &fields) != nil || json.Unmarshal(fields["execute"], &execute) != nil {
		execute = false
	}
	return tool == "query_dashboard" || tool == "render_dashboard" || (tool == "validate_dashboard" && execute)
}

func TestObservabilityDashboardAdmissionBoundsAndPreservesBody(t *testing.T) {
	for _, tc := range []struct {
		name, envelope string
		size           int
		unknownLength  bool
		class          observabilityRequestClass
	}{
		{"larger than catalog allowance", dashboardAdmissionEnvelope, 16 << 10, false, observabilityDashboardRequest},
		{"dashboard exact bound", dashboardAdmissionEnvelope, maxObserveDashboardEnvelopeBytes, false, observabilityDashboardRequest},
		{"dashboard chunked", dashboardAdmissionEnvelope, 16 << 10, true, observabilityDashboardRequest},
		{"declared oversize", dashboardAdmissionEnvelope, maxObserveDashboardEnvelopeBytes + 200, false, observabilityWorkRequest},
		{"chunked oversize", dashboardAdmissionEnvelope, maxObserveDashboardEnvelopeBytes + 200, true, observabilityWorkRequest},
		{"catalog retains its smaller cap", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, maxObserveCatalogEnvelopeBytes + 1, false, observabilityWorkRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := tc.envelope + strings.Repeat(" ", tc.size-len(tc.envelope))
			reader := strings.NewReader(payload)
			body := &observedAdmissionBody{Reader: reader}
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", body)
			req.ContentLength = int64(tc.size)
			if tc.unknownLength {
				req.ContentLength = -1
			}
			require.Equal(t, tc.class, classifyObservabilityProtocolRequest(req))
			if !tc.unknownLength && tc.size > maxObserveDashboardEnvelopeBytes {
				require.Zero(t, body.reads)
			}
			require.LessOrEqual(t, tc.size-reader.Len(), maxObserveDashboardEnvelopeBytes+1)
			preserved, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			require.Equal(t, payload, string(preserved))
			require.NoError(t, req.Body.Close())
			require.Equal(t, 1, body.closes)
		})
	}
}

func TestObservabilityDashboardAdmissionPreservesUploadErrorAndRejectsMalformed(t *testing.T) {
	req, err := http.ReadRequest(bufio.NewReader(strings.NewReader("POST /observe/mcp HTTP/1.1\r\nHost: observe.test\r\nContent-Length: " + strconv.Itoa(len(dashboardAdmissionEnvelope)+20) + "\r\n\r\n" + dashboardAdmissionEnvelope)))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, req.Body.Close()) })
	require.Equal(t, observabilityWorkRequest, classifyObservabilityProtocolRequest(req))
	body, err := io.ReadAll(req.Body)
	require.Equal(t, dashboardAdmissionEnvelope, string(body))
	require.ErrorIs(t, err, io.ErrUnexpectedEOF)
	for _, body := range []string{"null", "[]", dashboardAdmissionEnvelope + "{}", strings.Replace(dashboardAdmissionEnvelope, `"jsonrpc":"2.0"`, `"jsonrpc":"1.0"`, 1), `{"jsonrpc":"2.0","method":"tools/call","params":null}`} {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", strings.NewReader(body))
		require.Equal(t, observabilityWorkRequest, classifyObservabilityProtocolRequest(req))
	}
}

func TestObservabilityDashboardReserveServesRealNestedRequests(t *testing.T) {
	t.Run("query_dashboard", func(t *testing.T) { assertDashboardReserveServesNested(t, dashboardAdmissionEnvelope) })
	t.Run("validate_dashboard execute", func(t *testing.T) { assertDashboardReserveServesNested(t, validateExecuteEnvelope) })
}

// assertDashboardReserveServesNested holds both orchestration slots with the
// envelope, runs real nested MCP calls from inside each, and checks that a third
// orchestration call is refused while the nested work completes: the orchestration
// slots never compete with the data pool they feed.
func assertDashboardReserveServesNested(t *testing.T, envelope string) {
	ready := make(chan error, 2)
	completed := make(chan int, 2)
	release := make(chan struct{})
	var server *httptest.Server
	limited := limitWithProductionPools(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read failed", http.StatusBadRequest)
			return
		}
		if isObservabilityDashboardEnvelope(body) {
			var nestedErr error
			for _, nested := range []string{
				`{"jsonrpc":"2.0","id":1,"method":"initialize"}`,
				`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
				`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_observability_providers"}}`,
				`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"query_metrics"}}`,
				`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"query_traces"}}`,
			} {
				request, requestErr := http.NewRequestWithContext(r.Context(), http.MethodPost, server.URL+"/observe/mcp", strings.NewReader(nested))
				if requestErr != nil {
					nestedErr = requestErr
					break
				}
				response, callErr := server.Client().Do(request)
				if callErr != nil {
					nestedErr = callErr
					break
				}
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK {
					nestedErr = fmt.Errorf("nested request returned %d", response.StatusCode)
					break
				}
			}
			ready <- nestedErr
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		_, _ = w.Write(body)
	}))
	server = httptest.NewServer(limited)
	defer server.Close()
	defer close(release)
	for range 2 {
		go func() {
			request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/observe/mcp", strings.NewReader(envelope))
			if err != nil {
				completed <- 0
				return
			}
			response, err := server.Client().Do(request)
			if err != nil {
				completed <- 0
				return
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			completed <- response.StatusCode
		}()
		require.NoError(t, awaitAdmissionEvent(t, ready, "nested dashboard calls could not complete"))
	}
	// Both dashboard slots remain held while their nested work has completed.
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/observe/mcp", strings.NewReader(envelope))
	require.NoError(t, err)
	response, err := server.Client().Do(request)
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, response.Body)
	require.NoError(t, response.Body.Close())
	require.Equal(t, http.StatusTooManyRequests, response.StatusCode)
	for range 2 {
		release <- struct{}{}
	}
	for range 2 {
		require.Equal(t, http.StatusOK, awaitAdmissionEvent(t, completed, "dashboard orchestration retained its slot"))
	}
}

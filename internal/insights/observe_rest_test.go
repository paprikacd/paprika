package insights

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// observeRESTTestGateway serves the gateway's REST data routes. Each request
// reaches the fixture handler under the tool path its fixtures already switch
// on ("/list_observability_providers", "/query_<signal>", "/list_<kind>") with
// the REST body unchanged. The handler's status, Retry-After and body are
// returned as the gateway would return them.
func observeRESTTestGateway(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error("read REST body:", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		fixture := r.Clone(r.Context())
		var kind struct {
			Signal string `json:"signal"`
			Kind   string `json:"kind"`
		}
		switch {
		case r.URL.Path == observeRESTProvidersPath && r.Method == http.MethodGet:
			fixture.URL.Path = "/list_observability_providers"
		case r.URL.Path == observeRESTQueryPath && r.Method == http.MethodPost:
			if json.Unmarshal(body, &kind) != nil {
				t.Error("invalid REST query body")
			}
			fixture.URL.Path = "/query_" + kind.Signal
		case r.URL.Path == observeRESTExplorePath && r.Method == http.MethodPost:
			if json.Unmarshal(body, &kind) != nil {
				t.Error("invalid REST explore body")
			}
			fixture.URL.Path = "/list_" + kind.Kind
		default:
			t.Errorf("unexpected REST request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fixture.Body = io.NopCloser(bytes.NewReader(body))
		fixture.ContentLength = int64(len(body))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, fixture)
		for _, name := range []string{"Retry-After", observeLimitScopeHeader} {
			if value := recorder.Header().Get(name); value != "" {
				w.Header().Set(name, value)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	}))
}

// The REST data path sends each request with the caller's delegated bearer and
// exactly the gateway's request fields. Nothing else reaches the gateway.
func TestObserveRESTRequestsCarryDelegationAndExactFields(t *testing.T) {
	var bodies []map[string]any
	var bearers []string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearers = append(bearers, r.Header.Get("Authorization"))
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid body")
			}
			bodies = append(bodies, body)
			bodies[len(bodies)-1]["_path"] = r.URL.Path
		} else {
			bodies = append(bodies, map[string]any{"_path": r.URL.Path})
		}
		switch r.URL.Path {
		case observeRESTProvidersPath:
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}, {Name: "prod/tempo", Namespace: "prod", Type: "tempo"}}})
		case observeRESTQueryPath, observeRESTExplorePath:
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":[]}`)})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer gateway.Close()
	g := mustObserveGateway(t, gateway.URL)
	ctx := t.Context()
	_, err := g.providers(ctx, "alice")
	require.NoError(t, err)
	p := &observeProvider{gateway: g, token: "alice", reference: "prod/prom"}
	_, err = p.query(ctx, &Query{Kind: "metrics", Query: "up", Start: 1700000000.25, End: 1700000600.75, Step: 1.25}, nil)
	require.NoError(t, err)
	_, err = p.query(ctx, &Query{Kind: "records", Query: "select 1", Start: 1700000000, End: 1700000600}, nil)
	require.NoError(t, err)
	tempo := &observeProvider{gateway: g, token: "alice", reference: "prod/tempo"}
	_, err = tempo.query(ctx, &Query{Kind: "traces", Query: "{}", TraceID: "00112233445566778899aabbccddeeff", Start: 1700000000, End: 1700000600}, nil)
	require.NoError(t, err)
	_, err = p.metadata(ctx, "/api/v1/label/service/values", url.Values{"match[]": {"up"}, "start": {"1700000000"}, "end": {"1700000600"}}, maxMetadataValues)
	require.NoError(t, err)

	require.Len(t, bodies, 5)
	assert.Equal(t, observeRESTProvidersPath, bodies[0]["_path"])
	assert.Equal(t, map[string]any{"_path": observeRESTQueryPath, "provider": "prod/prom", "signal": "metrics", "query": "up",
		"start": "2023-11-14T22:13:20.25Z", "end": "2023-11-14T22:23:20.75Z", "stepSeconds": 1.25, "limit": float64(maxSeries)}, bodies[1])
	assert.Equal(t, map[string]any{"_path": observeRESTQueryPath, "provider": "prod/prom", "signal": "records", "query": "select 1",
		"start": "2023-11-14T22:13:20Z", "end": "2023-11-14T22:23:20Z", "limit": float64(1000)}, bodies[2])
	assert.Equal(t, map[string]any{"_path": observeRESTQueryPath, "provider": "prod/tempo", "signal": "traces", "query": "{}",
		"traceId": "00112233445566778899aabbccddeeff", "start": "2023-11-14T22:13:20Z", "end": "2023-11-14T22:23:20Z", "limit": float64(maxTraces)}, bodies[3])
	assert.Equal(t, map[string]any{"_path": observeRESTExplorePath, "provider": "prod/prom", "kind": "label_values", "label": "service", "metric": "up",
		"limit": float64(maxMetadataValues), "start": "2023-11-14T22:13:20Z", "end": "2023-11-14T22:23:20Z"}, bodies[4])
	for _, bearer := range bearers {
		assert.Equal(t, "Bearer alice", bearer)
	}
}

// Redirects are never followed: the gateway's own authorization cannot be sent
// to another origin, and a redirect is an upstream failure.
// The gateway's authorization scope is kept only when it is a lowercase SHA-256 hex digest.
// A malformed one is dropped, so the caller's results are never shared under it.
func TestObserveRESTKeepsOnlyWellFormedAuthorizationScopes(t *testing.T) {
	valid := strings.Repeat("ab", 32)
	for _, test := range []struct {
		name  string
		scope string
		want  string
	}{
		{"well formed digest is kept", valid, valid},
		{"empty scope is none", "", ""},
		{"upper case hex is dropped", strings.ToUpper(valid), ""},
		{"short digest is dropped", valid[:63], ""},
		{"non hex digest is dropped", strings.Repeat("z", 64), ""},
		{"digest with trailing text is dropped", valid + "x", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{}, "authorizationScope": test.scope})
			}))
			defer gateway.Close()
			listing, err := mustObserveGateway(t, gateway.URL).listShared(t.Context(), "alice")
			require.NoError(t, err)
			assert.Equal(t, test.want, listing.scope)
		})
	}
}

func TestObserveRESTRefusesRedirectsAndForeignPaths(t *testing.T) {
	var elsewhere atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere.Add(1)
		writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{}})
	}))
	defer target.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+observeRESTProvidersPath, http.StatusFound)
	}))
	defer gateway.Close()
	g := mustObserveGateway(t, gateway.URL)
	_, err := g.listShared(t.Context(), "alice")
	var remote *observeError
	require.ErrorAs(t, err, &remote, "a redirect is not followed and not forwarded")
	assert.Equal(t, http.StatusBadGateway, remote.status)
	assert.Zero(t, elsewhere.Load(), "the redirect target received a request")
	_, err = g.restDo(t.Context(), "alice", "/observe/mcp", map[string]any{}, 1<<10, nil)
	require.ErrorIs(t, err, errUpstream, "a path outside the allowlist is refused before any request")
	_, err = g.restDo(t.Context(), "alice", observeRESTQueryPath+"?x=1", map[string]any{}, 1<<10, nil)
	require.ErrorIs(t, err, errUpstream)
	_, err = g.restDo(t.Context(), "", observeRESTProvidersPath, nil, 1<<10, nil)
	require.ErrorIs(t, err, errUpstream, "a call without a delegated bearer is refused")
	assert.Zero(t, elsewhere.Load())
}

// Response bodies are bounded before they are decoded, by both the declared
// length and the bytes actually read.
func TestObserveRESTBodiesAreBounded(t *testing.T) {
	oversized := strings.Repeat("x", int(maxResponseBytes)+1)
	for _, tc := range []struct {
		name   string
		header bool
	}{{"declared length", true}, {"streamed without a length", false}} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.header {
					w.Header().Set("Content-Length", strconv.Itoa(len(oversized)))
				}
				_, _ = io.WriteString(w, oversized)
			}))
			defer gateway.Close()
			g := mustObserveGateway(t, gateway.URL)
			_, err := g.restDo(t.Context(), "alice", observeRESTProvidersPath, nil, maxResponseBytes, nil)
			require.ErrorIs(t, err, errUpstream)
		})
	}
}

// Every gateway status maps to the same Insights status and message over REST
// as over MCP's domain codes, so the two data paths answer alike.
func TestObserveRESTStatusMappingMatchesMCPDomainMapping(t *testing.T) {
	// envelope marks the gateway's own temporarily_unavailable JSON body. A 408
	// or 503 without it is a foreign failure and maps to the generic 502.
	const envelope = `{"error":"temporarily_unavailable","error_description":"private credential detail"}`
	for _, tc := range []struct {
		name       string
		status     int
		retryAfter string
		envelope   bool
		want       int
		code       string
	}{
		{"bad request", http.StatusBadRequest, "", false, http.StatusBadRequest, "invalid_argument"},
		{"unauthorized", http.StatusUnauthorized, "", false, http.StatusForbidden, "unauthenticated"},
		{"forbidden", http.StatusForbidden, "", false, http.StatusForbidden, "permission_denied"},
		{"not found", http.StatusNotFound, "", false, http.StatusNotFound, "not_found"},
		{"canceled envelope", http.StatusRequestTimeout, "", true, http.StatusRequestTimeout, "canceled"},
		{"canceled without envelope", http.StatusRequestTimeout, "", false, http.StatusBadGateway, "internal"},
		{"rate limited", http.StatusTooManyRequests, "7", false, http.StatusTooManyRequests, "resource_exhausted"},
		{"not configured envelope", http.StatusServiceUnavailable, "", true, http.StatusServiceUnavailable, "failed_precondition"},
		{"unavailable without envelope", http.StatusServiceUnavailable, "", false, http.StatusBadGateway, "internal"},
		{"gateway timeout", http.StatusGatewayTimeout, "", false, http.StatusGatewayTimeout, "deadline_exceeded"},
		{"internal", http.StatusInternalServerError, "", false, http.StatusBadGateway, "internal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				if tc.envelope {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(tc.status)
					_, _ = io.WriteString(w, envelope)
					return
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, `{"error":"private credential detail"}`)
			}))
			defer gateway.Close()
			g := mustObserveGateway(t, gateway.URL)
			_, err := g.restDo(t.Context(), "alice", observeRESTProvidersPath, nil, 1<<20, nil)
			restStatus, restMessage := providerErrorResponse(err)
			assert.Equal(t, tc.want, restStatus)
			assert.NotContains(t, restMessage, "private")
			// The MCP domain code for the same condition maps to the same status and message.
			mcpStatus, mcpMessage := providerErrorResponse(observeMCPDomainError(tc.code))
			assert.Equal(t, mcpStatus, restStatus, "REST and MCP statuses differ")
			// Generic upstream failures share a status; their wording may differ.
			if tc.want != http.StatusBadGateway {
				assert.Equal(t, mcpMessage, restMessage, "REST and MCP messages differ")
			}
			if tc.retryAfter != "" {
				var remote *observeError
				require.ErrorAs(t, err, &remote)
				assert.Equal(t, 7, remote.retryAfter, "a gateway delay is kept")
			}
		})
	}
}

// A request that never connects is not dispatched; one that reaches the
// gateway is, even if the gateway then fails.
func TestObserveRESTDispatchMarksOnlyConnectedRequests(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "busy"})
	}))
	defer gateway.Close()
	g := mustObserveGateway(t, gateway.URL)
	var m queryMeasurement
	_, err := g.restDo(t.Context(), "alice", observeRESTProvidersPath, nil, 1<<20, &m)
	require.Error(t, err)
	assert.True(t, m.dispatched.Load(), "a connected request is dispatched")

	unreachable := mustObserveGateway(t, "http://127.0.0.1:1")
	var unsent queryMeasurement
	_, err = unreachable.restDo(t.Context(), "alice", observeRESTProvidersPath, nil, 1<<20, &unsent)
	require.Error(t, err)
	assert.False(t, unsent.dispatched.Load(), "a request that never connected is not dispatched")
}

// A gateway delay is forwarded only within the browser's replay cap. A longer one
// is dropped, so the local estimate or the one-second floor answers instead.
func TestObserveForwardedRetryAfterIsCappedAtTheReplayCap(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   int
	}{{"1", 1}, {"10", 10}, {"11", 0}, {"60", 0}, {"0", 0}, {"soon", 0}} {
		t.Run(tc.header, func(t *testing.T) {
			var remote *observeError
			require.ErrorAs(t, observeHTTPErrorFor(http.StatusTooManyRequests, tc.header, ""), &remote)
			assert.Equal(t, tc.want, remote.retryAfter)
		})
	}
}

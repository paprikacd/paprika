package tempo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// requestCapture records what the test server saw from the last request.
type requestCapture struct {
	path     string
	rawQuery string
	escaped  string
	query    url.Values
	auth     string
}

// newTestServer returns an httptest server that records the last request
// and replies with the given status and body.
func newTestServer(t *testing.T, status int, body string) (*httptest.Server, *requestCapture) {
	t.Helper()
	capture := &requestCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.Path
		capture.rawQuery = r.URL.RawQuery
		capture.escaped = r.URL.EscapedPath()
		capture.query = r.URL.Query()
		capture.auth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	return server, capture
}

func endpointConfig(t *testing.T, endpoint string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"endpoint": endpoint})
	require.NoError(t, err)
	return raw
}

func TestFetchByTraceID(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"traceID":"abc123"}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:  connector.SignalTraces,
		TraceID: "abc123",
		Config:  endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"traceID":"abc123"}`, string(res.Data))

	require.Equal(t, "/api/traces/abc123", capture.path)
	// A fetch carries no search parameters at all.
	require.Empty(t, capture.rawQuery)
}

func TestTraceIDIsPathEscaped(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"traceID":"a/b"}`)

	_, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:  connector.SignalTraces,
		TraceID: "a/b",
		Config:  endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, "/api/traces/a%2Fb", capture.escaped)
}

func TestSearch(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"traces":[]}`)
	config := endpointConfig(t, server.URL)

	start := time.Unix(1_700_000_000, 0)
	end := start.Add(10 * time.Minute)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalTraces,
		Query:  `{.service.name="api"}`,
		Range:  connector.TimeRange{Start: start, End: end},
		Config: config,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	require.Equal(t, "/api/search", capture.path)
	require.Equal(t, `{.service.name="api"}`, capture.query.Get("q"))
	require.Equal(t, strconv.FormatInt(start.Unix(), 10), capture.query.Get("start"))
	require.Equal(t, strconv.FormatInt(end.Unix(), 10), capture.query.Get("end"))
	require.Equal(t, "20", capture.query.Get("limit"))

	_, err = New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalTraces,
		Query:  `{.service.name="api"}`,
		Limit:  500,
		Config: config,
	})
	require.NoError(t, err)
	require.Equal(t, "100", capture.query.Get("limit"))
}

func TestNeitherTraceIDNorQuery(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"traces":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalTraces,
		Config: endpointConfig(t, server.URL),
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "a trace ID or search query is required", res.Reason)
}

func TestUnsupportedSignal(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"traces":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  `{.service.name="api"}`,
		Config: endpointConfig(t, server.URL),
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "tempo connector supplies traces only", res.Reason)
}

func TestBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		state  connector.State
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, state: connector.StateForbidden},
		{name: "not found", status: http.StatusNotFound, state: connector.StateNotAvailable},
		{name: "server error", status: http.StatusInternalServerError, state: connector.StateError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, _ := newTestServer(t, tt.status, `{"error":"detail never surfaces"}`)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:  connector.SignalTraces,
				TraceID: "abc123",
				Config:  endpointConfig(t, server.URL),
			})
			require.NoError(t, err)
			require.Equal(t, tt.state, res.State)
			require.NotEmpty(t, res.Reason)
			require.NotContains(t, res.Reason, server.URL)
			require.Nil(t, res.Data)
		})
	}
}

func TestBearerAuth(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"traceID":"abc123"}`)

	_, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalTraces,
		TraceID:     "abc123",
		Config:      endpointConfig(t, server.URL),
		Credentials: []byte("tempo-token"),
	})
	require.NoError(t, err)
	require.Equal(t, "Bearer tempo-token", capture.auth)
}

func TestHeadersSentOnRequest(t *testing.T) {
	t.Parallel()
	got := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("X-Scope-OrgID")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"traces":[]}`)
	}))
	t.Cleanup(server.Close)

	raw, err := json.Marshal(map[string]any{
		"endpoint": server.URL,
		"headers":  map[string]string{"X-Scope-OrgID": "tenant-a"},
	})
	require.NoError(t, err)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:  connector.SignalTraces,
		TraceID: "abc123",
		Config:  raw,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	select {
	case org := <-got:
		require.Equal(t, "tenant-a", org)
	case <-time.After(5 * time.Second):
		t.Fatal("test server saw no request")
	}
}

func TestStepRejectedAsUnknownKey(t *testing.T) {
	t.Parallel()
	err := New().ValidateConfig(json.RawMessage(`{"endpoint":"https://tempo.example.com","step":"15s"}`))
	require.ErrorContains(t, err, `unknown key "step"`)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://tempo.example.com"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://tempo.example.com","headers":{"X-Scope-OrgID":"tenant-a"},"insecureSkipTLS":false}`)))

	err := New().ValidateConfig(json.RawMessage(`{}`))
	require.ErrorIs(t, err, connector.ErrNotConfigured)

	err = New().ValidateConfig(json.RawMessage(`{"endpont":"https://tempo.example.com"}`))
	require.ErrorContains(t, err, `unknown key "endpont"`)
}

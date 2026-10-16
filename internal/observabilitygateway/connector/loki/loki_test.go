package loki

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
	path  string
	query url.Values
	auth  string
}

// newTestServer returns an httptest server that records the last request
// and replies with the given status and body.
func newTestServer(t *testing.T, status int, body string) (*httptest.Server, *requestCapture) {
	t.Helper()
	capture := &requestCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.Path
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

func TestQueryLogsRange(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"status":"success","data":{"result":[]}}`)

	start := time.Unix(1_700_000_000, 0)
	end := start.Add(time.Hour)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs,
		Query:  `{app="api"}`,
		Range:  connector.TimeRange{Start: start, End: end},
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":{"result":[]}}`, string(res.Data))

	require.Equal(t, "/loki/api/v1/query_range", capture.path)
	require.Equal(t, `{app="api"}`, capture.query.Get("query"))
	require.Equal(t, strconv.FormatInt(start.UnixNano(), 10), capture.query.Get("start"))
	require.Equal(t, strconv.FormatInt(end.UnixNano(), 10), capture.query.Get("end"))
	require.Equal(t, "backward", capture.query.Get("direction"))
	require.Equal(t, "100", capture.query.Get("limit"))
}

func TestLimitClamping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		limit int
		want  string
	}{
		{name: "unset falls back to default", limit: 0, want: "100"},
		{name: "negative falls back to default", limit: -5, want: "100"},
		{name: "in range passes through", limit: 42, want: "42"},
		{name: "above maximum clamps", limit: 5000, want: "1000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)

			_, err := New().Query(context.Background(), connector.QueryRequest{
				Signal: connector.SignalLogs,
				Query:  `{app="api"}`,
				Limit:  tt.limit,
				Config: endpointConfig(t, server.URL),
			})
			require.NoError(t, err)
			require.Equal(t, tt.want, capture.query.Get("limit"))
		})
	}
}

func TestUnsupportedSignalAndEmptyQuery(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"data":[]}`)
	config := endpointConfig(t, server.URL)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  `{app="api"}`,
		Config: config,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "loki connector supplies logs only", res.Reason)

	res, err = New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs,
		Config: config,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "a LogQL query expression is required", res.Reason)
}

func TestBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		state  connector.State
	}{
		{name: "forbidden", status: http.StatusForbidden, state: connector.StateForbidden},
		{name: "not found", status: http.StatusNotFound, state: connector.StateNotAvailable},
		{name: "bad gateway", status: http.StatusBadGateway, state: connector.StateError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, _ := newTestServer(t, tt.status, `{"error":"detail never surfaces"}`)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal: connector.SignalLogs,
				Query:  `{app="api"}`,
				Config: endpointConfig(t, server.URL),
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
	server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)

	_, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `{app="api"}`,
		Config:      endpointConfig(t, server.URL),
		Credentials: []byte("loki-token"),
	})
	require.NoError(t, err)
	require.Equal(t, "Bearer loki-token", capture.auth)
}

func TestHeadersSentOnRequest(t *testing.T) {
	t.Parallel()
	got := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("X-Scope-OrgID")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":{"result":[]}}`)
	}))
	t.Cleanup(server.Close)

	raw, err := json.Marshal(map[string]any{
		"endpoint": server.URL,
		"headers":  map[string]string{"X-Scope-OrgID": "tenant-a"},
	})
	require.NoError(t, err)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs,
		Query:  `{app="api"}`,
		Config: raw,
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

func TestInsecureSkipTLS(t *testing.T) {
	t.Parallel()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success","data":{"result":[]}}`)
	}))
	t.Cleanup(server.Close)

	query := connector.QueryRequest{
		Signal: connector.SignalLogs,
		Query:  `{app="api"}`,
	}

	// Default client: the self-signed certificate must fail verification.
	// The transport error converts to a StateError result per the connector
	// error contract.
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: query.Signal,
		Query:  query.Query,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)

	// insecureSkipTLS opts this connector into accepting the self-signed
	// certificate.
	res, err = New().Query(context.Background(), connector.QueryRequest{
		Signal: query.Signal,
		Query:  query.Query,
		Config: insecureConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
}

// insecureConfig builds a config document with insecureSkipTLS set.
func insecureConfig(t *testing.T, endpoint string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"endpoint":        endpoint,
		"insecureSkipTLS": true,
	})
	require.NoError(t, err)
	return raw
}

func TestStepRejectedAsUnknownKey(t *testing.T) {
	t.Parallel()
	err := New().ValidateConfig(json.RawMessage(`{"endpoint":"https://loki.example.com","step":"15s"}`))
	require.ErrorContains(t, err, `unknown key "step"`)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://loki.example.com"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://loki.example.com","headers":{"X-Scope-OrgID":"tenant-a"},"insecureSkipTLS":false}`)))

	err := New().ValidateConfig(json.RawMessage(`{}`))
	require.ErrorIs(t, err, connector.ErrNotConfigured)

	err = New().ValidateConfig(json.RawMessage(`{"endpoit":"https://loki.example.com"}`))
	require.ErrorContains(t, err, `unknown key "endpoit"`)
}

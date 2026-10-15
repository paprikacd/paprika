package otlp

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

func TestSignalPaths(t *testing.T) {
	t.Parallel()

	tests := []struct {
		signal connector.Signal
		path   string
	}{
		{signal: connector.SignalLogs, path: "/v1/logs"},
		{signal: connector.SignalMetrics, path: "/v1/metrics"},
		{signal: connector.SignalTraces, path: "/v1/traces"},
	}
	for _, tt := range tests {
		t.Run(string(tt.signal), func(t *testing.T) {
			t.Parallel()
			server, capture := newTestServer(t, http.StatusOK, `{"resourceSpans":[]}`)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal: tt.signal,
				Config: endpointConfig(t, server.URL),
			})
			require.NoError(t, err)
			require.Equal(t, connector.StateOK, res.State)
			require.Equal(t, tt.path, capture.path)
			// Nothing set: the request carries no query parameters at all.
			require.Empty(t, capture.rawQuery)
		})
	}
}

func TestParamsPassedOnlyWhenSet(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"resourceSpans":[]}`)

	start := time.Unix(1_700_000_000, 0)
	end := start.Add(5 * time.Minute)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:  connector.SignalTraces,
		TraceID: "tid-1",
		Limit:   25,
		Range:   connector.TimeRange{Start: start, End: end},
		Config:  endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	require.Equal(t, "tid-1", capture.query.Get("trace_id"))
	require.Equal(t, "25", capture.query.Get("limit"))
	require.Equal(t, strconv.FormatInt(start.UnixNano(), 10), capture.query.Get("start"))
	require.Equal(t, strconv.FormatInt(end.UnixNano(), 10), capture.query.Get("end"))
}

func TestUnknownSignal(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"resourceSpans":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.Signal("profiles"),
		Config: endpointConfig(t, server.URL),
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "otlp connector does not serve the requested signal", res.Reason)
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
		{name: "server error", status: http.StatusBadGateway, state: connector.StateError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, _ := newTestServer(t, tt.status, `{"error":"detail never surfaces"}`)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal: connector.SignalTraces,
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

func TestHeadersSentOnRequest(t *testing.T) {
	t.Parallel()
	got := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("X-Scope-OrgID")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"resourceSpans":[]}`)
	}))
	t.Cleanup(server.Close)

	raw, err := json.Marshal(map[string]any{
		"endpoint": server.URL,
		"headers":  map[string]string{"X-Scope-OrgID": "tenant-a"},
	})
	require.NoError(t, err)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalTraces,
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

func TestStepRejectedAsUnknownKey(t *testing.T) {
	t.Parallel()
	err := New().ValidateConfig(json.RawMessage(`{"endpoint":"https://collector:4318","step":"15s"}`))
	require.ErrorContains(t, err, `unknown key "step"`)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://collector:4318"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://collector:4318","headers":{"X-Scope-OrgID":"tenant-a"},"insecureSkipTLS":false}`)))

	err := New().ValidateConfig(json.RawMessage(`{}`))
	require.ErrorIs(t, err, connector.ErrNotConfigured)

	err = New().ValidateConfig(json.RawMessage(`{"endpooint":"https://collector:4318"}`))
	require.ErrorContains(t, err, `unknown key "endpooint"`)
}

package prometheus

import (
	"context"
	"encoding/base64"
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

func TestQueryRange(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"status":"success","data":{"result":[]}}`)

	start := time.Unix(1_700_000_000, 0)
	end := start.Add(5000 * time.Second)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Range:  connector.TimeRange{Start: start, End: end},
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":{"result":[]}}`, string(res.Data))

	require.Equal(t, "/api/v1/query_range", capture.path)
	require.Equal(t, "up", capture.query.Get("query"))
	require.Equal(t, strconv.FormatInt(start.Unix(), 10), capture.query.Get("start"))
	require.Equal(t, strconv.FormatInt(end.Unix(), 10), capture.query.Get("end"))
	require.Equal(t, "20s", capture.query.Get("step"))
	require.Equal(t, "100", capture.query.Get("limit"))
}

func TestQueryRangeRejectsExplosiveStepBeforeNetwork(t *testing.T) {
	t.Parallel()
	start := time.Unix(1700000000, 0)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics, Query: "up",
		Range:  connector.TimeRange{Start: start, End: start.Add(time.Hour)},
		Config: stepConfig(t, "http://localhost:1", "1ns"),
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "11000 points")
}

func TestQueryLimitClampsBeforeProviderRequest(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)
	_, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up", Limit: 9000, Config: endpointConfig(t, server.URL)})
	require.NoError(t, err)
	require.Equal(t, "1000", capture.query.Get("limit"))
}

func TestQueryInstant(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"data":"instant"}`)
	config := endpointConfig(t, server.URL)

	// No range at all: instant query with no evaluation time.
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Config: config,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.Equal(t, "/api/v1/query", capture.path)
	require.Equal(t, "up", capture.query.Get("query"))
	require.Empty(t, capture.query.Get("time"))
	require.Empty(t, capture.query.Get("start"))

	// End without Start: instant query evaluated at End.
	end := time.Unix(1_700_000_000, 0)
	_, err = New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Range:  connector.TimeRange{End: end},
		Config: config,
	})
	require.NoError(t, err)
	require.Equal(t, "/api/v1/query", capture.path)
	require.Equal(t, strconv.FormatInt(end.Unix(), 10), capture.query.Get("time"))
}

func TestRangeStepClamping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		span time.Duration
		want string
	}{
		{name: "below minimum", span: 5 * time.Second, want: "10s"},
		{name: "at minimum", span: 2500 * time.Second, want: "10s"},
		{name: "proportional", span: 10000 * time.Second, want: "40s"},
		{name: "at maximum", span: 250 * time.Hour, want: "1h0m0s"},
		{name: "above maximum", span: 500 * time.Hour, want: "1h0m0s"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)
			start := time.Unix(1_700_000_000, 0)

			_, err := New().Query(context.Background(), connector.QueryRequest{
				Signal: connector.SignalMetrics,
				Query:  "up",
				Range:  connector.TimeRange{Start: start, End: start.Add(tt.span)},
				Config: endpointConfig(t, server.URL),
			})
			require.NoError(t, err)
			require.Equal(t, tt.want, capture.query.Get("step"))
		})
	}
}

func TestUnsupportedSignalAndEmptyQuery(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"data":[]}`)
	config := endpointConfig(t, server.URL)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs,
		Query:  "up",
		Config: config,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "prometheus connector supplies metrics only", res.Reason)

	res, err = New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Config: config,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "a PromQL query expression is required", res.Reason)
}

func TestBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		state  connector.State
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, state: connector.StateForbidden},
		{name: "forbidden", status: http.StatusForbidden, state: connector.StateForbidden},
		{name: "not found", status: http.StatusNotFound, state: connector.StateNotAvailable},
		{name: "server error", status: http.StatusInternalServerError, state: connector.StateError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, _ := newTestServer(t, tt.status, `{"error":"detail never surfaces"}`)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal: connector.SignalMetrics,
				Query:  "up",
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

func TestBadConfigIsACallerError(t *testing.T) {
	t.Parallel()
	_, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Config: json.RawMessage(`{}`),
	})
	require.ErrorIs(t, err, connector.ErrNotConfigured)
}

func TestCredentialsSelectAuthHeader(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)
	req := connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Config: endpointConfig(t, server.URL),
	}

	_, err := New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Empty(t, capture.auth)

	req.Credentials = []byte("alice:s3cret")
	_, err = New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, "Basic "+base64.StdEncoding.EncodeToString([]byte("alice:s3cret")), capture.auth)

	req.Credentials = []byte("token-abc")
	_, err = New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, "Bearer token-abc", capture.auth)
}

func TestQueryRangeStepOverride(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)

	// A span whose derived step would be 20s; the override must replace it.
	start := time.Unix(1_700_000_000, 0)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Range:  connector.TimeRange{Start: start, End: start.Add(5000 * time.Second)},
		Config: stepConfig(t, server.URL, "30s"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.Equal(t, "30s", capture.query.Get("step"))
}

func TestQueryRangeStepOverrideNotSentOnInstantQuery(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"data":[]}`)

	end := time.Unix(1_700_000_000, 0)
	_, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
		Range:  connector.TimeRange{End: end},
		Config: stepConfig(t, server.URL, "30s"),
	})
	require.NoError(t, err)
	require.Equal(t, "/api/v1/query", capture.path)
	require.Empty(t, capture.query.Get("step"))
}

func stepConfig(t *testing.T, endpoint, step string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"endpoint": endpoint, "step": step})
	require.NoError(t, err)
	return raw
}

func TestStepValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		step    string
		wantErr string
	}{
		{name: "zero", step: `"0s"`, wantErr: `key "step" must be a Go duration greater than 0 and at most 1h`},
		{name: "negative", step: `"-5s"`, wantErr: `key "step" must be a Go duration greater than 0 and at most 1h`},
		{name: "over an hour", step: `"1h1s"`, wantErr: `key "step" must be a Go duration greater than 0 and at most 1h`},
		{name: "not a duration", step: `"soon"`, wantErr: `key "step" must be a Go duration greater than 0 and at most 1h`},
		{name: "not a string", step: `15`, wantErr: `key "step" must be a string`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := New().ValidateConfig(json.RawMessage(`{"endpoint":"https://prom.example.com","step":` + tt.step + `}`))
			require.ErrorContains(t, err, tt.wantErr)
		})
	}
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://prom.example.com"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://prom.example.com","step":"15s"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"endpoint":"https://prom.example.com","headers":{"X-Scope-OrgID":"tenant-a"},"insecureSkipTLS":false}`)))

	err := New().ValidateConfig(json.RawMessage(`{}`))
	require.ErrorIs(t, err, connector.ErrNotConfigured)

	err = New().ValidateConfig(json.RawMessage(`{"endpont":"https://prom.example.com"}`))
	require.ErrorContains(t, err, `unknown key "endpont"`)
}

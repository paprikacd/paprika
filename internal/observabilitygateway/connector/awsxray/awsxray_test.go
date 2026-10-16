package awsxray

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
)

// testCredentials is the snake_case credential document the connectors
// accept; the SDK signs test requests with it.
var testCredentials = []byte(`{"access_key_id":"AKID","secret_access_key":"SECRET"}`)

// requestCapture records what the test server saw from the last request.
type requestCapture struct {
	path string
	body []byte
}

// newTestServer returns an httptest server that records the last request's
// path and body and replies with the given status and JSON body. X-Ray
// speaks the REST-JSON protocol: the SDK posts to /<Operation-path> with a
// JSON body and signs with the static credentials.
func newTestServer(t *testing.T, status int, body string) (*httptest.Server, *requestCapture) {
	t.Helper()
	capture := &requestCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.Path
		capture.body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	return server, capture
}

// queryConfig builds the provider config document pointing at the test
// server, as the operator would with a VPC endpoint or emulator.
func queryConfig(t *testing.T, endpoint string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"region":   "us-east-1",
		"endpoint": endpoint,
	})
	require.NoError(t, err)
	return raw
}

// summariesRequest is the wire shape of a GetTraceSummaries request body. The
// field names intentionally mirror the SDK's wire names; encoding/json
// matches them case-insensitively.
type summariesRequest struct {
	FilterExpression string
	StartTime        float64
	EndTime          float64
}

// traceSummary is one decoded summary in the connector's result JSON — the
// SDK output struct marshals with Go field names.
type traceSummary struct {
	ID       string
	Duration float64
}

type summariesResult struct {
	TraceSummaries []traceSummary
}

func TestQuerySummariesRoundTrip(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"TraceSummaries":[{"Id":"1-aaa","Duration":0.5},{"Id":"1-bbb","Duration":1.5}]}`)

	start := time.Unix(1_700_000_000, 0).UTC()
	end := start.Add(time.Hour)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalTraces,
		Query:       `service("api")`,
		Range:       connector.TimeRange{Start: start, End: end},
		Limit:       1,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded summariesResult
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	// Limit 1 trims the page client-side — GetTraceSummaries has no
	// page-size parameter.
	require.Len(t, decoded.TraceSummaries, 1)
	require.Equal(t, "1-aaa", decoded.TraceSummaries[0].ID)

	require.Equal(t, "/TraceSummaries", capture.path)
	var sent summariesRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Equal(t, `service("api")`, sent.FilterExpression)
	require.Equal(t, float64(start.Unix()), sent.StartTime)
	require.Equal(t, float64(end.Unix()), sent.EndTime)
}

func TestQueryProbe(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"TraceSummaries":[{"Id":"1-aaa","Duration":0.5},{"Id":"1-bbb","Duration":1.5}]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalTraces,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// The probe returns at most one trace from the short window.
	var decoded summariesResult
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Len(t, decoded.TraceSummaries, 1)

	require.Equal(t, "/TraceSummaries", capture.path)
	var sent summariesRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Empty(t, sent.FilterExpression)
	require.GreaterOrEqual(t, sent.EndTime-sent.StartTime, 9*60.0)
	require.LessOrEqual(t, sent.EndTime-sent.StartTime, 10*60.0+30)
}

func TestQueryBatchGetTracesByID(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"Traces":[{"Id":"1-aaa","Segments":[{"Id":"seg","Document":"{}"}]}],"UnprocessedTraceIds":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalTraces,
		TraceID:     "1-aaa",
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded struct {
		Traces []struct {
			ID       string
			Segments []struct {
				ID       string
				Document string
			}
		}
	}
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Len(t, decoded.Traces, 1)
	require.Equal(t, "1-aaa", decoded.Traces[0].ID)
	require.Len(t, decoded.Traces[0].Segments, 1)
	require.Equal(t, "{}", decoded.Traces[0].Segments[0].Document)

	require.Equal(t, "/Traces", capture.path)
	var sent struct {
		TraceIDs []string
	}
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Equal(t, []string{"1-aaa"}, sent.TraceIDs)
}

func TestLimitClamping(t *testing.T) {
	t.Parallel()

	// Two canned summaries: the clamp decides whether the second survives.
	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{name: "unset falls back to default", limit: 0, want: 2},
		{name: "in range passes through", limit: 2, want: 2},
		{name: "above maximum clamps", limit: 500, want: 2},
		{name: "one trims the page", limit: 1, want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, _ := newTestServer(t, http.StatusOK,
				`{"TraceSummaries":[{"Id":"1-aaa"},{"Id":"1-bbb"}]}`)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:      connector.SignalTraces,
				Query:       `service("api")`,
				Limit:       tt.limit,
				Config:      queryConfig(t, server.URL),
				Credentials: testCredentials,
			})
			require.NoError(t, err)
			require.Equal(t, connector.StateOK, res.State)

			var decoded summariesResult
			require.NoError(t, json.Unmarshal(res.Data, &decoded))
			require.Len(t, decoded.TraceSummaries, tt.want)
		})
	}
}

func TestQueryForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden, `{"__type":"AccessDenied","message":"denied detail"}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalTraces,
		Query:       `service("api")`,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.Equal(t, awscommon.ReasonFor(connector.StateForbidden), res.Reason)
	require.Nil(t, res.Data)
}

func TestUnsupportedSignal(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"TraceSummaries":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `service("api")`,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "aws-xray connector supplies traces only", res.Reason)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1","endpoint":"https://xray.example.com","insecureSkipTLS":false}`)))

	tests := []struct {
		name    string
		config  string
		wantErr string
	}{
		{name: "empty document", config: ``, wantErr: connector.ErrNotConfigured.Error()},
		{name: "missing region", config: `{"endpoint":"https://xray.example.com"}`, wantErr: `config key "region" is required`},
		{name: "unknown key", config: `{"region":"us-east-1","group":"g"}`, wantErr: `unknown key "group"`},
		{name: "endpoint not absolute http", config: `{"region":"us-east-1","endpoint":"xray.example.com"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
		{name: "invalid JSON", config: `{"region":`, wantErr: "invalid JSON document"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := New().ValidateConfig(json.RawMessage(tt.config))
			require.ErrorContains(t, err, tt.wantErr)
		})
	}
}

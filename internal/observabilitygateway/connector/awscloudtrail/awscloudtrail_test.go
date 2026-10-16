package awscloudtrail

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
	target string
	body   []byte
}

// newTestServer returns an httptest server that records the last request's
// X-Amz-Target header and body and replies with the given status and body.
// CloudTrail speaks the AWS JSON protocol: the SDK posts to / with the
// operation in the X-Amz-Target header and signs with the static credentials.
func newTestServer(t *testing.T, status int, body string) (*httptest.Server, *requestCapture) {
	t.Helper()
	capture := &requestCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.target = r.Header.Get("X-Amz-Target")
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

// lookupRequest is the wire shape of a LookupEvents request body. The field
// names intentionally mirror the SDK's wire names; encoding/json matches
// them case-insensitively.
type lookupRequest struct {
	LookupAttributes []struct {
		AttributeKey   string
		AttributeValue string
	}
	MaxResults int64
	StartTime  float64
	EndTime    float64
}

// lookupResponse is the shape the connector returns: the SDK output struct
// marshaled to JSON, which carries Go field names.
type lookupResponse struct {
	Events []struct {
		EventID     string
		EventName   string
		EventSource string
	}
}

func TestQueryLookupRoundTrip(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"Events":[{"EventId":"e-1","EventName":"RunInstances","EventSource":"ec2.amazonaws.com"}]}`)

	start := time.Unix(1_700_000_000, 0).UTC()
	end := start.Add(time.Hour)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       "EventName=RunInstances,EventSource=ec2.amazonaws.com",
		Range:       connector.TimeRange{Start: start, End: end},
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded lookupResponse
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Len(t, decoded.Events, 1)
	require.Equal(t, "e-1", decoded.Events[0].EventID)
	require.Equal(t, "RunInstances", decoded.Events[0].EventName)
	require.Equal(t, "ec2.amazonaws.com", decoded.Events[0].EventSource)

	require.Equal(t, "CloudTrail_20131101.LookupEvents", capture.target)
	var sent lookupRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Len(t, sent.LookupAttributes, 2)
	require.Equal(t, "EventName", sent.LookupAttributes[0].AttributeKey)
	require.Equal(t, "RunInstances", sent.LookupAttributes[0].AttributeValue)
	require.Equal(t, "EventSource", sent.LookupAttributes[1].AttributeKey)
	require.Equal(t, "ec2.amazonaws.com", sent.LookupAttributes[1].AttributeValue)
	require.Equal(t, int64(25), sent.MaxResults)
	require.Equal(t, float64(start.Unix()), sent.StartTime)
	require.Equal(t, float64(end.Unix()), sent.EndTime)
}

func TestQueryEventCategoryPairPasses(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"Events":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       "EventCategory=Insight",
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var sent lookupRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Len(t, sent.LookupAttributes, 1)
	require.Equal(t, "EventCategory", sent.LookupAttributes[0].AttributeKey)
	require.Equal(t, "Insight", sent.LookupAttributes[0].AttributeValue)
}

func TestQueryProbe(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"Events":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	require.Equal(t, "CloudTrail_20131101.LookupEvents", capture.target)
	var sent lookupRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Equal(t, int64(1), sent.MaxResults)
	require.Empty(t, sent.LookupAttributes)
	// LookupEvents scopes to the trailing hour server-side when no range is
	// passed, so the probe sends no bounds.
	require.Zero(t, sent.StartTime)
	require.Zero(t, sent.EndTime)
}

func TestLimitClamping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		limit int
		want  int64
	}{
		{name: "unset falls back to default", limit: 0, want: 25},
		{name: "negative falls back to default", limit: -5, want: 25},
		{name: "in range passes through", limit: 42, want: 42},
		{name: "above maximum clamps", limit: 5000, want: 50},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, capture := newTestServer(t, http.StatusOK, `{"Events":[]}`)

			_, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:      connector.SignalLogs,
				Query:       "EventName=RunInstances",
				Limit:       tt.limit,
				Config:      queryConfig(t, server.URL),
				Credentials: testCredentials,
			})
			require.NoError(t, err)

			var sent lookupRequest
			require.NoError(t, json.Unmarshal(capture.body, &sent))
			require.Equal(t, tt.want, sent.MaxResults)
		})
	}
}

func TestQueryForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden, `{"__type":"AccessDenied","message":"denied detail"}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       "EventName=RunInstances",
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.Equal(t, awscommon.ReasonFor(connector.StateForbidden), res.Reason)
	require.Nil(t, res.Data)
}

func TestInvalidLookupQueriesAreCallerBugs(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"Events":[]}`)
	config := queryConfig(t, server.URL)

	tests := []struct {
		name   string
		query  string
		reason string
	}{
		{name: "pair without equals", query: "EventName", reason: "aws-cloudtrail queries must be comma-separated Key=Value lookup pairs, got \"EventName\""},
		{name: "empty key", query: "=RunInstances", reason: `aws-cloudtrail queries must be comma-separated Key=Value lookup pairs, got "=RunInstances"`},
		{name: "empty value", query: "EventName=", reason: `aws-cloudtrail queries must be comma-separated Key=Value lookup pairs, got "EventName="`},
		{name: "unknown key", query: "Bogus=1", reason: `aws-cloudtrail connector does not support lookup attribute key "Bogus"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:      connector.SignalLogs,
				Query:       tt.query,
				Config:      config,
				Credentials: testCredentials,
			})
			require.ErrorIs(t, err, connector.ErrUnsupported)
			require.Equal(t, connector.StateNotAvailable, res.State)
			require.Equal(t, tt.reason, res.Reason)
		})
	}
}

func TestUnsupportedSignal(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"Events":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       "EventName=RunInstances",
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "aws-cloudtrail connector supplies logs only", res.Reason)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1","endpoint":"https://cloudtrail.example.com","insecureSkipTLS":false}`)))

	tests := []struct {
		name    string
		config  string
		wantErr string
	}{
		{name: "empty document", config: ``, wantErr: connector.ErrNotConfigured.Error()},
		{name: "missing region", config: `{}`, wantErr: `config key "region" is required`},
		{name: "unknown key", config: `{"region":"us-east-1","trail":"t"}`, wantErr: `unknown key "trail"`},
		{name: "endpoint not absolute http", config: `{"region":"us-east-1","endpoint":"cloudtrail.example.com"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
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

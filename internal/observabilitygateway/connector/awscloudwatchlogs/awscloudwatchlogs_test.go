package awscloudwatchlogs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
// CloudWatch Logs speaks the AWS JSON protocol: the SDK posts to / with the
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
func queryConfig(t *testing.T, endpoint, logGroup string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"region":   "us-east-1",
		"endpoint": endpoint,
		"logGroup": logGroup,
	})
	require.NoError(t, err)
	return raw
}

// filterRequest is the wire shape of a FilterLogEvents request body. The
// field names intentionally mirror the SDK's wire names; encoding/json
// matches them case-insensitively.
type filterRequest struct {
	LogGroupName  string
	FilterPattern string
	Limit         int32
	StartTime     int64
	EndTime       int64
}

// filterResponse is the shape the connector returns: the SDK output struct
// marshaled to JSON, which carries Go field names.
type filterResponse struct {
	Events []struct {
		EventID       string
		LogStreamName string
		Message       string
		Timestamp     int64
	}
}

func TestQueryFilterRoundTrip(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"events":[{"logStreamName":"stream-1","timestamp":1700000000000,"message":"hello from cw","eventId":"e-1"}]}`)

	start := time.Unix(1_700_000_000, 0)
	end := start.Add(time.Hour)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `"error"`,
		Range:       connector.TimeRange{Start: start, End: end},
		Limit:       42,
		Config:      queryConfig(t, server.URL, "/aws/eks/prod"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded filterResponse
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Len(t, decoded.Events, 1)
	require.Equal(t, "e-1", decoded.Events[0].EventID)
	require.Equal(t, "stream-1", decoded.Events[0].LogStreamName)
	require.Equal(t, "hello from cw", decoded.Events[0].Message)
	require.Equal(t, start.UnixMilli(), decoded.Events[0].Timestamp)

	require.Equal(t, "Logs_20140328.FilterLogEvents", capture.target)
	var sent filterRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Equal(t, "/aws/eks/prod", sent.LogGroupName)
	require.Equal(t, `"error"`, sent.FilterPattern)
	require.Equal(t, int32(42), sent.Limit)
	require.Equal(t, start.UnixMilli(), sent.StartTime)
	require.Equal(t, end.UnixMilli(), sent.EndTime)
}

func TestQueryProbe(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, `{"events":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Config:      queryConfig(t, server.URL, "/aws/eks/prod"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var sent filterRequest
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Equal(t, "/aws/eks/prod", sent.LogGroupName)
	require.Equal(t, int32(1), sent.Limit)
	require.Empty(t, sent.FilterPattern)
	require.Zero(t, sent.StartTime)
	require.Zero(t, sent.EndTime)
}

func TestLimitClamping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		limit int
		want  int32
	}{
		{name: "unset falls back to default", limit: 0, want: 100},
		{name: "negative falls back to default", limit: -5, want: 100},
		{name: "in range passes through", limit: 42, want: 42},
		{name: "above maximum clamps", limit: 5000, want: 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, capture := newTestServer(t, http.StatusOK, `{"events":[]}`)

			_, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:      connector.SignalLogs,
				Query:       `"error"`,
				Limit:       tt.limit,
				Config:      queryConfig(t, server.URL, "/aws/eks/prod"),
				Credentials: testCredentials,
			})
			require.NoError(t, err)

			var sent filterRequest
			require.NoError(t, json.Unmarshal(capture.body, &sent))
			require.Equal(t, tt.want, sent.Limit)
		})
	}
}

func TestQueryForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden, `{"__type":"AccessDenied","message":"denied detail"}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `"error"`,
		Config:      queryConfig(t, server.URL, "/aws/eks/prod"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.Equal(t, awscommon.ReasonFor(connector.StateForbidden), res.Reason)
	require.Nil(t, res.Data)
}

func TestBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		body   string
		state  connector.State
	}{
		{name: "throttle is error", status: http.StatusBadRequest, body: `{"__type":"ThrottlingException"}`, state: connector.StateError},
		{name: "missing group is error", status: http.StatusBadRequest, body: `{"__type":"ResourceNotFoundException"}`, state: connector.StateError},
		{name: "bad gateway is error", status: http.StatusBadGateway, body: `{"__type":"InternalError"}`, state: connector.StateError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, _ := newTestServer(t, tt.status, tt.body)

			res, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:      connector.SignalLogs,
				Query:       `"error"`,
				Config:      queryConfig(t, server.URL, "/aws/eks/prod"),
				Credentials: testCredentials,
			})
			require.NoError(t, err)
			require.Equal(t, tt.state, res.State)
			require.Equal(t, awscommon.ReasonFor(tt.state), res.Reason)
			require.Nil(t, res.Data)
		})
	}
}

func TestUnsupportedQueryShapes(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"events":[]}`)
	config := queryConfig(t, server.URL, "/aws/eks/prod")

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       `"error"`,
		Config:      config,
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "aws-cloudwatch-logs connector supplies logs only", res.Reason)

	res, err = New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		TraceID:     "1-abcdef",
		Config:      config,
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "aws-cloudwatch-logs connector does not fetch traces by ID", res.Reason)
}

func TestMalformedCredentialsAreCallerBugs(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"events":[]}`)
	config := queryConfig(t, server.URL, "/aws/eks/prod")

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `"error"`,
		Config:      config,
		Credentials: []byte("{"),
	})
	require.Error(t, err)
	require.Nil(t, res)
	require.Contains(t, err.Error(), "credential document is not valid JSON")

	res, err = New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `"error"`,
		Config:      config,
		Credentials: []byte(`{"access_key_id":"AKID"}`),
	})
	require.Error(t, err)
	require.Nil(t, res)
	require.Contains(t, err.Error(), "access_key_id and secret_access_key")
}

func TestQueryAmbientCredentialsStateError(t *testing.T) {
	// Not parallel: mutates the process AWS environment so the SDK's
	// credential chain fails deterministically regardless of the developer's
	// ~/.aws setup.
	disableAWSEnv(t)
	server, _ := newTestServer(t, http.StatusOK, `{"events":[]}`)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs,
		Query:  `"error"`,
		Config: queryConfig(t, server.URL, "/aws/eks/prod"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)
	require.NotEqual(t, connector.StateForbidden, res.State)
	require.Equal(t, awscommon.ReasonFor(connector.StateError), res.Reason)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1","logGroup":"/aws/eks/prod"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1","endpoint":"https://logs.example.com","insecureSkipTLS":false,"logGroup":"g"}`)))

	tests := []struct {
		name    string
		config  string
		wantErr string
	}{
		{name: "empty document", config: ``, wantErr: connector.ErrNotConfigured.Error()},
		{name: "missing region", config: `{"logGroup":"g"}`, wantErr: `config key "region" is required`},
		{name: "blank region", config: `{"region":"  ","logGroup":"g"}`, wantErr: `config key "region" must be a non-empty region`},
		{name: "region not a string", config: `{"region":42,"logGroup":"g"}`, wantErr: `key "region" must be a string`},
		{name: "missing logGroup", config: `{"region":"us-east-1"}`, wantErr: `config key "logGroup" is required`},
		{name: "logGroup not a string", config: `{"region":"us-east-1","logGroup":42}`, wantErr: `key "logGroup" must be a string`},
		{name: "unknown key", config: `{"region":"us-east-1","logGroup":"g","query":"x"}`, wantErr: `unknown key "query"`},
		{name: "endpoint not absolute http", config: `{"region":"us-east-1","endpoint":"logs.example.com","logGroup":"g"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
		{name: "insecureSkipTLS not a bool", config: `{"region":"us-east-1","insecureSkipTLS":"yes","logGroup":"g"}`, wantErr: `key "insecureSkipTLS" must be a bool`},
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

// disableAWSEnv points the SDK credential chain at nothing: no environment
// keys, no shared config files, and the metadata server disabled, so ambient
// credential resolution fails with a deterministic error.
func disableAWSEnv(t *testing.T) {
	t.Helper()
	emptyDir := t.TempDir()
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", filepath.Join(emptyDir, "credentials"))
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(emptyDir, "config"))
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
}

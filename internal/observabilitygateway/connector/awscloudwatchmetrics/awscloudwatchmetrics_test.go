package awscloudwatchmetrics

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
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
// path and body and replies with the given status and CBOR body. CloudWatch
// speaks the rpc-v2-cbor protocol: the SDK posts to
// /service/GraniteServiceVersion20100801/operation/<Operation> with a CBOR
// body and signs with the static credentials.
func newTestServer(t *testing.T, status int, body []byte) (*httptest.Server, *requestCapture) {
	t.Helper()
	capture := &requestCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.Path
		capture.body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/cbor")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server, capture
}

// queryConfig builds the provider config document pointing at the test
// server, as the operator would with a VPC endpoint or emulator.
func queryConfig(t *testing.T, endpoint, namespace string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"region":    "us-east-1",
		"endpoint":  endpoint,
		"namespace": namespace,
	})
	require.NoError(t, err)
	return raw
}

// --- canned CBOR bodies -----------------------------------------------------

// The pinned SDK's CloudWatch client speaks rpc-v2-cbor, so canned responses
// must be CBOR. The payloads are fixed and small; the handful of
// definite-length primitives they need are assembled here rather than pulling
// a CBOR dependency into the module (RFC 8949).

// cborText encodes a text string of length < 24.
func cborText(s string) []byte {
	if len(s) >= 24 {
		panic("cborText: test helper only encodes strings shorter than 24 bytes")
	}
	return append([]byte{0x60 | byte(len(s))}, s...) //nolint:gosec // G115: len(s) is guarded above to be < 24.
}

// cborFloat64 encodes a float64 (major type 7, 64-bit argument).
func cborFloat64(f float64) []byte {
	var encoded [9]byte
	encoded[0] = 0xFB
	binary.BigEndian.PutUint64(encoded[1:], math.Float64bits(f))
	return encoded[:]
}

// statsBody is {"Label":"CPUUtilization","Datapoints":[{"Average":42.5,"Maximum":50,"Sum":100}]}.
var statsBody = bytes.Join([][]byte{
	{0xA2}, // map(2)
	cborText("Label"), cborText("CPUUtilization"),
	cborText("Datapoints"),
	{0x81}, // array(1)
	{0xA3}, // map(3)
	cborText("Average"), cborFloat64(42.5),
	cborText("Maximum"), cborFloat64(50),
	cborText("Sum"), cborFloat64(100),
}, nil)

// metricsBody is {"Metrics":[{"Namespace":"AWS/ECS","MetricName":"CPUUtilization"}]}.
var metricsBody = bytes.Join([][]byte{
	{0xA1}, // map(1)
	cborText("Metrics"),
	{0x81}, // array(1)
	{0xA2}, // map(2)
	cborText("Namespace"), cborText("AWS/ECS"),
	cborText("MetricName"), cborText("CPUUtilization"),
}, nil)

// accessDeniedBody is {"__type":"AccessDenied","message":"denied"}, the error
// shape the rpc-v2-cbor protocol parses for error codes.
var accessDeniedBody = bytes.Join([][]byte{
	{0xA2}, // map(2)
	cborText("__type"), cborText("AccessDenied"),
	cborText("message"), cborText("denied"),
}, nil)

// cborNumberAfter locates the definite-length text key in an encoded CBOR
// map and decodes the number that follows it — skipping one timestamp tag
// byte (0xC1) when present. The SDK encodes timestamps as tag-1 float64
// epochs and the small uints the tests read as one- or two-byte forms.
func cborNumberAfter(t *testing.T, body []byte, key string) int64 {
	t.Helper()
	idx := bytes.Index(body, cborText(key))
	require.NotEqual(t, -1, idx, "key %q not found in request body %x", key, body)
	rest := body[idx+len(key)+1:]
	if rest[0] == 0xC1 {
		rest = rest[1:]
	}
	switch {
	case rest[0] < 0x18:
		return int64(rest[0])
	case rest[0] == 0x18:
		return int64(rest[1])
	case rest[0] == 0x19:
		return int64(binary.BigEndian.Uint16(rest[1:3]))
	case rest[0] == 0xFB:
		return int64(math.Float64frombits(binary.BigEndian.Uint64(rest[1:9])))
	default:
		t.Fatalf("test helper cannot decode numeric form 0x%x after key %q", rest[0], key)
		return 0
	}
}

// --- tests ------------------------------------------------------------------

const (
	statsPath = "/service/GraniteServiceVersion20100801/operation/GetMetricStatistics"
	listPath  = "/service/GraniteServiceVersion20100801/operation/ListMetrics"
)

func TestQueryStatisticsRoundTrip(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, statsBody)

	start := time.Unix(1_700_000_000, 0).UTC()
	end := start.Add(10 * time.Hour)
	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       "CPUUtilization",
		Range:       connector.TimeRange{Start: start, End: end},
		Config:      queryConfig(t, server.URL, "AWS/ECS"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded struct {
		Label      string
		Datapoints []struct {
			Average *float64
			Maximum *float64
			Sum     *float64
		}
	}
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "CPUUtilization", decoded.Label)
	require.Len(t, decoded.Datapoints, 1)
	require.Equal(t, 42.5, *decoded.Datapoints[0].Average)
	require.Equal(t, 50.0, *decoded.Datapoints[0].Maximum)
	require.Equal(t, 100.0, *decoded.Datapoints[0].Sum)

	require.Equal(t, statsPath, capture.path)
	require.Equal(t, int64(360), cborNumberAfter(t, capture.body, "Period"))
}

func TestQueryProbe(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, metricsBody)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Config:      queryConfig(t, server.URL, "AWS/ECS"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded struct {
		Metrics []struct {
			Namespace  string
			MetricName string
		}
	}
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Len(t, decoded.Metrics, 1)
	require.Equal(t, "AWS/ECS", decoded.Metrics[0].Namespace)
	require.Equal(t, "CPUUtilization", decoded.Metrics[0].MetricName)

	require.Equal(t, listPath, capture.path)
}

func TestPeriodClamping(t *testing.T) {
	t.Parallel()

	hour := time.Hour
	tests := []struct {
		name string
		span time.Duration
		want int64
	}{
		{name: "short window clamps to minimum", span: hour, want: 60},
		{name: "mid window derives", span: 10 * hour, want: 360},
		{name: "long window clamps to maximum", span: 1000 * hour, want: 3600},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server, capture := newTestServer(t, http.StatusOK, statsBody)

			end := time.Unix(1_700_000_000, 0).UTC()
			_, err := New().Query(context.Background(), connector.QueryRequest{
				Signal:      connector.SignalMetrics,
				Query:       "CPUUtilization",
				Range:       connector.TimeRange{Start: end.Add(-tt.span), End: end},
				Config:      queryConfig(t, server.URL, "AWS/ECS"),
				Credentials: testCredentials,
			})
			require.NoError(t, err)
			require.Equal(t, tt.want, cborNumberAfter(t, capture.body, "Period"))
		})
	}
}

func TestQueryWithoutRangeDefaultsWindowAndPeriod(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK, statsBody)

	_, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       "CPUUtilization",
		Config:      queryConfig(t, server.URL, "AWS/ECS"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)

	// GetMetricStatistics requires both bounds: the connector substitutes the
	// trailing hour and the default period.
	require.Equal(t, int64(300), cborNumberAfter(t, capture.body, "Period"))
	now := time.Now()
	start := time.Unix(cborNumberAfter(t, capture.body, "StartTime"), 0)
	require.GreaterOrEqual(t, now.Sub(start), 55*time.Minute)
}

func TestQueryForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden, accessDeniedBody)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalMetrics,
		Query:       "CPUUtilization",
		Config:      queryConfig(t, server.URL, "AWS/ECS"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.Equal(t, awscommon.ReasonFor(connector.StateForbidden), res.Reason)
	require.Nil(t, res.Data)
}

func TestUnsupportedSignal(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, statsBody)

	res, err := New().Query(context.Background(), connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       "CPUUtilization",
		Config:      queryConfig(t, server.URL, "AWS/ECS"),
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "aws-cloudwatch-metrics connector supplies metrics only", res.Reason)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1","namespace":"AWS/ECS"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"region":"us-east-1","endpoint":"https://monitoring.example.com","insecureSkipTLS":false,"namespace":"AWS/ECS"}`)))

	tests := []struct {
		name    string
		config  string
		wantErr string
	}{
		{name: "empty document", config: ``, wantErr: connector.ErrNotConfigured.Error()},
		{name: "missing region", config: `{"namespace":"AWS/ECS"}`, wantErr: `config key "region" is required`},
		{name: "missing namespace", config: `{"region":"us-east-1"}`, wantErr: `config key "namespace" is required`},
		{name: "namespace not a string", config: `{"region":"us-east-1","namespace":42}`, wantErr: `key "namespace" must be a string`},
		{name: "unknown key", config: `{"region":"us-east-1","namespace":"AWS/ECS","metric":"x"}`, wantErr: `unknown key "metric"`},
		{name: "endpoint not absolute http", config: `{"region":"us-east-1","endpoint":"monitoring.example.com","namespace":"AWS/ECS"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
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

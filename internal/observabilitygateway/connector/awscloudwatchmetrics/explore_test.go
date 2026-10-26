package awscloudwatchmetrics

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// cannedMetric is one metric a canned ListMetrics response carries, with its
// dimensions, for the union tests below.
type cannedMetric struct {
	namespace  string
	name       string
	dimensions [][2]string
}

// cborListMetricsBody encodes {"Metrics":[...]} in definite-length CBOR,
// extending the package's hand-rolled CBOR helpers with the dimension maps
// exploration unions over.
func cborListMetricsBody(t *testing.T, metrics ...cannedMetric) []byte {
	t.Helper()
	body := []byte{0xA1} // map(1)
	body = append(body, cborText("Metrics")...)
	if len(metrics) < 24 {
		body = append(body, 0x80|byte(len(metrics))) //nolint:gosec // G115: len is guarded.
	} else {
		t.Fatalf("test helper encodes at most 23 metrics")
	}
	for _, metric := range metrics {
		if len(metric.dimensions) > 0 {
			body = append(body, 0xA3) // map(3): Namespace, MetricName, Dimensions
		} else {
			body = append(body, 0xA2) // map(2): Namespace, MetricName
		}
		body = append(body, cborText("Namespace")...)
		body = append(body, cborText(metric.namespace)...)
		body = append(body, cborText("MetricName")...)
		body = append(body, cborText(metric.name)...)
		if len(metric.dimensions) == 0 {
			continue
		}
		body = append(body, cborText("Dimensions")...)
		body = append(body, 0x80|byte(len(metric.dimensions))) //nolint:gosec // G115: test data stays small.
		for _, dimension := range metric.dimensions {
			body = append(body, 0xA2) // map(2)
			body = append(body, cborText("Name")...)
			body = append(body, cborText(dimension[0])...)
			body = append(body, cborText("Value")...)
			body = append(body, cborText(dimension[1])...)
		}
	}
	return body
}

// envelopeData decodes the {"status":"success","data":[...]} envelope the
// exploration kinds answer in.
type envelopeData struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

func exploreRequest(cfg json.RawMessage, kind connector.ExploreKind, mutate func(*connector.ExploreRequest)) connector.ExploreRequest {
	req := connector.ExploreRequest{
		Kind:        kind,
		Config:      cfg,
		Credentials: testCredentials,
	}
	if mutate != nil {
		mutate(&req)
	}
	return req
}

func TestExploreMetricNamesNamespaceParam(t *testing.T) {
	t.Parallel()
	body := cborListMetricsBody(t,
		cannedMetric{namespace: "AWS/ParamNS", name: "CPUUtilization"},
		cannedMetric{namespace: "AWS/Other", name: "NetworkIn"},
		cannedMetric{namespace: "AWS/ParamNS", name: "CPUUtilization"},
	)
	server, capture := newTestServer(t, http.StatusOK, body)

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ConfigNS"), connector.ExploreMetricNames,
		func(req *connector.ExploreRequest) { req.Params = map[string]string{"namespace": "AWS/ParamNS"} }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// The union is sorted and deduplicated across namespaces and duplicates.
	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "success", decoded.Status)
	require.Equal(t, []string{"CPUUtilization", "NetworkIn"}, decoded.Data)

	require.Equal(t, listPath, capture.path)
	// The Params namespace reaches the wire; the configured namespace does not.
	require.True(t, bytes.Contains(capture.body, cborText("AWS/ParamNS")))
	require.False(t, bytes.Contains(capture.body, cborText("AWS/ConfigNS")))
}

func TestExploreMetricNamesWithoutNamespaceParam(t *testing.T) {
	t.Parallel()
	body := cborListMetricsBody(t,
		cannedMetric{namespace: "AWS/ECS", name: "CPUUtilization"},
	)
	server, capture := newTestServer(t, http.StatusOK, body)

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ConfigNS"), connector.ExploreMetricNames, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// Without the param the enumeration is unscoped: no Namespace key is
	// sent, so every namespace the credential can see is explored.
	require.False(t, bytes.Contains(capture.body, cborText("Namespace")))
}

func TestExploreMetricNamesPrefixAndLimit(t *testing.T) {
	t.Parallel()
	body := cborListMetricsBody(t,
		cannedMetric{namespace: "AWS/ECS", name: "CPUUtilization"},
		cannedMetric{namespace: "AWS/ECS", name: "DiskReadOps"},
		cannedMetric{namespace: "AWS/ECS", name: "DiskWriteOps"},
	)
	server, _ := newTestServer(t, http.StatusOK, body)

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreMetricNames,
		func(req *connector.ExploreRequest) {
			req.Prefix = "Disk"
			req.Limit = 1
		}))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// Prefix filters first, limit then keeps the first match.
	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{"DiskReadOps"}, decoded.Data)
}

func TestExploreLabelNamesUnion(t *testing.T) {
	t.Parallel()
	body := cborListMetricsBody(t,
		cannedMetric{namespace: "AWS/ECS", name: "CPUUtilization", dimensions: [][2]string{{"InstanceId", "i-aaa"}, {"ClusterName", "prod"}}},
		cannedMetric{namespace: "AWS/ECS", name: "DiskReadOps", dimensions: [][2]string{{"InstanceId", "i-bbb"}}},
	)
	server, capture := newTestServer(t, http.StatusOK, body)

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreLabelNames, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{"ClusterName", "InstanceId"}, decoded.Data)

	require.Equal(t, listPath, capture.path)
}

func TestExploreLabelValuesForDimension(t *testing.T) {
	t.Parallel()
	// The canned page carries only the MetricName-filtered metric a real
	// CloudWatch would return for this request; the union sees its two
	// InstanceId values.
	body := cborListMetricsBody(t,
		cannedMetric{namespace: "AWS/ECS", name: "CPUUtilization", dimensions: [][2]string{{"InstanceId", "i-aaa"}, {"ClusterName", "prod"}}},
		cannedMetric{namespace: "AWS/ECS", name: "CPUUtilization", dimensions: [][2]string{{"InstanceId", "i-bbb"}}},
	)
	server, capture := newTestServer(t, http.StatusOK, body)

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreLabelValues,
		func(req *connector.ExploreRequest) {
			req.Label = "InstanceId"
			req.Metric = "CPUUtilization"
		}))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{"i-aaa", "i-bbb"}, decoded.Data)

	// The Metric constraint reaches ListMetrics as MetricName.
	require.True(t, bytes.Contains(capture.body, cborText("MetricName")))
	require.True(t, bytes.Contains(capture.body, cborText("CPUUtilization")))
}

func TestExploreLabelValuesRequiresLabel(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, cborListMetricsBody(t))

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreLabelValues, nil))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "a dimension name is required", res.Reason)
}

func TestExploreUnsupportedKinds(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, cborListMetricsBody(t))

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreMetricMetadata, nil))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "no metric metadata api")

	res, err = CloudWatchMetrics{}.Explore(context.Background(), connector.ExploreRequest{Kind: connector.ExploreMetricSeries})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "does not enumerate metric series")

	res, err = CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreKind("bogus"), nil))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden, accessDeniedBody)

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreMetricNames, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotEmpty(t, res.Reason)
	require.Nil(t, res.Data)
}

func TestExploreInvalidConfigIsCallerBug(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, cborListMetricsBody(t))

	res, err := CloudWatchMetrics{}.Explore(context.Background(), exploreRequest(
		queryConfig(t, server.URL, "AWS/ECS"), connector.ExploreMetricNames,
		func(req *connector.ExploreRequest) { req.Config = json.RawMessage(`{"region":"us-east-1"}`) }))
	require.Error(t, err)
	require.Nil(t, res)
	require.ErrorContains(t, err, "aws-cloudwatch-metrics")
	require.ErrorIs(t, err, connector.ErrNotConfigured)
}

package mock

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestExploreMetricNames(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Prefix: "mock_http",
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":[
		"mock_http_requests_total",
		"mock_http_request_duration_seconds_bucket",
		"mock_http_request_duration_seconds_count",
		"mock_http_request_duration_seconds_sum"
	]}`, string(res.Data))
}

func TestExploreMetricNamesLimit(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:  connector.ExploreMetricNames,
		Limit: 2,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":[
		"mock_http_requests_total",
		"mock_http_request_duration_seconds_bucket"
	]}`, string(res.Data))
}

func TestExploreLabelNames(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreLabelNames,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.Contains(t, string(res.Data), `"namespace"`)
}

func TestExploreLabelValuesKnownAndUnknownLabels(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:  connector.ExploreLabelValues,
		Label: "level",
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["debug","error","info","warn"]}`, string(res.Data))

	res, err = Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:  connector.ExploreLabelValues,
		Label: "anything-else",
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["mock-value"]}`, string(res.Data))
}

func TestExploreLabelValuesRequiresLabel(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreLabelValues,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreMetricMetadataClassifiesTypes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		metric string
		typ    string
	}{
		{"mock_http_requests_total", "counter"},
		{"mock_memory_usage_bytes", "gauge"},
		{"mock_http_request_duration_seconds_bucket", "histogram"},
	}
	for _, tc := range cases {
		res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
			Kind:   connector.ExploreMetricMetadata,
			Metric: tc.metric,
		})
		require.NoError(t, err, tc.metric)
		require.Equal(t, connector.StateOK, res.State, tc.metric)
		require.Contains(t, string(res.Data), `"type":"`+tc.typ+`"`, tc.metric)
	}
}

func TestExploreMetricMetadataRequiresMetric(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreMetricMetadata,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreTraceServices(t *testing.T) {
	t.Parallel()

	res, err := Mock{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreTraceServices,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["mock-svc-0","mock-svc-1","mock-svc-2","mock-svc-3"]}`, string(res.Data))
}

package awscloudwatchlogs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// envelopeData decodes the {"status":"success","data":[...]} envelope the
// exploration kinds answer in.
type envelopeData struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

func TestExploreMetricNamesRoundTrip(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"metricFilters":[
			{"filterName":"Errors","filterPattern":"?ERROR","logGroupName":"/aws/eks/prod","metricTransformations":[{"metricName":"ErrorCount","metricNamespace":"App","metricValue":"1"}]},
			{"filterName":"Latency","filterPattern":"?latency","logGroupName":"/aws/eks/prod","metricTransformations":[{"metricName":"LatencyHigh","metricNamespace":"App","metricValue":"1"}]}
		]}`)

	res, err := CloudWatchLogs{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreMetricNames,
		Config:      queryConfig(t, server.URL, "/aws/eks/prod"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "success", decoded.Status)
	require.Equal(t, []string{"Errors", "Latency"}, decoded.Data)

	require.Equal(t, "Logs_20140328.DescribeMetricFilters", capture.target)
	var sent struct {
		LogGroupName string
	}
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	require.Equal(t, "/aws/eks/prod", sent.LogGroupName)
}

func TestExploreUnsupportedKind(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"metricFilters":[]}`)

	res, err := CloudWatchLogs{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreLabelNames,
		Config:      queryConfig(t, server.URL, "/g"),
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden,
		`{"__type":"AccessDeniedException","message":"denied detail"}`)

	res, err := CloudWatchLogs{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreMetricNames,
		Config:      queryConfig(t, server.URL, "/g"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotContains(t, res.Reason, "denied detail")
	require.Nil(t, res.Data)
}

func TestExploreMetricNamesPaginationAcrossPages(t *testing.T) {
	t.Parallel()
	var pages []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pages = append(pages, "call")
		w.Header().Set("Content-Type", "application/json")
		filter := fmt.Sprintf(`{"filterName":"F%d","logGroupName":"/g","metricTransformations":[{"metricName":"M","metricNamespace":"N","metricValue":"1"}]}`, len(pages))
		fmt.Fprintf(w, `{"metricFilters":[%s],"nextToken":"%s"}`, filter, map[bool]string{true: "more", false: ""}[len(pages) < 2])
	}))
	t.Cleanup(server.Close)

	res, err := CloudWatchLogs{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreMetricNames,
		Config:      queryConfig(t, server.URL, "/g"),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{"F1", "F2"}, decoded.Data)
	require.Len(t, pages, 2)
}
